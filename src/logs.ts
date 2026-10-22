import { streamBuildLogs } from './generated/sdk.gen.js'
import type { BuildLogChunk } from './generated/types.gen.js'
import { runSse } from './sse.js'

type GeneratedStreamOptions = Parameters<typeof streamBuildLogs>[0]

export type StreamBuildLogEventsOptions = Omit<
  GeneratedStreamOptions,
  'onSseEvent' | 'sseSleepFn'
>

export type BuildLogEvent =
  | { chunk: BuildLogChunk; type: 'log' }
  | { reason: string; type: 'done' }
  | { data: unknown; event?: string; type: 'unknown' }

const isBuildLogChunk = (value: unknown): value is BuildLogChunk => {
  if (!value || typeof value !== 'object') return false

  const chunk = value as Record<string, unknown>
  return (
    typeof chunk.content === 'string' &&
    typeof chunk.sequence === 'number' &&
    (chunk.stream === 'stdout' || chunk.stream === 'stderr')
  )
}

const toBuildLogEvent = ({
  data,
  event,
}: {
  data: unknown
  event?: string | undefined
}): BuildLogEvent => {
  if (event === 'log' && isBuildLogChunk(data)) return { chunk: data, type: 'log' }
  if (event === 'done') return { reason: String(data ?? ''), type: 'done' }
  return { data, event, type: 'unknown' }
}

/**
 * Streams typed Oore build-log events while preserving SSE event names.
 *
 * Network errors and 5xx responses are retried up to `sseMaxRetryAttempts`
 * (default 3) with `Last-Event-ID` and a freshly resolved token. The generator
 * then throws: an `OoreApiError` for HTTP errors (4xx are not retried), or the
 * network error. It returns when the server closes the stream or `signal`
 * aborts, and breaking out of the loop closes the connection.
 */
export function streamBuildLogEvents(
  options: StreamBuildLogEventsOptions,
): AsyncGenerator<BuildLogEvent, void, unknown> {
  return runSse(
    options,
    3,
    (attempt) => streamBuildLogs({ ...options, ...attempt }),
    toBuildLogEvent,
  )
}
