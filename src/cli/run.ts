import { parseArgs } from 'node:util'

import { createOoreClient, isOoreApiError, type OoreClient } from '../client.js'
import {
  createArtifactInstallLink,
  createBuild,
  createStreamToken,
  getBuild,
  getBuildDiagnosis,
  getBuildLogs,
  getMe,
  getPipeline,
  listBuildArtifacts,
  listBuilds,
  listPipelines,
  listProjects,
} from '../generated/sdk.gen.js'
import type {
  Artifact,
  Build,
  BuildLogChunk,
  BuildPlatform,
  BuildStatus,
  Pipeline,
  Project,
} from '../generated/types.gen.js'
import { streamBuildLogEvents } from '../logs.js'
import { newIdempotencyKey } from '../loop.js'
import {
  configPath,
  parseHeaders,
  readConfig,
  resolveInstance,
  writeConfig,
  type Env,
} from './config.js'
import { encodeQr, renderQr } from './qr.js'

/** Everything the CLI touches outside itself, so tests can supply it. */
export interface CliIo {
  env: Env
  stdout: (text: string) => void
  stderr: (text: string) => void
  /** Whether stdout is a terminal; turns on colour in the QR code. */
  isTTY?: boolean
  fetch?: typeof globalThis.fetch
  /** Reads piped stdin, for `oore-dev login` without `--token`. */
  readStdin?: () => Promise<string>
  signal?: AbortSignal
  sleep?: (ms: number) => Promise<void>
  /** Polling interval while following logs without a live stream. */
  pollIntervalMs?: number
}

export const CLI_NAME = 'oore-dev'

const USAGE = `Usage: ${CLI_NAME} <command> [options]

Commands:
  run <pipeline>     Queue a build (pipeline ID or name)
      --branch <name>      Branch to build (default: the project's default)
      --platform <name>    android, ios or macos; repeat or comma-separate
      --project <id|name>  Narrow pipeline lookup to one project
      -f, --follow         Follow the build's logs; exit non-zero if it fails
  logs <build>       Print a build's logs
      -f, --follow         Keep streaming until the build finishes
  why <build>        Explain why a build failed: step, cause, fix, log tail
      --tail <n>           Log lines to show (default 40, at most 200)
  install <build>    Print a device install link and its QR code
      --platform <name>    android or ios, when the build has both
      --artifact <id>      A specific artifact
      --no-qr              Print the link only
  status             Show the instance, your account and recent builds
      --project <id|name>  Only this project's builds
      --limit <n>          Number of builds (default 10)
  login              Save an instance to the config file
      --url <url>          Daemon URL (required)
      --token <token>      API token; else OORE_TOKEN or piped stdin
      --name <name>        Instance name (default: "default")
      --project <id|name>  Default project for this instance

Global options:
  --instance <name>  Instance from the config file (env: OORE_INSTANCE)
  --url, --token     Override the instance (env: OORE_URL, OORE_TOKEN;
                     OORE_DAEMON_URL and OORE_SESSION_TOKEN also work)
  --header <h>       Extra header "Name: value" on every request; repeat it
                     (env: OORE_HTTP_HEADERS, one per line)
  --json             Print JSON on stdout; errors as one JSON object on stderr
  -h, --help         Show this help

Exit codes: 0 ok, 1 failed (or the build did not succeed), 4 not signed in
or not allowed, 5 not found, 64 usage error.

Config file: $OORE_DEV_CONFIG, else $XDG_CONFIG_HOME/oore-dev/config.json,
else ~/.config/oore-dev/config.json. Create an API token in the web app
under Settings → API tokens.`

/** Exit codes shared with the `oore` CLI. */
export const EXIT = {
  failed: 1,
  notAllowed: 4,
  notFound: 5,
  ok: 0,
  usage: 64,
} as const

/** A failure with a message meant for the terminal, not a stack trace. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number = EXIT.failed,
    readonly code = exitCode === EXIT.usage ? 'usage' : 'failed',
  ) {
    super(message)
    this.name = 'CliError'
  }
}

const usageError = (message: string) => new CliError(message, EXIT.usage)

const wantsJson = (argv: ReadonlyArray<string>) => argv.includes('--json')

const apiExitCode = (status: number): number =>
  status === 401 || status === 403
    ? EXIT.notAllowed
    : status === 404
      ? EXIT.notFound
      : EXIT.failed

const TERMINAL_STATUSES: ReadonlyArray<BuildStatus> = [
  'succeeded',
  'failed',
  'canceled',
  'timed_out',
  'expired',
]
const isFinished = (status: BuildStatus) => TERMINAL_STATUSES.includes(status)
const PLATFORMS: ReadonlyArray<BuildPlatform> = ['android', 'ios', 'macos']

interface Context {
  client: OoreClient
  io: CliIo
  json: boolean
  project: string | undefined
  url: string
}

/** Prints one JSON value on its own line. */
const printJson = (io: CliIo, value: unknown) => io.stdout(`${JSON.stringify(value)}\n`)

/** Runs the CLI and resolves to the process exit code. */
export async function runCli(argv: ReadonlyArray<string>, io: CliIo): Promise<number> {
  const json = wantsJson(argv)
  const fail = (
    exitCode: number,
    error: { error: string; code: string; status?: number; hint?: string },
    text: string,
  ) => {
    io.stderr(json ? `${JSON.stringify(error)}\n` : `${CLI_NAME}: ${text}\n`)
    return exitCode
  }
  try {
    return await dispatch(argv, io)
  } catch (error) {
    if (error instanceof CliError) {
      return fail(error.exitCode, { code: error.code, error: error.message }, error.message)
    }
    if (isOoreApiError(error)) {
      const hint =
        error.hint ??
        (error.status === 401 ? 'Is the token valid? Run `oore-dev login` again.' : undefined)
      return fail(
        apiExitCode(error.status),
        {
          code: error.code ?? 'http_error',
          error: error.message,
          status: error.status,
          ...(hint ? { hint } : {}),
        },
        `${error.message} [HTTP ${error.status}]${hint ? ` (${hint})` : ''}`,
      )
    }
    let message = error instanceof Error ? error.message : String(error)
    // Node's fetch reports "fetch failed" and keeps the reason in `cause`.
    const cause = error instanceof Error ? error.cause : undefined
    if (cause instanceof Error) message += `: ${cause.message}`
    // A bad option from parseArgs is a usage error.
    const usage =
      error instanceof Error &&
      'code' in error &&
      String((error as { code?: unknown }).code).startsWith('ERR_PARSE_ARGS')
    return fail(
      usage ? EXIT.usage : EXIT.failed,
      { code: usage ? 'usage' : 'failed', error: message },
      message,
    )
  }
}

async function dispatch(argv: ReadonlyArray<string>, io: CliIo): Promise<number> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    args: [...argv],
    options: {
      artifact: { type: 'string' },
      branch: { type: 'string' },
      follow: { short: 'f', type: 'boolean' },
      header: { multiple: true, type: 'string' },
      help: { short: 'h', type: 'boolean' },
      instance: { type: 'string' },
      json: { type: 'boolean' },
      limit: { type: 'string' },
      name: { type: 'string' },
      'no-qr': { type: 'boolean' },
      platform: { multiple: true, type: 'string' },
      project: { type: 'string' },
      tail: { type: 'string' },
      token: { type: 'string' },
      url: { type: 'string' },
    },
    strict: true,
  })
  const json = values.json ?? false
  let headers: Record<string, string>
  try {
    headers = parseHeaders(values.header, io.env)
  } catch (error) {
    throw usageError((error as Error).message)
  }
  const [command, target, ...extra] = positionals

  if (values.help || !command || command === 'help') {
    io.stdout(`${USAGE}\n`)
    return command || values.help ? EXIT.ok : EXIT.usage
  }
  if (extra.length > 0) throw usageError(`Unexpected argument: ${extra[0]}`)

  if (command === 'login') {
    return login(io, {
      headers,
      json,
      name: values.name,
      project: values.project,
      token: values.token,
      url: values.url,
    })
  }

  const config = await readConfig(configPath(io.env))
  const instance = resolveInstance(config, values, io.env)
  const ctx: Context = {
    client: createOoreClient({
      baseUrl: instance.url,
      fetch: io.fetch,
      headers,
      token: instance.token,
    }),
    io,
    json,
    project: values.project ?? instance.project,
    url: instance.url,
  }

  switch (command) {
    case 'run':
      return run(ctx, requireTarget(target, 'run <pipeline>'), {
        branch: values.branch,
        follow: values.follow ?? false,
        platforms: parsePlatforms(values.platform),
      })
    case 'logs':
      return logs(ctx, requireTarget(target, 'logs <build>'), values.follow ?? false)
    case 'why':
      return why(ctx, requireTarget(target, 'why <build>'), parseTail(values.tail))
    case 'install':
      return install(ctx, requireTarget(target, 'install <build>'), {
        artifact: values.artifact,
        platform: values.platform?.[0],
        qr: !values['no-qr'],
      })
    case 'status':
      return status(ctx, parseLimit(values.limit))
    default:
      throw usageError(`Unknown command "${command}". See \`${CLI_NAME} --help\`.`)
  }
}

const requireTarget = (value: string | undefined, usage: string): string => {
  if (!value) throw usageError(`Usage: ${CLI_NAME} ${usage}`)
  return value
}

const parsePlatforms = (
  values: ReadonlyArray<string> | undefined,
): Array<BuildPlatform> | undefined => {
  if (!values) return undefined
  const platforms = values.flatMap((value) => value.split(',')).map((p) => p.trim())
  for (const platform of platforms) {
    if (!PLATFORMS.includes(platform as BuildPlatform)) {
      throw usageError(`Unknown platform "${platform}". Use ${PLATFORMS.join(', ')}.`)
    }
  }
  return [...new Set(platforms)] as Array<BuildPlatform>
}

const parseLimit = (value: string | undefined): number => {
  if (value === undefined) return 10
  const limit = Number(value)
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw usageError('--limit must be a whole number from 1 to 200')
  }
  return limit
}

const parseTail = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined
  const tail = Number(value)
  if (!Number.isInteger(tail) || tail < 1 || tail > 200) {
    throw usageError('--tail must be a whole number from 1 to 200')
  }
  return tail
}

// ── login ───────────────────────────────────────────────────────

async function login(
  io: CliIo,
  options: {
    headers: Record<string, string>
    json: boolean
    name?: string
    project?: string
    token?: string
    url?: string
  },
): Promise<number> {
  if (!options.url) throw usageError('Usage: oore-dev login --url <daemon url> [--token <token>]')
  const url = options.url.replace(/\/+$/, '')
  let token = options.token ?? io.env.OORE_TOKEN ?? io.env.OORE_SESSION_TOKEN
  if (!token && io.readStdin) token = (await io.readStdin()).trim()
  if (!token) {
    throw usageError(
      'Pass an API token with --token, OORE_TOKEN or stdin. Create one in the web app under Settings → API tokens.',
    )
  }

  const client = createOoreClient({
    baseUrl: url,
    fetch: io.fetch,
    headers: options.headers,
    token,
  })
  const { user } = await getMe({ client })

  const path = configPath(io.env)
  const config = await readConfig(path)
  const name = options.name ?? 'default'
  config.instances[name] = {
    ...(options.project ? { project: options.project } : {}),
    token,
    url,
  }
  config.default ??= name
  await writeConfig(path, config)
  if (options.json) {
    printJson(io, { config: path, instance: name, url, user: { email: user.email, role: user.role } })
  } else {
    io.stdout(`Signed in to ${url} as ${user.email} (${user.role}). Saved "${name}" to ${path}\n`)
  }
  return 0
}

// ── lookups ─────────────────────────────────────────────────────

const notFound = (error: unknown) => isOoreApiError(error) && (error.status === 404 || error.status === 400)

async function resolveProject(ctx: Context, value: string): Promise<Project> {
  const { projects } = await listProjects({ client: ctx.client, query: { limit: 200 } })
  const lower = value.toLowerCase()
  const match =
    projects.find((project) => project.id === value) ??
    projects.find((project) => project.name.toLowerCase() === lower)
  if (!match) throw new CliError(`No project "${value}" is visible to this token`)
  return match
}

async function resolvePipeline(ctx: Context, value: string): Promise<Pipeline> {
  const lower = value.toLowerCase()
  const exact = (pipelines: ReadonlyArray<Pipeline>) =>
    pipelines.filter(
      (pipeline) => pipeline.id === value || pipeline.name.toLowerCase() === lower,
    )

  if (ctx.project) {
    const project = await resolveProject(ctx, ctx.project)
    const { pipelines } = await listPipelines({
      client: ctx.client,
      path: { project_id: project.id },
      query: { limit: 200 },
    })
    const [match] = exact(pipelines)
    if (!match) throw new CliError(`No pipeline "${value}" in project ${project.name}`)
    return match
  }

  try {
    return (await getPipeline({ client: ctx.client, path: { pipeline_id: value } })).pipeline
  } catch (error) {
    if (!notFound(error)) throw error
  }

  const { projects } = await listProjects({ client: ctx.client, query: { limit: 200 } })
  const matches: Array<{ pipeline: Pipeline; project: Project }> = []
  for (const project of projects) {
    const { pipelines } = await listPipelines({
      client: ctx.client,
      path: { project_id: project.id },
      query: { limit: 200, search: value },
    })
    for (const pipeline of exact(pipelines)) matches.push({ pipeline, project })
  }
  if (matches.length === 0) throw new CliError(`No pipeline "${value}" is visible to this token`)
  if (matches.length > 1) {
    const list = matches.map(({ pipeline, project }) => `  ${project.name}/${pipeline.name}  ${pipeline.id}`)
    throw new CliError(
      `"${value}" matches several pipelines; pass --project or a pipeline ID:\n${list.join('\n')}`,
    )
  }
  return matches[0]!.pipeline
}

// ── run ─────────────────────────────────────────────────────────

async function run(
  ctx: Context,
  pipelineRef: string,
  options: { branch: string | undefined; follow: boolean; platforms: Array<BuildPlatform> | undefined },
): Promise<number> {
  const pipeline = await resolvePipeline(ctx, pipelineRef)
  const { build } = await createBuild({
    body: {
      branch: options.branch ?? null,
      pipeline_id: pipeline.id,
      platforms: options.platforms ?? null,
    },
    client: ctx.client,
    // Sent so a retry by an HTTP layer never queues a second build.
    headers: { 'Idempotency-Key': newIdempotencyKey() },
    path: { project_id: pipeline.project_id },
  })
  if (ctx.json && !options.follow) {
    printJson(ctx.io, build)
    return 0
  }
  const on = build.branch ? ` on ${build.branch}` : ''
  const platforms = options.platforms ? ` for ${options.platforms.join(', ')}` : ''
  const say = ctx.json ? ctx.io.stderr : ctx.io.stdout
  say(`Queued build #${build.build_number} of ${pipeline.name}${on}${platforms} (${build.id})\n`)
  if (!options.follow) {
    say(`Follow it with: ${CLI_NAME} logs -f ${build.id}\n`)
    return 0
  }
  return follow(ctx, build.id)
}

// ── logs ────────────────────────────────────────────────────────

async function logs(ctx: Context, buildId: string, followLogs: boolean): Promise<number> {
  jsonLogs = ctx.json
  if (followLogs) return follow(ctx, buildId)
  await printPendingLogs(ctx, buildId, -1)
  return 0
}

/** With `--json`, one JSON object per log line on stdout. */
let jsonLogs = false

const writeChunk = (io: CliIo, chunk: BuildLogChunk) => {
  if (jsonLogs) {
    printJson(io, chunk)
    return
  }
  const text = chunk.content.endsWith('\n') ? chunk.content : `${chunk.content}\n`
  if (chunk.stream === 'stderr') io.stderr(text)
  else io.stdout(text)
}

const LOG_PAGE_SIZE = 500

/** Prints every stored chunk after `after` and returns the last sequence. */
async function printPendingLogs(ctx: Context, buildId: string, after: number): Promise<number> {
  for (;;) {
    const { logs } = await getBuildLogs({
      client: ctx.client,
      path: { build_id: buildId },
      query: { after_sequence: after, limit: LOG_PAGE_SIZE },
    })
    for (const chunk of logs) {
      if (chunk.sequence > after) {
        writeChunk(ctx.io, chunk)
        after = chunk.sequence
      }
    }
    if (logs.length < LOG_PAGE_SIZE) return after
  }
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Prints the stored logs, then streams new ones until the build finishes.
 * The stream uses a one-use stream token, which works for API tokens as well
 * as session tokens; if it drops, the CLI falls back to polling.
 */
async function follow(ctx: Context, buildId: string): Promise<number> {
  const { client, io } = ctx
  jsonLogs = ctx.json
  let after = await printPendingLogs(ctx, buildId, -1)
  let build = (await getBuild({ client, path: { build_id: buildId } })).build

  if (!isFinished(build.status)) {
    try {
      const { token } = await createStreamToken({ client, path: { build_id: buildId } })
      for await (const event of streamBuildLogEvents({
        client,
        path: { build_id: buildId },
        query: { token },
        signal: io.signal,
        sseMaxRetryAttempts: 1,
      })) {
        if (event.type === 'log' && event.chunk.sequence > after) {
          writeChunk(io, event.chunk)
          after = event.chunk.sequence
        } else if (event.type === 'done') {
          break
        }
      }
    } catch {
      // Polling below covers a stream that cannot open or drops.
    }

    const sleep = io.sleep ?? defaultSleep
    for (;;) {
      if (io.signal?.aborted) return 130
      after = await printPendingLogs(ctx, buildId, after)
      build = (await getBuild({ client, path: { build_id: buildId } })).build
      if (isFinished(build.status)) break
      await sleep(io.pollIntervalMs ?? 2_000)
    }
    after = await printPendingLogs(ctx, buildId, after)
  }

  if (ctx.json) printJson(io, { build })
  else io.stderr(`Build #${build.build_number} ${build.status.replace('_', ' ')}\n`)
  return build.status === 'succeeded' ? EXIT.ok : EXIT.failed
}

// ── install ─────────────────────────────────────────────────────

const INSTALLABLE: Record<string, 'android' | 'ios'> = { apk: 'android', ipa: 'ios' }

async function install(
  ctx: Context,
  buildId: string,
  options: { artifact: string | undefined; platform: string | undefined; qr: boolean },
): Promise<number> {
  if (options.platform && options.platform !== 'android' && options.platform !== 'ios') {
    throw usageError('--platform must be android or ios for install')
  }
  const { artifacts } = await listBuildArtifacts({
    body: { build_ids: [buildId] },
    client: ctx.client,
  })
  const installable = artifacts.filter(
    (artifact) =>
      artifact.state === 'available' &&
      INSTALLABLE[artifact.artifact_type] !== undefined &&
      (!options.artifact || artifact.id === options.artifact) &&
      (!options.platform || INSTALLABLE[artifact.artifact_type] === options.platform),
  )
  if (installable.length === 0) {
    throw new CliError(
      options.artifact
        ? `Artifact ${options.artifact} is not an installable APK or IPA of build ${buildId}`
        : `Build ${buildId} has no installable APK or IPA${options.platform ? ` for ${options.platform}` : ''}`,
    )
  }
  if (installable.length > 1) {
    const list = installable.map(
      (artifact: Artifact) => `  ${artifact.id}  ${artifact.artifact_type}  ${artifact.name}`,
    )
    throw new CliError(
      `Build ${buildId} has several installable artifacts; pass --platform or --artifact:\n${list.join('\n')}`,
    )
  }

  const artifact = installable[0]!
  const link = await createArtifactInstallLink({
    client: ctx.client,
    path: { artifact_id: artifact.id },
  })
  if (ctx.json) {
    printJson(ctx.io, { artifact, link })
    return 0
  }
  const expires = new Date(link.expires_at * 1000).toLocaleTimeString()
  ctx.io.stdout(`${artifact.name} (${link.platform}), link expires at ${expires}\n`)
  if (options.qr) {
    const color = ctx.io.isTTY === true && !ctx.io.env.NO_COLOR
    ctx.io.stdout(`${renderQr(encodeQr(link.install_url), { color })}\n`)
  }
  ctx.io.stdout(`${link.install_url}\n`)
  return 0
}

// ── status ──────────────────────────────────────────────────────

const age = (seconds: number, now: number): string => {
  const delta = Math.max(0, now - seconds)
  if (delta < 60) return `${delta}s ago`
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`
  if (delta < 86_400) return `${Math.floor(delta / 3600)}h ago`
  return `${Math.floor(delta / 86_400)}d ago`
}

async function status(ctx: Context, limit: number): Promise<number> {
  const { client, io } = ctx
  const { user } = await getMe({ client })
  const project = ctx.project ? await resolveProject(ctx, ctx.project) : undefined
  const { builds, total } = await listBuilds({
    client,
    query: {
      direction: 'desc',
      limit,
      sort: 'created_at',
      ...(project ? { project_id: project.id } : {}),
    },
  })

  if (ctx.json) {
    printJson(io, { builds, project: project ?? null, total, url: ctx.url, user })
    return 0
  }
  io.stdout(`${ctx.url}  ${user.email} (${user.role})\n`)
  if (project) io.stdout(`Project: ${project.name}\n`)
  if (builds.length === 0) {
    io.stdout('No builds yet.\n')
    return 0
  }
  const now = Math.floor(Date.now() / 1000)
  const rows = builds.map((build: Build) => [
    `#${build.build_number}`,
    build.status.replace('_', ' '),
    build.branch ?? '-',
    age(build.created_at, now),
    build.id,
  ])
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((row) => row[i]!.length)))
  for (const row of rows) {
    io.stdout(`${row.map((cell, i) => cell.padEnd(widths[i]!)).join('  ').trimEnd()}\n`)
  }
  if (total > builds.length) io.stdout(`Showing ${builds.length} of ${total} builds.\n`)
  return 0
}

// ── why ─────────────────────────────────────────────────────────

async function why(ctx: Context, buildId: string, tail: number | undefined): Promise<number> {
  const diagnosis = await getBuildDiagnosis({
    client: ctx.client,
    path: { build_id: buildId },
    query: tail === undefined ? undefined : { tail },
  })
  if (ctx.json) {
    printJson(ctx.io, diagnosis)
    return 0
  }
  const { io } = ctx
  const status = diagnosis.status.replace('_', ' ')
  if (!diagnosis.failed_step && !diagnosis.hint) {
    io.stdout(`Build #${diagnosis.build_number} ${status}; nothing failed.\n`)
    return 0
  }
  io.stdout(`Build #${diagnosis.build_number} ${status}\n`)
  const step = diagnosis.failed_step
  if (step) {
    const exit = step.exit_code == null ? '' : ` (exit ${step.exit_code})`
    io.stdout(`Failed step: ${step.label}${exit}\n`)
  }
  const hint = diagnosis.hint
  if (hint) {
    io.stdout(`Cause: ${hint.cause}\n`)
    if (hint.fix) io.stdout(`Fix: ${hint.fix}\n`)
    io.stdout(`Line: ${hint.line}\n`)
  }
  if (diagnosis.failed_tests_total > 0) {
    io.stdout(`Failed tests (${diagnosis.failed_tests_total}):\n`)
    for (const test of diagnosis.failed_tests) {
      io.stdout(`  ${test.name}${test.message ? `: ${test.message.split('\n')[0]}` : ''}\n`)
    }
  }
  if (diagnosis.log_tail.length > 0) {
    const more = diagnosis.log_tail_truncated ? ' (earlier lines cut)' : ''
    io.stdout(`\nLast ${diagnosis.log_tail.length} log lines${more}:\n`)
    for (const line of diagnosis.log_tail) io.stdout(`  ${line}\n`)
  }
  if (diagnosis.url) io.stdout(`\n${diagnosis.url}\n`)
  return 0
}
