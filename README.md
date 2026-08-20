# `@oore/client`

Typed, tree-shakeable JavaScript client for the Oore API. It is generated from Oore's OpenAPI schema and adds small Oore-owned APIs for client setup, errors, log streaming, React Query, MSW, and Valibot.

## Core client

```ts
import {
  createOoreClient,
  listProjects,
  OoreApiError,
} from '@oore/client'

const client = createOoreClient({
  baseUrl: 'http://127.0.0.1:8787',
  token: () => session.getAccessToken(),
})

try {
  const result = await listProjects({
    client,
    query: { limit: 20, search: 'mobile' },
  })
  console.log(result.projects)
} catch (error) {
  if (error instanceof OoreApiError) {
    console.error(error.status, error.code, error.message)
  }
}
```

Each call accepts an explicit client. This keeps clients for separate Oore daemons isolated and makes custom `fetch`, headers, credentials, and token refresh easy to supply.

## React Query

Install `@tanstack/react-query` when using this entrypoint.

```ts
import { useQuery } from '@tanstack/react-query'
import { createOoreClient } from '@oore/client/client'
import {
  listProjectsOptions,
  useListProjectsQuery,
} from '@oore/client/react-query'

const client = createOoreClient({ baseUrl: 'http://127.0.0.1:8787' })

// The main API: portable query options for hooks, loaders, prefetching, and tests.
const projectsQuery = listProjectsOptions({ client, query: { limit: 20 } })
const result = useQuery(projectsQuery)

// Generated convenience hooks call the same option factory.
const sameResult = useListProjectsQuery({ client, query: { limit: 20 } })
```

Query keys, query option factories, mutation option factories, and hooks are generated for every compatible operation.

## MSW

Install `msw` when using these entrypoints.

Use a generated handler factory when a test needs exact control:

```ts
import { HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { listProjectsMock } from '@oore/client/msw'

const server = setupServer(
  listProjectsMock(() =>
    HttpResponse.json({ projects: [], total: 0 }),
  ),
)
```

Use the deterministic Oore scenario for demos and broader flows:

```ts
import { setupServer } from 'msw/node'
import { createOoreMockHandlers } from '@oore/client/msw/scenarios'

const server = setupServer(...createOoreMockHandlers())
```

The default scenario owns a fresh copy of its state each time. Creating a project changes later project-list responses. The data and timestamps are fixed, not random.

## Valibot

Install `valibot` when using this entrypoint.

```ts
import * as v from 'valibot'
import { vProject } from '@oore/client/valibot'

const result = v.safeParse(vProject, input)
```

Each Valibot schema is emitted as its own module, so importing one public schema does not retain all generated schemas.

## Build logs and install manifests

```ts
import {
  createOoreClient,
  getIosInstallManifestText,
  streamBuildLogEvents,
} from '@oore/client'

const client = createOoreClient({ baseUrl: 'http://127.0.0.1:8787' })

for await (const event of streamBuildLogEvents({
  client,
  path: { build_id: 'build-1' },
})) {
  if (event.type === 'log') console.log(event.chunk.content)
}

const plist = await getIosInstallManifestText({
  client,
  path: { token: 'download-token' },
})
```

The manifest helper parses Oore's XML response as text. The generated low-level operation remains available when a `Blob` is preferred.

## Entrypoints

| Import | Contents |
| --- | --- |
| `@oore/client` | Client setup, errors, all operations and models, SSE and XML helpers |
| `@oore/client/client` | Client setup and errors only |
| `@oore/client/operations` | Generated operation functions |
| `@oore/client/models` | Generated TypeScript models |
| `@oore/client/logs` | Typed build-log stream helper |
| `@oore/client/react-query` | React Query keys, option factories, and hooks |
| `@oore/client/msw` | Generated MSW handler factories |
| `@oore/client/msw/scenarios` | Deterministic, stateful Oore scenarios |
| `@oore/client/valibot` | Generated Valibot schemas |

The root entrypoint does not load React Query, MSW, or Valibot. The package has no default export and declares `sideEffects: false`.

## Generation

```sh
bun install --frozen-lockfile
bun run fetch-schema
bun run check
```

Generation pins `@hey-api/openapi-ts`, TypeScript, and all adapter versions. The coverage check requires all OpenAPI operations and component schemas to appear in their matching package surfaces.

## Releases

GitHub Actions checks every pull request and every push to `main`. A daily scheduled workflow fetches `https://docs.oore.build/openapi.json`; when the schema changes, it regenerates the package, runs the full check, and opens or updates a reviewable pull request.

Conventional commits feed Release Please. Merging its version pull request creates a GitHub Release, reruns the package checks from that tag, and publishes `@oore/client` through npm trusted publishing. GitHub Actions are pinned to immutable commits and the publish job uses no long-lived npm token.
