import { parseArgs } from 'node:util'

import { createOoreClient, isOoreApiError, type OoreClient } from '../client.js'
import {
  createArtifactInstallLink,
  createBuild,
  createStreamToken,
  getBuild,
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
import {
  configPath,
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
  --url, --token     Override the instance (env: OORE_URL, OORE_TOKEN)
  -h, --help         Show this help

Config file: $OORE_DEV_CONFIG, else $XDG_CONFIG_HOME/oore-dev/config.json,
else ~/.config/oore-dev/config.json. Create an API token in the web app
under Settings → API tokens.`

/** A failure with a message meant for the terminal, not a stack trace. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message)
    this.name = 'CliError'
  }
}

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
  project: string | undefined
  url: string
}

/** Runs the CLI and resolves to the process exit code. */
export async function runCli(argv: ReadonlyArray<string>, io: CliIo): Promise<number> {
  try {
    return await dispatch(argv, io)
  } catch (error) {
    if (error instanceof CliError) {
      io.stderr(`${CLI_NAME}: ${error.message}\n`)
      return error.exitCode
    }
    if (isOoreApiError(error)) {
      const hint =
        error.status === 401
          ? ' (is the token valid? run `oore-dev login` again)'
          : ''
      io.stderr(`${CLI_NAME}: ${error.message} [HTTP ${error.status}]${hint}\n`)
      return 1
    }
    let message = error instanceof Error ? error.message : String(error)
    // Node's fetch reports "fetch failed" and keeps the reason in `cause`.
    const cause = error instanceof Error ? error.cause : undefined
    if (cause instanceof Error) message += `: ${cause.message}`
    io.stderr(`${CLI_NAME}: ${message}\n`)
    return 1
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
      help: { short: 'h', type: 'boolean' },
      instance: { type: 'string' },
      limit: { type: 'string' },
      name: { type: 'string' },
      'no-qr': { type: 'boolean' },
      platform: { multiple: true, type: 'string' },
      project: { type: 'string' },
      token: { type: 'string' },
      url: { type: 'string' },
    },
    strict: true,
  })
  const [command, target, ...extra] = positionals

  if (values.help || !command || command === 'help') {
    io.stdout(`${USAGE}\n`)
    return command || values.help ? 0 : 2
  }
  if (extra.length > 0) throw new CliError(`Unexpected argument: ${extra[0]}`, 2)

  if (command === 'login') {
    return login(io, {
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
      token: instance.token,
    }),
    io,
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
    case 'install':
      return install(ctx, requireTarget(target, 'install <build>'), {
        artifact: values.artifact,
        platform: values.platform?.[0],
        qr: !values['no-qr'],
      })
    case 'status':
      return status(ctx, parseLimit(values.limit))
    default:
      throw new CliError(`Unknown command "${command}". See \`${CLI_NAME} --help\`.`, 2)
  }
}

const requireTarget = (value: string | undefined, usage: string): string => {
  if (!value) throw new CliError(`Usage: ${CLI_NAME} ${usage}`, 2)
  return value
}

const parsePlatforms = (
  values: ReadonlyArray<string> | undefined,
): Array<BuildPlatform> | undefined => {
  if (!values) return undefined
  const platforms = values.flatMap((value) => value.split(',')).map((p) => p.trim())
  for (const platform of platforms) {
    if (!PLATFORMS.includes(platform as BuildPlatform)) {
      throw new CliError(
        `Unknown platform "${platform}". Use ${PLATFORMS.join(', ')}.`,
        2,
      )
    }
  }
  return [...new Set(platforms)] as Array<BuildPlatform>
}

const parseLimit = (value: string | undefined): number => {
  if (value === undefined) return 10
  const limit = Number(value)
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new CliError('--limit must be a whole number from 1 to 200', 2)
  }
  return limit
}

// ── login ───────────────────────────────────────────────────────

async function login(
  io: CliIo,
  options: { name?: string; project?: string; token?: string; url?: string },
): Promise<number> {
  if (!options.url) throw new CliError('Usage: oore-dev login --url <daemon url> [--token <token>]', 2)
  const url = options.url.replace(/\/+$/, '')
  let token = options.token ?? io.env.OORE_TOKEN
  if (!token && io.readStdin) token = (await io.readStdin()).trim()
  if (!token) {
    throw new CliError(
      'Pass an API token with --token, OORE_TOKEN or stdin. Create one in the web app under Settings → API tokens.',
      2,
    )
  }

  const client = createOoreClient({ baseUrl: url, fetch: io.fetch, token })
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
  io.stdout(`Signed in to ${url} as ${user.email} (${user.role}). Saved "${name}" to ${path}\n`)
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
    path: { project_id: pipeline.project_id },
  })
  const on = build.branch ? ` on ${build.branch}` : ''
  const platforms = options.platforms ? ` for ${options.platforms.join(', ')}` : ''
  ctx.io.stdout(`Queued build #${build.build_number} of ${pipeline.name}${on}${platforms} (${build.id})\n`)
  if (!options.follow) {
    ctx.io.stdout(`Follow it with: ${CLI_NAME} logs -f ${build.id}\n`)
    return 0
  }
  return follow(ctx, build.id)
}

// ── logs ────────────────────────────────────────────────────────

async function logs(ctx: Context, buildId: string, followLogs: boolean): Promise<number> {
  if (followLogs) return follow(ctx, buildId)
  await printPendingLogs(ctx, buildId, -1)
  return 0
}

const writeChunk = (io: CliIo, chunk: BuildLogChunk) => {
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

  io.stderr(`Build #${build.build_number} ${build.status.replace('_', ' ')}\n`)
  return build.status === 'succeeded' ? 0 : 1
}

// ── install ─────────────────────────────────────────────────────

const INSTALLABLE: Record<string, 'android' | 'ios'> = { apk: 'android', ipa: 'ios' }

async function install(
  ctx: Context,
  buildId: string,
  options: { artifact: string | undefined; platform: string | undefined; qr: boolean },
): Promise<number> {
  if (options.platform && options.platform !== 'android' && options.platform !== 'ios') {
    throw new CliError('--platform must be android or ios for install', 2)
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
