import { HttpResponse, type HttpHandler } from 'msw'

import {
  approveReleaseMock,
  completeReleaseMock,
  createProjectMock,
  getReleaseMock,
  haltReleaseMock,
  listProjectsMock,
  listReleaseEventsMock,
  listReleasesMock,
  pauseReleaseMock,
  raiseReleaseMock,
  resumeReleaseMock,
  type OoreMswHandlerOptions,
} from './msw.js'
import type {
  ApiError,
  Project,
  Release,
  ReleaseAction,
  ReleaseActionRequest,
  ReleaseActivityEvent,
  ReleaseDetailResponse,
  ReleaseHistoryEntry,
  ReleaseState,
} from './generated/types.gen.js'

export interface OoreMockScenario {
  /** Fixed epoch seconds used for records created during the scenario. */
  now: number
  projects: ReadonlyArray<Project>
  /**
   * Releases with their history, newest history entry last. The handlers
   * recompute `allowed_actions` for a maintainer from each release's state.
   */
  releases?: ReadonlyArray<ReleaseDetailResponse>
}

const DEFAULT_RELEASE_POLICY = {
  approval: 'none',
  crash_rate_threshold: 0.02,
  interval_hours: 24,
  steps: [0.01, 0.05, 0.2, 0.5, 1],
} as const satisfies Release['policy']

/** A Google Play production rollout at 20%, healthy and still moving. */
export const rollingReleaseScenario: ReleaseDetailResponse = {
  history: [
    {
      at: 1_767_052_800,
      id: 'release-rolling-h1',
      to_fraction: 0.01,
      to_state: 'rolling',
    },
    {
      at: 1_767_139_200,
      from_fraction: 0.01,
      from_state: 'rolling',
      id: 'release-rolling-h2',
      to_fraction: 0.05,
      to_state: 'rolling',
    },
    {
      actor_email: 'owner@acme.test',
      actor_id: 'demo-owner',
      at: 1_767_200_000,
      from_fraction: 0.05,
      from_state: 'rolling',
      id: 'release-rolling-h3',
      reason: 'Crash-free rate looks good',
      to_fraction: 0.2,
      to_state: 'rolling',
    },
  ],
  release: {
    allowed_actions: [],
    artifact_id: 'artifact-rolling',
    awaiting_approval: false,
    build_id: 'build-142',
    build_number: 142,
    crash_rate: 0.004,
    crash_rate_threshold: 0.02,
    created_at: 1_767_052_800,
    health: 'healthy',
    id: 'release-rolling',
    next_fraction: 0.5,
    next_step_at: 1_767_286_400,
    package_name: 'com.acme.fluttershop',
    platform: 'android',
    policy: DEFAULT_RELEASE_POLICY,
    project_id: 'project-1',
    project_name: 'FlutterShop',
    rollout_fraction: 0.2,
    state: 'rolling',
    store: 'google_play',
    track: 'production',
    updated_at: 1_767_200_000,
    version_code: 142,
    version_name: '2.4.0',
  },
}

/** A Google Play rollout the daemon halted at 5% after a crash spike. */
export const haltedReleaseScenario: ReleaseDetailResponse = {
  history: [
    {
      at: 1_766_880_000,
      id: 'release-halted-h1',
      to_fraction: 0.01,
      to_state: 'rolling',
    },
    {
      at: 1_766_966_400,
      from_fraction: 0.01,
      from_state: 'rolling',
      id: 'release-halted-h2',
      to_fraction: 0.05,
      to_state: 'rolling',
    },
    {
      at: 1_767_000_000,
      from_fraction: 0.05,
      from_state: 'rolling',
      id: 'release-halted-h3',
      reason: 'Crash rate 3.1% reached the 2% threshold',
      to_state: 'halted',
    },
  ],
  release: {
    allowed_actions: [],
    artifact_id: 'artifact-halted',
    awaiting_approval: false,
    build_id: 'build-139',
    build_number: 139,
    crash_rate: 0.031,
    crash_rate_threshold: 0.02,
    created_at: 1_766_880_000,
    health: 'breached',
    id: 'release-halted',
    package_name: 'com.acme.fluttershop',
    platform: 'android',
    policy: DEFAULT_RELEASE_POLICY,
    project_id: 'project-1',
    project_name: 'FlutterShop',
    rollout_fraction: 0.05,
    state: 'halted',
    store: 'google_play',
    track: 'production',
    updated_at: 1_767_000_000,
    version_code: 139,
    version_name: '2.3.1',
  },
}

/** An App Store release that finished its phased rollout. */
export const completeReleaseScenario: ReleaseDetailResponse = {
  history: [
    {
      at: 1_766_448_000,
      id: 'release-complete-h1',
      to_fraction: 0.01,
      to_state: 'rolling',
    },
    {
      at: 1_767_052_800,
      from_fraction: 0.5,
      from_state: 'rolling',
      id: 'release-complete-h2',
      to_fraction: 1,
      to_state: 'complete',
    },
  ],
  release: {
    allowed_actions: [],
    artifact_id: 'artifact-complete',
    awaiting_approval: false,
    build_id: 'build-137',
    build_number: 137,
    created_at: 1_766_448_000,
    health: 'healthy',
    id: 'release-complete',
    package_name: 'com.acme.fluttershop',
    platform: 'ios',
    policy: DEFAULT_RELEASE_POLICY,
    project_id: 'project-1',
    project_name: 'FlutterShop',
    rollout_fraction: 1,
    state: 'complete',
    store: 'app_store',
    track: 'app_store',
    updated_at: 1_767_052_800,
    version_code: 137,
    version_name: '2.3.0',
  },
}

export const defaultOoreScenario: OoreMockScenario = {
  now: 1_767_225_600,
  projects: [
    {
      created_at: 1_762_041_600,
      created_by: 'demo-owner',
      current_user_role: 'maintainer',
      default_branch: 'main',
      description: 'E-commerce mobile app — Android & iOS',
      id: 'project-1',
      name: 'FlutterShop',
      repository_full_name: 'acme-corp/flutter-shop',
      repository_id: 'github:repo-001',
      repository_provider: 'github',
      settings: {},
      updated_at: 1_767_214_800,
      auto_add_pipelines: true,
    },
    {
      created_at: 1_763_337_600,
      created_by: 'demo-admin',
      current_user_role: 'maintainer',
      default_branch: 'develop',
      description: 'Internal admin dashboard for the operations team',
      id: 'project-2',
      name: 'InternalAdmin',
      repository_full_name: 'acme-corp/internal-admin',
      repository_id: 'github:repo-002',
      repository_provider: 'github',
      settings: {},
      updated_at: 1_767_139_200,
      auto_add_pipelines: false,
    },
  ],
  releases: [
    rollingReleaseScenario,
    haltedReleaseScenario,
    completeReleaseScenario,
  ],
}

const isAwaitingApproval = (release: Release): boolean => {
  if (release.approved_at != null) return false
  if (release.state === 'complete' || release.state === 'failed') return false
  switch (release.policy.approval ?? 'none') {
    case 'before_upload':
      return release.state === 'uploading'
    case 'before_production':
      return release.track === 'production'
    default:
      return false
  }
}

/** Mirrors the daemon's rules for a caller who may manage releases. */
const maintainerActions = (release: Release): Array<ReleaseAction> => {
  const awaiting = isAwaitingApproval(release)
  const { rollout_fraction: fraction, state } = release
  const appStore = release.store === 'app_store'
  const playDraft =
    release.store === 'google_play' && state === 'paused' && fraction === 0
  const moving = state === 'rolling' || state === 'paused'
  const actions: Array<ReleaseAction> = []
  if (!appStore && state === 'rolling' && !awaiting && fraction < 1)
    actions.push('raise')
  if (state === 'rolling') actions.push('pause')
  if ((state === 'paused' || state === 'halted') && !awaiting)
    actions.push('resume')
  if (!appStore && !playDraft && moving) actions.push('halt')
  if (moving && !awaiting) actions.push('complete')
  if (awaiting) actions.push('approve')
  return actions
}

const withActions = (release: Release): Release => ({
  ...release,
  allowed_actions: maintainerActions(release),
  awaiting_approval: isAwaitingApproval(release),
})

const apiError = (status: number, code: string, error: string) =>
  HttpResponse.json<ApiError>({ code, error }, { status })

const cloneRelease = (detail: ReleaseDetailResponse): ReleaseDetailResponse => ({
  history: detail.history.map((entry) => ({ ...entry })),
  release: {
    ...detail.release,
    allowed_actions: [...detail.release.allowed_actions],
    policy: {
      ...detail.release.policy,
      steps: detail.release.policy.steps && [...detail.release.policy.steps],
    },
  },
})

/**
 * Creates deterministic, stateful handlers for Oore's core demo scenario.
 * Each call owns an isolated copy of the supplied state.
 */
export const createOoreMockHandlers = (
  scenario: OoreMockScenario = defaultOoreScenario,
  options?: OoreMswHandlerOptions,
): Array<HttpHandler> => {
  const projects = scenario.projects.map((project) => ({
    ...project,
    settings: { ...project.settings },
  }))
  let nextProjectNumber = projects.length + 1
  const releases = (scenario.releases ?? []).map(cloneRelease)
  let clock = scenario.now
  let nextHistoryNumber = 1

  const releaseAction =
    (action: ReleaseAction) =>
    async ({
      params,
      request,
    }: {
      params: { release_id: string }
      request: Request
    }) => {
      const detail = releases.find(
        (item) => item.release.id === params.release_id,
      )
      if (!detail) return apiError(404, 'not_found', 'Release not found')
      const text = await request.text()
      const body: ReleaseActionRequest = text ? JSON.parse(text) : {}
      const current = detail.release
      if (body.fraction != null && action !== 'raise')
        return apiError(
          400,
          'invalid_input',
          'fraction is only accepted by raise',
        )
      if (!maintainerActions(current).includes(action))
        return apiError(
          409,
          'invalid_release_state',
          `Cannot ${action} a release that is ${current.state}`,
        )

      clock += 60
      if (action === 'approve') {
        detail.release = withActions({
          ...current,
          approved_at: clock,
          approved_by_email: 'owner@acme.test',
          updated_at: clock,
        })
        return HttpResponse.json(detail.release)
      }

      let toState: ReleaseState
      let toFraction: number | undefined
      switch (action) {
        case 'raise': {
          const fraction =
            body.fraction ??
            current.policy.steps?.find(
              (step) => step > current.rollout_fraction,
            ) ??
            1
          if (
            !Number.isFinite(fraction) ||
            fraction <= current.rollout_fraction ||
            fraction > 1
          )
            return apiError(
              400,
              'invalid_input',
              'fraction must be above the current rollout and at most 1',
            )
          toFraction = fraction
          toState = fraction >= 1 ? 'complete' : 'rolling'
          break
        }
        case 'pause':
          toState = 'paused'
          break
        case 'halt':
          toState = 'halted'
          break
        case 'resume':
          toState = 'rolling'
          if (current.rollout_fraction === 0)
            toFraction = current.policy.steps?.[0]
          break
        default:
          toState = 'complete'
          toFraction = 1
      }

      const entry: ReleaseHistoryEntry = {
        actor_email: 'owner@acme.test',
        actor_id: 'demo-owner',
        at: clock,
        from_fraction: current.rollout_fraction,
        from_state: current.state,
        id: `release-history-${nextHistoryNumber++}`,
        reason: body.reason ?? null,
        to_fraction: toFraction ?? null,
        to_state: toState,
      }
      detail.history.push(entry)
      const rolloutFraction = toFraction ?? current.rollout_fraction
      const policySteps = current.policy.steps ?? []
      detail.release = withActions({
        ...current,
        next_fraction:
          toState === 'rolling'
            ? (policySteps.find((step) => step > rolloutFraction) ?? null)
            : null,
        next_step_at: null,
        rollout_fraction: rolloutFraction,
        state: toState,
        updated_at: clock,
      })
      return HttpResponse.json(detail.release)
    }

  return [
    listProjectsMock(({ request }) => {
      const url = new URL(request.url)
      const search = url.searchParams.get('search')?.toLowerCase()
      const offset = Number(url.searchParams.get('offset') ?? 0)
      const limit = Number(url.searchParams.get('limit') ?? 50)
      const matching = search
        ? projects.filter((project) =>
            project.name.toLowerCase().includes(search),
          )
        : projects

      return HttpResponse.json({
        projects: matching.slice(offset, offset + limit),
        total: matching.length,
      })
    }, options),
    createProjectMock(async ({ request }) => {
      const body = await request.json()
      const project: Project = {
        created_at: scenario.now,
        created_by: 'demo-owner',
        current_user_role: 'maintainer',
        default_branch: body.default_branch ?? 'main',
        description: body.description,
        id: `project-${nextProjectNumber++}`,
        name: body.name,
        repository_id: body.repository_id,
        settings: {},
        updated_at: scenario.now,
        auto_add_pipelines: body.auto_add_pipelines ?? true,
      }
      projects.push(project)

      return HttpResponse.json({ project }, { status: 201 })
    }, options),
    listReleasesMock(({ request }) => {
      const url = new URL(request.url)
      const projectId = url.searchParams.get('project_id')
      const buildId = url.searchParams.get('build_id')
      const states = url.searchParams.get('state')?.split(',')
      const offset = Number(url.searchParams.get('offset') ?? 0)
      const limit = Number(url.searchParams.get('limit') ?? 50)
      const matching = releases
        .map((detail) => detail.release)
        .filter(
          (release) =>
            (!projectId || release.project_id === projectId) &&
            (!buildId || release.build_id === buildId) &&
            (!states || states.includes(release.state)),
        )
        .sort((a, b) => b.created_at - a.created_at)

      return HttpResponse.json({
        releases: matching.slice(offset, offset + limit).map(withActions),
        total: matching.length,
      })
    }, options),
    getReleaseMock(({ params }) => {
      const detail = releases.find(
        (item) => item.release.id === params.release_id,
      )
      if (!detail) return apiError(404, 'not_found', 'Release not found')
      return HttpResponse.json({
        history: detail.history,
        release: withActions(detail.release),
      })
    }, options),
    listReleaseEventsMock(({ request }) => {
      const url = new URL(request.url)
      const projectId = url.searchParams.get('project_id')
      const limit = Number(url.searchParams.get('limit') ?? 50)
      const events: Array<ReleaseActivityEvent> = releases
        .filter(
          (detail) => !projectId || detail.release.project_id === projectId,
        )
        .flatMap(({ history, release }) =>
          history.map((entry) => ({
            ...entry,
            build_id: release.build_id,
            project_id: release.project_id,
            project_name: release.project_name,
            release_id: release.id,
            store: release.store,
            track: release.track,
            version_name: release.version_name,
          })),
        )
        .sort((a, b) => b.at - a.at)

      return HttpResponse.json({ events: events.slice(0, limit) })
    }, options),
    raiseReleaseMock(releaseAction('raise'), options),
    pauseReleaseMock(releaseAction('pause'), options),
    resumeReleaseMock(releaseAction('resume'), options),
    haltReleaseMock(releaseAction('halt'), options),
    completeReleaseMock(releaseAction('complete'), options),
    approveReleaseMock(releaseAction('approve'), options),
  ]
}
