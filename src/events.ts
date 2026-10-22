import { streamEvents } from './generated/sdk.gen.js'
import { runSse } from './sse.js'
import type {
  BuildChangedEvent,
  EventStreamReady,
  ReleaseChangedEvent,
  RunnerChangedEvent,
} from './generated/types.gen.js'

type GeneratedStreamOptions = NonNullable<Parameters<typeof streamEvents>[0]>

export type StreamLiveEventsOptions = Omit<
  GeneratedStreamOptions,
  'onSseEvent' | 'sseSleepFn'
>

/**
 * An event from `GET /v1/events`. Events are not replayed after a reconnect,
 * so refetch whatever the UI shows on `ready` (after the first) and `resync`.
 */
export type LiveEvent =
  | { ready: EventStreamReady; type: 'ready' }
  | { build: BuildChangedEvent; type: 'build' }
  | { release: ReleaseChangedEvent; type: 'release' }
  | { runner: RunnerChangedEvent; type: 'runner' }
  | { reason: string; type: 'resync' }
  | { reason: string; type: 'done' }
  | { data: unknown; event?: string; type: 'unknown' }

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object'

const toLiveEvent = (event: string | undefined, data: unknown): LiveEvent => {
  if (isObject(data)) {
    if (event === 'ready' && typeof data.runners === 'boolean') {
      return { ready: data as EventStreamReady, type: 'ready' }
    }
    if (event === 'build' && typeof data.build_id === 'string') {
      return { build: data as BuildChangedEvent, type: 'build' }
    }
    if (event === 'release' && typeof data.release_id === 'string') {
      return { release: data as ReleaseChangedEvent, type: 'release' }
    }
    if (event === 'runner' && typeof data.runner_id === 'string') {
      return { runner: data as RunnerChangedEvent, type: 'runner' }
    }
    if (event === 'resync') {
      return { reason: String(data.reason ?? ''), type: 'resync' }
    }
  }
  if (event === 'done') {
    return { reason: String(data ?? ''), type: 'done' }
  }
  return { data, event, type: 'unknown' }
}

/**
 * Streams typed build, release and runner changes from one connection.
 *
 * The generator returns when the server closes the stream or `signal` aborts,
 * and throws when the connection fails: an `OoreApiError` for an HTTP error
 * such as 401 after a token is revoked, or the network error otherwise. It
 * does not reconnect by default (`sseMaxRetryAttempts: 1`); the caller owns
 * backoff and polling fallback. Breaking out of the loop closes the connection.
 */
export function streamLiveEvents(
  options: StreamLiveEventsOptions,
): AsyncGenerator<LiveEvent, void, unknown> {
  return runSse(
    options,
    1,
    (attempt) => streamEvents({ ...options, ...attempt }),
    ({ data, event }) => toLiveEvent(event, data),
  )
}
