import type { OoreClient } from './client.js'
import { createBuild, getBuild, getBuildDiagnosis } from './generated/sdk.gen.js'
import type {
  Build,
  BuildDetailResponse,
  BuildDiagnosis,
  BuildStatus,
  CreateBuildRequest,
} from './generated/types.gen.js'

/** Statuses after which a build does not change any more. */
export const FINISHED_BUILD_STATUSES: ReadonlyArray<BuildStatus> = [
  'succeeded',
  'failed',
  'canceled',
  'timed_out',
  'expired',
]

export const isBuildFinished = (status: BuildStatus): boolean =>
  FINISHED_BUILD_STATUSES.includes(status)

/** A random `Idempotency-Key`, so a retried request starts nothing twice. */
export const newIdempotencyKey = (): string => globalThis.crypto.randomUUID()

export interface StartBuildOptions extends CreateBuildRequest {
  client: OoreClient
  projectId: string
  /** Defaults to a new random key; pass your own to retry safely. */
  idempotencyKey?: string
}

/**
 * Queues a build with an `Idempotency-Key`, so retrying after a timeout with
 * the same key returns the first build instead of starting another.
 */
export async function startBuild(options: StartBuildOptions): Promise<Build> {
  const { client, idempotencyKey, projectId, ...body } = options
  const { build } = await createBuild({
    body,
    client,
    headers: { 'Idempotency-Key': idempotencyKey ?? newIdempotencyKey() },
    path: { project_id: projectId },
  })
  return build
}

export interface WaitForBuildOptions {
  client: OoreClient
  buildId: string
  /** Give up after this long (default: no limit). */
  timeoutMs?: number
  signal?: AbortSignal
  /** Called with the build each time it changes. */
  onChange?: (detail: BuildDetailResponse) => void
  /** Seconds each request may hold on the daemon (1 to 60, default 50). */
  waitSeconds?: number
  /** Pause between requests to daemons that answer at once (default 3000). */
  pollIntervalMs?: number
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Resolves with the build once it has finished. Uses the daemon's long wait
 * (`GET /v1/builds/{id}?wait=`), so each request holds until the build
 * changes; on daemons without it, it polls every `pollIntervalMs`.
 */
export async function waitForBuild(
  options: WaitForBuildOptions,
): Promise<BuildDetailResponse> {
  const {
    buildId,
    client,
    onChange,
    pollIntervalMs = 3_000,
    signal,
    sleep = defaultSleep,
    timeoutMs,
    waitSeconds = 50,
  } = options
  const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs
  let since: number | undefined
  for (;;) {
    signal?.throwIfAborted()
    const remaining =
      deadline === undefined ? undefined : Math.ceil((deadline - Date.now()) / 1000)
    if (remaining !== undefined && remaining <= 0) {
      throw new Error(`Timed out waiting for build ${buildId}`)
    }
    const wait = Math.max(1, Math.min(60, waitSeconds, remaining ?? waitSeconds))
    const started = Date.now()
    const detail = await getBuild({
      client,
      path: { build_id: buildId },
      query:
        since === undefined ? { wait } : { since_updated_at: since, wait },
      signal,
    })
    const changed = detail.build.updated_at !== since
    since = detail.build.updated_at
    if (changed) onChange?.(detail)
    if (isBuildFinished(detail.build.status)) return detail
    // An older daemon ignores `wait` and answers at once.
    if (!changed && Date.now() - started < 1_000) await sleep(pollIntervalMs)
  }
}

export interface RunBuildResult {
  build: Build
  /** Present when the build did not succeed. */
  diagnosis?: BuildDiagnosis
}

/**
 * Queues a build, waits for it to finish and, when it did not succeed,
 * explains why: the loop an agent runs after a change.
 */
export async function runBuildAndWait(
  options: StartBuildOptions &
    Omit<WaitForBuildOptions, 'buildId' | 'client'>,
): Promise<RunBuildResult> {
  const {
    onChange,
    pollIntervalMs,
    signal,
    sleep,
    timeoutMs,
    waitSeconds,
    ...start
  } = options
  const queued = await startBuild(start)
  const { build } = await waitForBuild({
    buildId: queued.id,
    client: options.client,
    onChange,
    pollIntervalMs,
    signal,
    sleep,
    timeoutMs,
    waitSeconds,
  })
  if (build.status === 'succeeded') return { build }
  const diagnosis = await diagnoseBuild({ buildId: build.id, client: options.client })
  return { build, diagnosis }
}

/**
 * Why a build failed: the failed step, the line that explains it with its
 * likely cause and fix, the end of that step's log and the failed tests.
 */
export async function diagnoseBuild(options: {
  client: OoreClient
  buildId: string
  /** Log lines to return, 1 to 200 (default 40). */
  tail?: number
}): Promise<BuildDiagnosis> {
  return getBuildDiagnosis({
    client: options.client,
    path: { build_id: options.buildId },
    query: options.tail === undefined ? undefined : { tail: options.tail },
  })
}
