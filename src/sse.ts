import { OoreApiError, toOoreApiError } from './client.js'
import { mergeHeaders } from './generated/client/index.js'
import type {
  Client,
  Config,
  ServerSentEventsResult,
} from './generated/client/index.js'
import type { StreamEvent } from './generated/core/serverSentEvents.gen.js'

/** Options every Oore SSE helper accepts on top of the operation's own. */
export interface OoreSseOptions {
  client: Client
  fetch?: typeof globalThis.fetch
  headers?: Config['headers']
  onSseError?: (error: unknown) => void
  signal?: AbortSignal | null
  /** Default backoff between attempts, in milliseconds. Defaults to 3000. */
  sseDefaultRetryDelay?: number
  /** Attempts before the helper throws the last error. */
  sseMaxRetryAttempts?: number
  /** Upper bound for the exponential backoff, in milliseconds. Defaults to 30000. */
  sseMaxRetryDelay?: number
}

/** What one attempt passes to the generated SSE operation. */
export interface SseAttempt {
  fetch: typeof globalThis.fetch
  headers: Config['headers']
  onSseError: (error: unknown) => void
  onSseEvent: (event: StreamEvent) => void
  signal: AbortSignal
  sseMaxRetryAttempts: 1
}

const abortError = () => new DOMException('The stream was aborted', 'AbortError')

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })

/** 4xx responses other than timeouts and rate limits will not fix themselves. */
const isRetryable = (error: unknown) =>
  !(error instanceof OoreApiError) ||
  error.status >= 500 ||
  error.status === 408 ||
  error.status === 429

/**
 * Turns a non-2xx SSE response into the same error a normal operation throws,
 * running the client's error interceptors so app-level handling still applies.
 */
const failedResponseError = async (
  client: Client,
  response: Response,
  request: Request,
): Promise<unknown> => {
  const text = await response.text().catch(() => '')
  let body: unknown = text
  try {
    body = JSON.parse(text)
  } catch {
    // Not JSON; keep the text.
  }

  let error: unknown = body
  for (const fn of client.interceptors.error.fns) {
    if (fn) error = await fn(error, response, request, client.getConfig() as never)
  }
  return error instanceof Error ? error : toOoreApiError(error, response, request)
}

/**
 * Runs a generated SSE operation with the behaviour the generated client
 * lacks: HTTP failures throw `OoreApiError` instead of ending the stream,
 * `break` and abort close the connection, backoff stops on abort, and each
 * reconnect re-resolves the token.
 */
export async function* runSse<TEvent>(
  options: OoreSseOptions,
  defaultMaxAttempts: number,
  open: (attempt: SseAttempt) => Promise<ServerSentEventsResult<unknown>>,
  toEvent: (event: StreamEvent) => TEvent,
): AsyncGenerator<TEvent, void, unknown> {
  const { client } = options
  const maxAttempts = options.sseMaxRetryAttempts ?? defaultMaxAttempts
  const baseFetch =
    options.fetch ?? client.getConfig().fetch ?? globalThis.fetch
  // Aborted in `finally`, so a consumer's `break` closes the connection.
  const controller = new AbortController()
  const outerSignal = options.signal ?? undefined
  const forwardAbort = () => controller.abort(outerSignal?.reason)
  if (outerSignal?.aborted) forwardAbort()
  outerSignal?.addEventListener('abort', forwardAbort, { once: true })

  let attempt = 0
  let lastEventId: string | undefined
  let retryDelay = options.sseDefaultRetryDelay ?? 3000

  try {
    while (!controller.signal.aborted) {
      attempt += 1
      let failure: unknown
      let received = false
      let next: TEvent | undefined

      const { stream } = await open({
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(input, init)
          const response = await baseFetch(request)
          if (!response.ok) {
            throw await failedResponseError(client, response, request)
          }
          return response
        }) as typeof globalThis.fetch,
        headers:
          lastEventId === undefined
            ? options.headers
            : mergeHeaders(options.headers, { 'Last-Event-ID': lastEventId }),
        onSseError: (error) => {
          failure = error
          options.onSseError?.(error)
        },
        onSseEvent: (event) => {
          if (event.id !== undefined) lastEventId = event.id
          if (event.retry !== undefined) retryDelay = event.retry
          next = toEvent(event)
        },
        signal: controller.signal,
        sseMaxRetryAttempts: 1,
      })

      for await (const _data of stream) {
        if (next !== undefined) {
          received = true
          yield next
          next = undefined
        }
      }

      if (failure === undefined || controller.signal.aborted) return
      // A connection that delivered events earns a fresh set of attempts.
      if (received) attempt = 1
      if (attempt >= maxAttempts || !isRetryable(failure)) throw failure

      const backoff = Math.min(
        retryDelay * 2 ** (attempt - 1),
        options.sseMaxRetryDelay ?? 30000,
      )
      await sleep(backoff, controller.signal)
    }
  } finally {
    outerSignal?.removeEventListener('abort', forwardAbort)
    if (!controller.signal.aborted) controller.abort(abortError())
  }
}
