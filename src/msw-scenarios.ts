import { HttpResponse, type HttpHandler } from 'msw'

import {
  createProjectMock,
  listProjectsMock,
  type OoreMswHandlerOptions,
} from './msw.js'
import type { Project } from './generated/types.gen.js'

export interface OoreMockScenario {
  /** Fixed epoch seconds used for records created during the scenario. */
  now: number
  projects: ReadonlyArray<Project>
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
    },
  ],
}

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
      }
      projects.push(project)

      return HttpResponse.json({ project }, { status: 201 })
    }, options),
  ]
}
