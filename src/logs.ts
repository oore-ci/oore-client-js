import { streamBuildLogs } from './generated/sdk.gen.js'
import type { BuildLogChunk } from './generated/types.gen.js'

type GeneratedStreamOptions = Parameters<typeof streamBuildLogs>[0]

export type StreamBuildLogEventsOptions = Omit<
  GeneratedStreamOptions,
  'onSseEvent'
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

/** Streams typed Oore build-log events while preserving SSE event names. */
export async function* streamBuildLogEvents(
  options: StreamBuildLogEventsOptions,
): AsyncGenerator<BuildLogEvent, void, unknown> {
  let nextEvent: BuildLogEvent | undefined

  const { stream } = await streamBuildLogs({
    sseMaxRetryAttempts: 3,
    ...options,
    onSseEvent: ({ data, event }) => {
      if (event === 'log' && isBuildLogChunk(data)) {
        nextEvent = { chunk: data, type: 'log' }
      } else if (event === 'done') {
        nextEvent = { reason: String(data ?? ''), type: 'done' }
      } else {
        nextEvent = { data, event, type: 'unknown' }
      }
    },
  })

  for await (const _data of stream) {
    if (nextEvent) {
      yield nextEvent
      nextEvent = undefined
    }
  }
}
