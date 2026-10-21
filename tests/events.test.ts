import { expect, test } from 'bun:test'

import { createOoreClient, streamLiveEvents } from '../src/index.js'

test('live event streaming types each Oore event and skips keepalives', async () => {
  let requestedUrl = ''
  const client = createOoreClient({
    baseUrl: 'https://oore.test',
    fetch: (async (request: Request) => {
      requestedUrl = request.url
      return new Response(
        [
          'retry: 3000',
          'event: ready',
          'data: {"runners":true}',
          '',
          ':',
          '',
          'event: build',
          'data: {"build_id":"b1","build_number":7,"project_id":"p1","status":"running","updated_at":10}',
          '',
          'event: runner',
          'data: {"name":"mac","removed":false,"runner_id":"r1","status":"busy"}',
          '',
          'event: release',
          'data: {"build_id":"b1","project_id":"p1","release_id":"rel1","rollout_fraction":0.1,"state":"rolling","updated_at":11}',
          '',
          'event: resync',
          'data: {"reason":"lagged"}',
          '',
          'event: done',
          'data: authorization_ended',
          '',
          '',
        ].join('\n'),
        { headers: { 'content-type': 'text/event-stream' } },
      )
    }) as unknown as typeof globalThis.fetch,
  })
  const events = []

  for await (const event of streamLiveEvents({
    client,
    query: { project_id: 'p1' },
  })) {
    events.push(event)
  }

  expect(requestedUrl).toBe('https://oore.test/v1/events?project_id=p1')
  expect(events).toEqual([
    { ready: { runners: true }, type: 'ready' },
    {
      build: {
        build_id: 'b1',
        build_number: 7,
        project_id: 'p1',
        status: 'running',
        updated_at: 10,
      },
      type: 'build',
    },
    {
      runner: { name: 'mac', removed: false, runner_id: 'r1', status: 'busy' },
      type: 'runner',
    },
    {
      release: {
        build_id: 'b1',
        project_id: 'p1',
        release_id: 'rel1',
        rollout_fraction: 0.1,
        state: 'rolling',
        updated_at: 11,
      },
      type: 'release',
    },
    { reason: 'lagged', type: 'resync' },
    { reason: 'authorization_ended', type: 'done' },
  ])
})
