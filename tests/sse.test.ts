import { describe, expect, test } from 'bun:test'

import {
  createOoreClient,
  OoreApiError,
  streamBuildLogEvents,
  streamLiveEvents,
} from '../src/index.js'

const sse = (...lines: Array<string>) =>
  new Response([...lines, '', ''].join('\n'), {
    headers: { 'content-type': 'text/event-stream' },
  })

const clientWith = (
  respond: (request: Request) => Response | Promise<Response>,
  token: string | (() => string) = 'secret-token',
) =>
  createOoreClient({
    baseUrl: 'https://oore.test',
    fetch: (async (request: Request) =>
      respond(request)) as unknown as typeof globalThis.fetch,
    token,
  })

const drain = async <T>(stream: AsyncIterable<T>) => {
  const events: Array<T> = []
  for await (const event of stream) events.push(event)
  return events
}

describe('SSE failures', () => {
  test('a 401 on the live events stream throws OoreApiError', async () => {
    let requests = 0
    const client = clientWith(() => {
      requests += 1
      return Response.json(
        { code: 'unauthorized', error: 'Token expired' },
        { status: 401 },
      )
    })

    const error = await drain(streamLiveEvents({ client })).catch((e) => e)

    expect(error).toBeInstanceOf(OoreApiError)
    expect(error).toMatchObject({
      code: 'unauthorized',
      message: 'Token expired',
      status: 401,
    })
    expect(requests).toBe(1)
  })

  test('a 401 on the build log stream is not retried', async () => {
    let requests = 0
    const client = clientWith(() => {
      requests += 1
      return new Response('unauthorized', { status: 401 })
    })

    const error = await drain(
      streamBuildLogEvents({ client, path: { build_id: 'b1' } }),
    ).catch((e) => e)

    expect(error).toBeInstanceOf(OoreApiError)
    expect(error.status).toBe(401)
    expect(requests).toBe(1)
  })

  test('a 500 on the build log stream is retried, then thrown', async () => {
    let requests = 0
    const client = clientWith(() => {
      requests += 1
      return new Response('<html><body>Bad gateway</body></html>', {
        headers: { 'content-type': 'text/html' },
        status: 502,
        statusText: 'Bad Gateway',
      })
    })

    const error = await drain(
      streamBuildLogEvents({
        client,
        path: { build_id: 'b1' },
        sseDefaultRetryDelay: 1,
      }),
    ).catch((e) => e)

    expect(error).toBeInstanceOf(OoreApiError)
    expect(error).toMatchObject({ message: 'Bad Gateway', status: 502 })
    expect(requests).toBe(3)
  })

  test('the client error interceptors run for SSE failures', async () => {
    const client = clientWith(
      () => new Response(null, { status: 403, statusText: 'Forbidden' }),
    )
    const seen: Array<number> = []
    client.interceptors.error.use((error, response) => {
      if (response) seen.push(response.status)
      return error
    })

    const error = await drain(streamLiveEvents({ client })).catch((e) => e)

    expect(error).toBeInstanceOf(OoreApiError)
    expect(seen).toEqual([403])
  })

  test('a network failure throws instead of ending the stream', async () => {
    const client = clientWith(() => {
      throw new TypeError('fetch failed')
    })

    const error = await drain(streamLiveEvents({ client })).catch((e) => e)

    expect(error).toBeInstanceOf(TypeError)
  })

  test('the caller still sees onSseError', async () => {
    const client = clientWith(() => new Response(null, { status: 401 }))
    const errors: Array<unknown> = []

    await drain(
      streamLiveEvents({ client, onSseError: (e) => errors.push(e) }),
    ).catch(() => {})

    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(OoreApiError)
  })
})

describe('SSE reconnects', () => {
  test('each reconnect resolves the token again and sends Last-Event-ID', async () => {
    const seen: Array<{ auth: string | null; lastEventId: string | null }> = []
    let tokenCalls = 0
    const client = clientWith(
      (request) => {
        seen.push({
          auth: request.headers.get('authorization'),
          lastEventId: request.headers.get('last-event-id'),
        })
        if (seen.length === 1) {
          // One event, then the connection drops.
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    'id: 41\nevent: log\ndata: {"content":"a","sequence":41,"stream":"stdout"}\n\n',
                  ),
                )
              },
              pull(controller) {
                controller.error(new TypeError('connection reset'))
              },
            }),
            { headers: { 'content-type': 'text/event-stream' } },
          )
        }
        return sse('event: done', 'data: complete')
      },
      () => `token-${++tokenCalls}`,
    )

    const events = await drain(
      streamBuildLogEvents({
        client,
        path: { build_id: 'b1' },
        sseDefaultRetryDelay: 1,
      }),
    )

    expect(events.map((event) => event.type)).toEqual(['log', 'done'])
    expect(seen).toEqual([
      { auth: 'Bearer token-1', lastEventId: null },
      { auth: 'Bearer token-2', lastEventId: '41' },
    ])
  })

  test('aborting during backoff ends the stream right away', async () => {
    const abort = new AbortController()
    const client = clientWith(() => {
      setTimeout(() => abort.abort(), 5)
      return new Response(null, { status: 503 })
    })

    const started = performance.now()
    const events = await drain(
      streamBuildLogEvents({
        client,
        path: { build_id: 'b1' },
        signal: abort.signal,
        sseDefaultRetryDelay: 10_000,
      }),
    )

    expect(events).toEqual([])
    expect(performance.now() - started).toBeLessThan(1000)
  })

  test('an already aborted signal makes no request', async () => {
    let requests = 0
    const client = clientWith(() => {
      requests += 1
      return sse('event: ready', 'data: {"runners":true}')
    })

    const events = await drain(
      streamLiveEvents({ client, signal: AbortSignal.abort() }),
    )

    expect(events).toEqual([])
    expect(requests).toBe(0)
  })
})

describe('SSE connections', () => {
  test('breaking out of the loop closes the server connection', async () => {
    let cancelled!: () => void
    const closed = new Promise<void>((resolve) => {
      cancelled = resolve
    })
    const server = Bun.serve({
      fetch: () =>
        new Response(
          new ReadableStream({
            cancel: () => cancelled(),
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  'event: ready\ndata: {"runners":true}\n\n',
                ),
              )
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
      port: 0,
    })

    try {
      const client = createOoreClient({ baseUrl: server.url.href, token: 't' })
      for await (const event of streamLiveEvents({ client })) {
        expect(event.type).toBe('ready')
        break
      }

      const result = await Promise.race([
        closed.then(() => 'closed'),
        Bun.sleep(2000).then(() => 'open'),
      ])
      expect(result).toBe('closed')
    } finally {
      server.stop(true)
    }
  })

  test('malformed events surface as unknown and keep the stream going', async () => {
    const client = clientWith(() =>
      sse(
        'event: build',
        'data: {not json',
        '',
        'event: build',
        'data: {"build_id":7}',
        '',
        'event: ready',
        'data: {"runners":false}',
      ),
    )

    const events = await drain(streamLiveEvents({ client }))

    expect(events).toEqual([
      { data: '{not json', event: 'build', type: 'unknown' },
      { data: { build_id: 7 }, event: 'build', type: 'unknown' },
      { ready: { runners: false }, type: 'ready' },
    ])
  })
})
