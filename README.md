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

Every call requires a `client` from `createOoreClient`; there is no default client. This keeps clients for separate Oore daemons isolated and makes custom `fetch`, headers, credentials, and token refresh easy to supply.

Failed responses throw `OoreApiError`. Its `message` is the API's `error` field, a short plain-text body, or the HTTP status text; an HTML error page from a proxy never becomes the message. The raw body is on `error.cause`. Network failures and a token function that throws reject with the original error.

The package is ESM only. Use `import` (or dynamic `import()` from CommonJS) with `"moduleResolution": "bundler"`, `"node16"` or `"nodenext"`; `require('@oore/client')` and `"moduleResolution": "node"` are not supported.

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

Query keys include the operation, its parameters and the client's `baseUrl`, but not the token. If one app talks to the same daemon as different users (say, after signing out and in), prefix the key with something that identifies the session so cached data is not shared:

```ts
const scopeKey = (sessionId: string, queryKey: QueryKey) => [sessionId, ...queryKey]

const options = listProjectsOptions({ client, query: { limit: 20 } })
useQuery({ ...options, queryKey: scopeKey(session.id, options.queryKey) })
```

Or clear the query cache when the identity changes.

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

`streamLiveEvents` opens one `GET /v1/events` connection and yields typed `build`, `release` and `runner` changes. It returns when the server closes the stream and does not reconnect, so reconnect with your own backoff. Events are not replayed, so refetch on every `ready` after the first and on `resync`:

```ts
import { isOoreApiError } from '@oore/client'
import { streamLiveEvents } from '@oore/client/events'

try {
  for await (const event of streamLiveEvents({ client, signal })) {
    if (event.type === 'build') console.log(event.build.build_id, event.build.status)
  }
} catch (error) {
  if (isOoreApiError(error) && error.status === 401) signOut()
  // Otherwise a network error: reconnect with backoff.
}
```

Both stream helpers share these rules:

- A failed request throws `OoreApiError` (for example a 401 after the token is revoked) instead of ending quietly, and a dropped connection throws the network error. The client's error interceptors run first, as for any other call.
- `streamBuildLogEvents` retries network errors and 5xx responses up to `sseMaxRetryAttempts` (default 3) with `Last-Event-ID` and a freshly resolved token. 4xx responses are not retried.
- Breaking out of the loop or aborting `signal` closes the connection, including during a retry backoff, and the generator returns without throwing.

The manifest helper parses Oore's XML response as text. The generated low-level operation remains available when a `Blob` is preferred.

## Downloads

Artifact downloads (`downloadLocalArtifact`, `downloadViaScopedToken` and the other `application/octet-stream` operations) resolve to a `Blob` by default, which holds the whole IPA or APK in memory. For large files, ask for the stream instead, or hand the browser a URL:

```ts
const body = (await downloadViaScopedToken({
  client,
  parseAs: 'stream',
  path: { token },
})) as unknown as ReadableStream<Uint8Array>

// In a browser, a direct link lets the download manager write to disk.
const link = await generateDownloadLink({ client, path: { artifact_id } })
window.location.assign(link.download_url)
```

## Entrypoints

| Import | Contents |
| --- | --- |
| `@oore/client` | Client setup, errors, all operations and models, SSE and XML helpers |
| `@oore/client/client` | Client setup and errors only |
| `@oore/client/operations` | Generated operation functions |
| `@oore/client/models` | Generated TypeScript models |
| `@oore/client/events` | Typed live event stream helper |
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

GitHub Actions checks every pull request and every push to `main`. A daily scheduled workflow fetches `apps/docs/public/openapi.json` from the newest published oore.build release; when the schema changes, it regenerates the package, runs the full check, and opens or updates a reviewable pull request. The fetch fails if the new schema drops an operation or component schema, unless `OORE_ALLOW_SCHEMA_REMOVALS=true` is set.

Conventional commits feed Release Please. Its version pull request is opened with the workflow token, which doesn't trigger `pull_request` workflows, so the release workflow dispatches CI on that branch. Merging the version pull request creates a GitHub Release, reruns the package checks from that tag, and publishes `@oore/client` through npm trusted publishing, skipping the publish when that version is already on npm. GitHub Actions are pinned to immutable commits and the publish job uses no long-lived npm token.
