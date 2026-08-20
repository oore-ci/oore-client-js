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
})
