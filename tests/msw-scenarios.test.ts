import { afterAll, beforeAll, expect, test } from 'bun:test'
import { setupServer } from 'msw/node'

import {
  createOoreClient,
  createProject,
  listProjects,
} from '../src/index.js'
import {
  createOoreMockHandlers,
  defaultOoreScenario,
} from '../src/msw-scenarios.js'

const server = setupServer(...createOoreMockHandlers(defaultOoreScenario))

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterAll(() => server.close())

test('the default scenario keeps project mutations and queries in sync', async () => {
  const client = createOoreClient({ baseUrl: 'https://oore.test' })

  const before = await listProjects({ client })
  const created = await createProject({
    body: {
      description: 'A deterministic scenario project',
      name: 'ReleaseTools',
    },
    client,
  })
  const after = await listProjects({ client, query: { search: 'release' } })

  expect(before.projects.map((project) => project.name)).toEqual([
    'FlutterShop',
    'InternalAdmin',
  ])
  expect(created.project).toMatchObject({
    id: 'project-3',
    name: 'ReleaseTools',
  })
  expect(after).toMatchObject({
    projects: [{ id: 'project-3', name: 'ReleaseTools' }],
    total: 1,
  })
})
