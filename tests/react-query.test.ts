import { expect, test } from 'bun:test'
import { QueryClient } from '@tanstack/react-query'

import { createOoreClient } from '../src/client.js'
import { listProjectsOptions } from '../src/react-query.js'

test('a generated query factory drives cache identity and fetching', async () => {
  const client = createOoreClient({
    baseUrl: 'https://oore.test',
    fetch: (async () =>
      Response.json({
        projects: [],
        total: 0,
      })) as unknown as typeof globalThis.fetch,
  })
  const queryClient = new QueryClient()
  const options = listProjectsOptions({
    client,
    query: { limit: 20 },
  })

  const result = await queryClient.fetchQuery(options)

  expect(options.queryKey[0]).toEqual({
    _id: 'listProjects',
    baseUrl: 'https://oore.test',
    query: { limit: 20 },
    tags: ['Projects'],
  })
  expect(result).toEqual({ projects: [], total: 0 })
})
