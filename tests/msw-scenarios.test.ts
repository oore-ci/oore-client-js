import { afterAll, beforeAll, expect, test } from 'bun:test'
import { setupServer } from 'msw/node'

import {
  completeRelease,
  createOoreClient,
  createProject,
  getRelease,
  haltRelease,
  isOoreApiError,
  listProjects,
  listReleaseEvents,
  listReleases,
  pauseRelease,
  raiseRelease,
  resumeRelease,
} from '../src/index.js'
import {
  completeReleaseScenario,
  createOoreMockHandlers,
  defaultOoreScenario,
  haltedReleaseScenario,
  rollingReleaseScenario,
} from '../src/msw-scenarios.js'

const server = setupServer(...createOoreMockHandlers(defaultOoreScenario))
const client = createOoreClient({ baseUrl: 'https://oore.test' })

const freshScenario = () =>
  server.resetHandlers(...createOoreMockHandlers(defaultOoreScenario))

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterAll(() => server.close())

test('the default scenario keeps project mutations and queries in sync', async () => {
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

test('the default scenario has a rolling, a halted and a complete release', async () => {
  freshScenario()
  const all = await listReleases({ client })
  const halted = await listReleases({ client, query: { state: 'halted' } })

  expect(
    all.releases.map((release) => [release.id, release.state]),
  ).toEqual([
    [rollingReleaseScenario.release.id, 'rolling'],
    [haltedReleaseScenario.release.id, 'halted'],
    [completeReleaseScenario.release.id, 'complete'],
  ])
  expect(all.releases.map((release) => release.allowed_actions)).toEqual([
    ['raise', 'pause', 'halt', 'complete'],
    ['resume'],
    [],
  ])
  expect(halted).toMatchObject({
    releases: [{ id: 'release-halted' }],
    total: 1,
  })
})

test('release actions move the rollout and are recorded in history', async () => {
  freshScenario()
  const path = { release_id: rollingReleaseScenario.release.id }

  const raised = await raiseRelease({ body: {}, client, path })
  expect(raised).toMatchObject({ rollout_fraction: 0.5, state: 'rolling' })

  const paused = await pauseRelease({ body: { reason: 'Hold' }, client, path })
  expect(paused.allowed_actions).toEqual(['resume', 'halt', 'complete'])

  await resumeRelease({ body: {}, client, path })
  const halted = await haltRelease({ body: {}, client, path })
  expect(halted).toMatchObject({ rollout_fraction: 0.5, state: 'halted' })

  await resumeRelease({ body: {}, client, path })
  const complete = await completeRelease({ body: {}, client, path })
  expect(complete).toMatchObject({
    allowed_actions: [],
    rollout_fraction: 1,
    state: 'complete',
  })

  const detail = await getRelease({ client, path })
  expect(detail.history.slice(-6).map((entry) => entry.to_state)).toEqual([
    'rolling',
    'paused',
    'rolling',
    'halted',
    'rolling',
    'complete',
  ])
  expect(detail.history.at(-5)).toMatchObject({ reason: 'Hold' })

  const activity = await listReleaseEvents({ client, query: { limit: 1 } })
  expect(activity.events).toMatchObject([
    { release_id: 'release-rolling', to_state: 'complete' },
  ])
})

test('release actions the state does not allow are rejected', async () => {
  freshScenario()
  const attempt = (release_id: string, run: typeof haltRelease) =>
    run({ body: {}, client, path: { release_id } }).then(
      () => undefined,
      (error: unknown) => (isOoreApiError(error) ? error : undefined),
    )

  expect(await attempt('release-complete', haltRelease)).toMatchObject({
    code: 'invalid_release_state',
    status: 409,
  })
  expect(await attempt('release-halted', raiseRelease)).toMatchObject({
    status: 409,
  })
  expect(await attempt('release-missing', pauseRelease)).toMatchObject({
    status: 404,
  })
  await expect(
    raiseRelease({
      body: { fraction: 0.1 },
      client,
      path: { release_id: 'release-rolling' },
    }),
  ).rejects.toMatchObject({ code: 'invalid_input', status: 400 })
})

test('each handler set owns its own release state', async () => {
  freshScenario()
  await haltRelease({
    body: {},
    client,
    path: { release_id: 'release-rolling' },
  })
  freshScenario()
  const detail = await getRelease({
    client,
    path: { release_id: 'release-rolling' },
  })
  expect(detail.release.state).toBe('rolling')
  expect(rollingReleaseScenario.release.state).toBe('rolling')
})
