import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HttpResponse } from 'msw'
import { setupServer } from 'msw/node'

import { runCli, type CliIo } from '../src/cli/run.js'
import {
  createArtifactInstallLinkMock,
  createBuildMock,
  createStreamTokenMock,
  getBuildLogsMock,
  getBuildMock,
  getMeMock,
  getPipelineMock,
  listBuildArtifactsMock,
  listBuildsMock,
  listPipelinesMock,
  listProjectsMock,
  streamBuildLogsMock,
} from '../src/msw.js'
import type {
  Artifact,
  Build,
  BuildLogChunk,
  BuildStatus,
  Pipeline,
  Project,
} from '../src/generated/types.gen.js'

const BASE = 'https://ci.test'
const server = setupServer()
let dir: string
let configFile: string

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterAll(() => server.close())
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'oore-dev-'))
  configFile = join(dir, 'config.json')
  await writeFile(
    configFile,
    JSON.stringify({
      default: 'work',
      instances: { work: { token: 'tok-work', url: BASE } },
    }),
  )
})
afterEach(async () => {
  server.resetHandlers()
  await rm(dir, { force: true, recursive: true })
})

const project = (id: string, name: string) =>
  ({ id, name }) as unknown as Project
const pipeline = (id: string, name: string, project_id: string) =>
  ({ id, name, project_id }) as unknown as Pipeline
const build = (status: BuildStatus, extra: Partial<Build> = {}): Build =>
  ({
    branch: 'main',
    build_number: 42,
    created_at: Math.floor(Date.now() / 1000) - 120,
    id: 'build-42',
    pipeline_id: 'pipe-1',
    project_id: 'proj-1',
    status,
    ...extra,
  }) as unknown as Build
const chunk = (sequence: number, content: string, stream: 'stdout' | 'stderr' = 'stdout'): BuildLogChunk => ({
  content,
  sequence,
  stream,
})
const artifact = (id: string, artifact_type: string, name: string) =>
  ({ artifact_type, build_id: 'build-42', id, name, state: 'available' }) as unknown as Artifact

const notFound = () => HttpResponse.json({ code: 'not_found', error: 'Not found' }, { status: 404 })

/** Runs the CLI against the mock server and captures its output. */
async function cli(argv: Array<string>, extra: Partial<CliIo> = {}) {
  let stdout = ''
  let stderr = ''
  const code = await runCli(argv, {
    env: { HOME: dir, OORE_DEV_CONFIG: configFile },
    pollIntervalMs: 0,
    sleep: async () => {},
    stderr: (text) => {
      stderr += text
    },
    stdout: (text) => {
      stdout += text
    },
    ...extra,
  })
  return { code, stderr, stdout }
}

/** Serves stored logs, honouring `after_sequence`. */
const logsHandler = (stored: () => ReadonlyArray<BuildLogChunk>) =>
  getBuildLogsMock(({ request }) => {
    const after = Number(new URL(request.url).searchParams.get('after_sequence') ?? -1)
    const logs = stored().filter((item) => item.sequence > after)
    return HttpResponse.json({ logs, total: logs.length })
  })

test('login checks the token and saves the instance for later commands', async () => {
  await rm(configFile)
  let seenAuth = null as string | null
  server.use(
    getMeMock(({ request }) => {
      seenAuth = request.headers.get('authorization')
      return HttpResponse.json({ user: { email: 'dev@acme.test', role: 'developer' } as never })
    }),
  )

  const result = await cli(['login', '--url', `${BASE}/`, '--name', 'acme'], {
    readStdin: async () => 'tok-piped\n',
  })

  expect(result).toMatchObject({ code: 0, stderr: '' })
  expect(result.stdout).toContain('as dev@acme.test (developer)')
  expect(seenAuth).toBe('Bearer tok-piped')
  expect(JSON.parse(await readFile(configFile, 'utf8'))).toEqual({
    default: 'acme',
    instances: { acme: { token: 'tok-piped', url: BASE } },
  })
  expect((await stat(configFile)).mode & 0o777).toBe(0o600)
})

test('run finds a pipeline by name across projects and queues a build', async () => {
  let body: unknown
  let auth = null as string | null
  server.use(
    getPipelineMock(notFound),
    listProjectsMock({ body: { projects: [project('proj-1', 'Shop'), project('proj-2', 'Admin')], total: 2 } }),
    listPipelinesMock(({ params }) =>
      HttpResponse.json({
        pipelines:
          params.project_id === 'proj-1'
            ? [pipeline('pipe-1', 'Release', 'proj-1'), pipeline('pipe-9', 'Release nightly', 'proj-1')]
            : [],
        total: 1,
      }),
    ),
    createBuildMock(async ({ params, request }) => {
      auth = request.headers.get('authorization')
      body = { ...(await request.json()), project_id: params.project_id }
      return HttpResponse.json({ build: build('queued', { branch: 'feature/x' }) }, { status: 201 })
    }),
  )

  const result = await cli(['run', 'release', '--branch', 'feature/x', '--platform', 'android,ios'])

  expect(result.code).toBe(0)
  expect(auth).toBe('Bearer tok-work')
  expect(body).toEqual({
    branch: 'feature/x',
    pipeline_id: 'pipe-1',
    platforms: ['android', 'ios'],
    project_id: 'proj-1',
  })
  expect(result.stdout).toBe(
    'Queued build #42 of Release on feature/x for android, ios (build-42)\n' +
      'Follow it with: oore-dev logs -f build-42\n',
  )
})

test('run asks for --project when a pipeline name is ambiguous', async () => {
  server.use(
    getPipelineMock(notFound),
    listProjectsMock({ body: { projects: [project('proj-1', 'Shop'), project('proj-2', 'Admin')], total: 2 } }),
    listPipelinesMock(({ params }) =>
      HttpResponse.json({ pipelines: [pipeline(`pipe-${params.project_id}`, 'CI', params.project_id)], total: 1 }),
    ),
  )

  const result = await cli(['run', 'ci'])

  expect(result.code).toBe(1)
  expect(result.stderr).toContain('matches several pipelines; pass --project')
  expect(result.stderr).toContain('Shop/CI  pipe-proj-1')
  expect(result.stderr).toContain('Admin/CI  pipe-proj-2')
})

test('run --follow streams logs once each and exits with the build result', async () => {
  let streamToken = null as string | null
  let polls = 0
  server.use(
    getPipelineMock({ body: { build_count: 1, pipeline: pipeline('pipe-1', 'Release', 'proj-1') } }),
    createBuildMock({ body: { build: build('queued') }, status: 201 }),
    logsHandler(() => (polls === 0 ? [chunk(0, 'Cloning'), chunk(1, 'warning: cache miss\n', 'stderr')] : [chunk(0, 'Cloning'), chunk(1, 'warning: cache miss\n', 'stderr'), chunk(2, 'Building'), chunk(3, 'Done')])),
    getBuildMock(() => HttpResponse.json({ build: build(polls++ === 0 ? 'running' : 'succeeded'), events: [] })),
    createStreamTokenMock({ body: { expires_at: 0, token: 'stream-1' } }),
    streamBuildLogsMock(({ request }) => {
      streamToken = new URL(request.url).searchParams.get('token')
      return new HttpResponse(
        [
          'event: log',
          'data: {"content":"warning: cache miss\\n","sequence":1,"stream":"stderr"}',
          '',
          'event: log',
          'data: {"content":"Building","sequence":2,"stream":"stdout"}',
          '',
          'event: done',
          'data: succeeded',
          '',
          '',
        ].join('\n'),
        { headers: { 'content-type': 'text/event-stream' } },
      )
    }),
  )

  const result = await cli(['run', 'pipe-1', '-f'])

  expect(streamToken).toBe('stream-1')
  expect(result.code).toBe(0)
  expect(result.stdout).toBe(
    'Queued build #42 of Release on main (build-42)\nCloning\nBuilding\nDone\n',
  )
  expect(result.stderr).toBe('warning: cache miss\nBuild #42 succeeded\n')
})

test('logs -f falls back to polling when the stream is refused', async () => {
  const stored = [chunk(0, 'step 1')]
  const statuses: Array<BuildStatus> = ['running', 'running', 'failed']
  server.use(
    logsHandler(() => stored),
    getBuildMock(() => {
      const next = statuses.shift() ?? 'failed'
      if (next === 'failed') stored.push(chunk(1, 'step 2 failed'))
      return HttpResponse.json({ build: build(next), events: [] })
    }),
    createStreamTokenMock({ body: { expires_at: 0, token: 'stream-1' } }),
    streamBuildLogsMock(() =>
      HttpResponse.json({ code: 'invalid_stream_token', error: 'Invalid' }, { status: 401 }),
    ),
  )

  const result = await cli(['logs', '--follow', 'build-42'])

  expect(result.code).toBe(1)
  expect(result.stdout).toBe('step 1\nstep 2 failed\n')
  expect(result.stderr).toBe('Build #42 failed\n')
})

test('logs without --follow prints stored logs and exits', async () => {
  server.use(logsHandler(() => [chunk(0, 'a'), chunk(1, 'b')]))

  const result = await cli(['logs', 'build-42'])

  expect(result).toEqual({ code: 0, stderr: '', stdout: 'a\nb\n' })
})

test('install prints the install link with a QR code', async () => {
  let requested: string | undefined
  server.use(
    listBuildArtifactsMock({
      body: {
        artifacts: [
          artifact('art-apk', 'apk', 'app-release.apk'),
          artifact('art-ipa', 'ipa', 'Runner.ipa'),
          artifact('art-aab', 'generic', 'app-release.aab'),
        ],
      },
    }),
    createArtifactInstallLinkMock(({ params }) => {
      requested = params.artifact_id
      return HttpResponse.json({
        download_url: `${BASE}/d/1`,
        expires_at: 1_767_225_600,
        install_url: `${BASE}/install/abc`,
        platform: 'android',
      })
    }),
  )

  const ambiguous = await cli(['install', 'build-42'])
  expect(ambiguous.code).toBe(1)
  expect(ambiguous.stderr).toContain('art-apk  apk  app-release.apk')
  expect(ambiguous.stderr).not.toContain('art-aab')

  const result = await cli(['install', 'build-42', '--platform', 'android'], { isTTY: true })
  expect(result.code).toBe(0)
  expect(requested).toBe('art-apk')
  const lines = result.stdout.trimEnd().split('\n')
  expect(lines[0]).toStartWith('app-release.apk (android), link expires at ')
  expect(lines.at(-1)).toBe(`${BASE}/install/abc`)
  expect(lines.slice(1, -1).every((line) => line.startsWith('\x1b[30;107m'))).toBe(true)

  const plain = await cli(['install', 'build-42', '--artifact', 'art-apk', '--no-qr'])
  expect(plain.stdout.split('\n')).toHaveLength(3)
})

test('status shows the account and recent builds', async () => {
  let query: URLSearchParams | undefined
  server.use(
    getMeMock({ body: { user: { email: 'dev@acme.test', role: 'developer' } as never } }),
    listBuildsMock(({ request }) => {
      query = new URL(request.url).searchParams
      return HttpResponse.json({
        builds: [build('running'), build('timed_out', { branch: null, build_number: 41, id: 'build-41' })],
        total: 7,
      })
    }),
  )

  const result = await cli(['status', '--limit', '2'])

  expect(result.code).toBe(0)
  expect(query?.get('limit')).toBe('2')
  expect(result.stdout).toBe(
    `${BASE}  dev@acme.test (developer)\n` +
      '#42  running    main  2m ago  build-42\n' +
      '#41  timed out  -     2m ago  build-41\n' +
      'Showing 2 of 7 builds.\n',
  )
})

test('environment variables override the config file', async () => {
  let auth = null as string | null
  server.use(
    getMeMock(({ request }) => {
      auth = request.headers.get('authorization')
      return HttpResponse.json({ code: 'invalid_session', error: 'Invalid token' }, { status: 401 })
    }),
  )

  const result = await cli(['status'], {
    env: { OORE_DEV_CONFIG: configFile, OORE_TOKEN: 'tok-env', OORE_URL: BASE },
  })

  expect(auth).toBe('Bearer tok-env')
  expect(result.code).toBe(1)
  expect(result.stderr).toContain('Invalid token [HTTP 401] (is the token valid?')
})

test('usage errors exit with code 2', async () => {
  expect((await cli([])).code).toBe(2)
  expect((await cli(['--help'])).code).toBe(0)
  expect(await cli(['deploy'])).toMatchObject({ code: 2 })
  expect(await cli(['run', 'ci', '--platform', 'windows'])).toMatchObject({
    code: 2,
    stderr: 'oore-dev: Unknown platform "windows". Use android, ios, macos.\n',
  })
  expect((await cli(['logs'])).stderr).toBe('oore-dev: Usage: oore-dev logs <build>\n')
  expect(await cli(['status', '--instance', 'home'])).toMatchObject({
    code: 1,
    stderr: 'oore-dev: No instance named "home". Known: work\n',
  })
})
