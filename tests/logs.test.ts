import { expect, test } from 'bun:test'

import {
  createOoreClient,
  streamBuildLogEvents,
} from '../src/index.js'

test('build log streaming preserves Oore event names and payloads', async () => {
  const client = createOoreClient({
    baseUrl: 'https://oore.test',
    fetch: (async () =>
      new Response(
        [
          'event: log',
          'data: {"content":"Building","sequence":1,"stream":"stdout"}',
          '',
          'event: done',
          'data: complete',
          '',
          '',
        ].join('\n'),
        { headers: { 'content-type': 'text/event-stream' } },
      )) as unknown as typeof globalThis.fetch,
  })
  const events = []

  for await (const event of streamBuildLogEvents({
    client,
    path: { build_id: 'build-1' },
  })) {
    events.push(event)
  }

  expect(events).toEqual([
    {
      chunk: { content: 'Building', sequence: 1, stream: 'stdout' },
      type: 'log',
    },
    { reason: 'complete', type: 'done' },
  ])
})
