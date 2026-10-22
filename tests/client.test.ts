import { describe, expect, test } from 'bun:test'

import {
  createOoreClient,
  getIosInstallManifestText,
  listProjects,
  OoreApiError,
} from '../src/index.js'

describe('Oore client', () => {
  test('executes a typed operation with the configured instance and token', async () => {
    let received: Request | undefined
    const fetch = (async (request: RequestInfo | URL) => {
      received =
        request instanceof Request ? request : new Request(request.toString())
      return Response.json({ projects: [], total: 0 })
    }) as typeof globalThis.fetch
    const client = createOoreClient({
      baseUrl: 'https://oore.test/',
      fetch,
      token: async () => 'secret-token',
    })

    const result = await listProjects({
      client,
      query: { limit: 20, search: 'mobile app' },
    })

    expect(result).toEqual({ projects: [], total: 0 })
    expect(received?.url).toBe(
      'https://oore.test/v1/projects?limit=20&search=mobile%20app',
    )
    expect(received?.headers.get('authorization')).toBe('Bearer secret-token')
    expect(received?.credentials).toBe('include')
  })

  test('throws an OoreApiError for a structured API failure', async () => {
    const client = createOoreClient({
      baseUrl: 'https://oore.test',
      fetch: (async () =>
        Response.json(
          {
            code: 'invalid_limit',
            details: 'limit must be at most 100',
            error: 'Invalid project query',
          },
          { status: 400 },
        )) as unknown as typeof globalThis.fetch,
    })

    const request = listProjects({ client, query: { limit: 101 } })

    expect(request).rejects.toMatchObject({
      code: 'invalid_limit',
      details: 'limit must be at most 100',
      message: 'Invalid project query',
      name: 'OoreApiError',
      status: 400,
    } satisfies Partial<OoreApiError>)
  })

  test('returns XML responses as text', async () => {
    const client = createOoreClient({
      baseUrl: 'https://oore.test',
      fetch: (async () =>
        new Response('<plist><dict /></plist>', {
          headers: { 'content-type': 'application/xml' },
        })) as unknown as typeof globalThis.fetch,
    })

    const manifest = await getIosInstallManifestText({
      client,
      path: { token: 'download-token' },
    })

    expect(manifest).toBe('<plist><dict /></plist>')
  })

  test('requires an explicit client instead of a localhost default', () => {
    // @ts-expect-error every operation needs a client from createOoreClient
    const call = () => listProjects({})

    expect(call).toThrow(TypeError)
  })

  test('does not use an HTML error page as the message', async () => {
    const html = '<html><body><h1>502 Bad Gateway</h1></body></html>'
    const client = createOoreClient({
      baseUrl: 'https://oore.test',
      fetch: (async () =>
        new Response(html, {
          headers: { 'content-type': 'text/html' },
          status: 502,
          statusText: 'Bad Gateway',
        })) as unknown as typeof globalThis.fetch,
    })

    const error = await listProjects({ client }).catch((e) => e)

    expect(error).toBeInstanceOf(OoreApiError)
    expect(error).toMatchObject({ cause: html, message: 'Bad Gateway', status: 502 })
  })

  test('falls back to the status when an HTML page has no status text', async () => {
    const client = createOoreClient({
      baseUrl: 'https://oore.test',
      fetch: (async () =>
        new Response('<!doctype html><title>oops</title>', {
          status: 500,
        })) as unknown as typeof globalThis.fetch,
    })

    const error = await listProjects({ client }).catch((e) => e)

    expect(error.message).toBe('Oore request failed with status 500')
  })

  test('uses a short plain-text error body as the message', async () => {
    const client = createOoreClient({
      baseUrl: 'https://oore.test',
      fetch: (async () =>
        new Response('daemon is restarting', {
          headers: { 'content-type': 'text/plain' },
          status: 503,
        })) as unknown as typeof globalThis.fetch,
    })

    const error = await listProjects({ client }).catch((e) => e)

    expect(error).toMatchObject({ message: 'daemon is restarting', status: 503 })
  })

  test('passes network errors through unchanged', async () => {
    const failure = new TypeError('fetch failed')
    const client = createOoreClient({
      baseUrl: 'https://oore.test',
      fetch: (async () => {
        throw failure
      }) as unknown as typeof globalThis.fetch,
    })

    expect(listProjects({ client })).rejects.toBe(failure)
  })

  test('rejects when the token function throws', async () => {
    let requests = 0
    const client = createOoreClient({
      baseUrl: 'https://oore.test',
      fetch: (async () => {
        requests += 1
        return Response.json({ projects: [], total: 0 })
      }) as unknown as typeof globalThis.fetch,
      token: () => {
        throw new Error('session expired')
      },
    })

    await expect(listProjects({ client })).rejects.toThrow('session expired')
    expect(requests).toBe(0)
  })

  test('parses an untyped JSON body and treats an empty one as empty JSON', async () => {
    const bodies = ['{"projects":[],"total":0}', '']
    const client = createOoreClient({
      baseUrl: 'https://oore.test',
      fetch: (async () => {
        const response = new Response(bodies.shift())
        response.headers.delete('content-type')
        return response
      }) as unknown as typeof globalThis.fetch,
    })

    expect(await listProjects({ client })).toEqual({ projects: [], total: 0 })
    const empty: unknown = await listProjects({ client })
    expect(empty).toEqual({})
  })
})
