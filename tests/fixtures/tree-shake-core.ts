import { createOoreClient, listProjects } from '@oore/client'

export const loadProjects = (fetch: typeof globalThis.fetch) =>
  listProjects({
    client: createOoreClient({ baseUrl: 'https://oore.test', fetch }),
  })
