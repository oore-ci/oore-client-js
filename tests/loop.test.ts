import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { HttpResponse } from 'msw'
import { setupServer } from 'msw/node'

import { createOoreClient, OoreApiError } from '../src/client.js'
import type { Build, BuildStatus } from '../src/generated/types.gen.js'
import { runBuildAndWait, waitForBuild } from '../src/loop.js'
import {
  createBuildMock,
  getBuildDiagnosisMock,
  getBuildMock,
  getMeMock,
} from '../src/msw.js'

const BASE = 'https://ci.test'
const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const client = createOoreClient({ baseUrl: BASE, token: 'tok' })
const build = (status: BuildStatus, updated_at: number) =>
  ({ build_number: 7, id: 'b1', status, updated_at }) as unknown as Build

test('waitForBuild holds on the daemon until the build finishes', async () => {
  const states: Array<[BuildStatus, number]> = [
    ['queued', 1],
    ['running', 2],
    ['failed', 3],
  ]
  const queries: Array<string> = []
  server.use(
    getBuildMock(({ request }) => {
      queries.push(new URL(request.url).search)
      const [status, updated] = states.shift()!
      return HttpResponse.json({ build: build(status, updated), events: [], retryable_steps: [] } as never)
    }),
  )
  const seen: Array<string> = []
  const detail = await waitForBuild({
    buildId: 'b1',
    client,
    onChange: (d) => seen.push(d.build.status),
    sleep: async () => {},
  })
  expect(detail.build.status).toBe('failed')
  expect(seen).toEqual(['queued', 'running', 'failed'])
  expect(queries[0]).toBe('?wait=50')
  expect(queries[1]).toBe('?since_updated_at=1&wait=50')
})

test('runBuildAndWait queues with an Idempotency-Key and explains a failure', async () => {
  let key: string | null = null
  server.use(
    createBuildMock(({ request }) => {
      key = request.headers.get('idempotency-key')
      return HttpResponse.json({ build: build('queued', 1) }, { status: 201 })
    }),
    getBuildMock({ body: { build: build('failed', 2), events: [], retryable_steps: [] } as never }),
    getBuildDiagnosisMock({
      body: {
        build_id: 'b1',
        build_number: 7,
        failed_step: { label: 'Build', name: 'build-1' },
        failed_tests: [],
        failed_tests_total: 0,
        hint: null,
        log_tail: ['boom'],
        log_tail_truncated: false,
        status: 'failed',
      },
    }),
  )
  const result = await runBuildAndWait({
    client,
    idempotencyKey: 'retry-me',
    pipeline_id: 'p1',
    projectId: 'proj',
    sleep: async () => {},
  })
  expect(key as string | null).toBe('retry-me')
  expect(result.build.status).toBe('failed')
  expect(result.diagnosis?.log_tail).toEqual(['boom'])
})

test('OoreApiError carries the hint, retryable and rejected fields', async () => {
  server.use(
    getMeMock(() =>
      HttpResponse.json(
        {
          code: 'invalid_request',
          error: 'Request parameters or body are invalid',
          fields: [{ message: 'missing field `name`', path: 'name' }],
          hint: 'See fields.',
          retryable: false,
        },
        { status: 400 },
      ),
    ),
  )
  const error = await import('../src/generated/sdk.gen.js')
    .then(({ getMe }) => getMe({ client }))
    .catch((e: unknown) => e)
  expect(error).toBeInstanceOf(OoreApiError)
  const apiError = error as OoreApiError
  expect(apiError.hint).toBe('See fields.')
  expect(apiError.retryable).toBe(false)
  expect(apiError.fields).toEqual([{ message: 'missing field `name`', path: 'name' }])

  server.use(getMeMock(() => HttpResponse.json({ code: 'store_error', error: 'x' }, { status: 503 })))
  const old = (await import('../src/generated/sdk.gen.js')
    .then(({ getMe }) => getMe({ client }))
    .catch((e: unknown) => e)) as OoreApiError
  expect(old.hint).toBeUndefined()
  expect(old.retryable).toBe(true)
  expect(old.fields).toEqual([])
})
