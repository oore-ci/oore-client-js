# Generator evaluation for `@oore/client`

Date: 2026-08-20

## Recommendation

Use **`@hey-api/openapi-ts` 0.99.0 with its generated Fetch client** as the generator for the first `@oore/client` prototype. Do **not** use Orval as the package foundation just because Oore web already uses it.

Hey API is the best fit for the package contract Oore needs:

- isolated client instances with their own base URL, bearer token, credentials, custom `fetch`, and interceptors;
- one named operation per `operationId` plus named models;
- typed server-sent events, binary bodies, raw streams, and content-type-aware response parsing;
- both tree-shakeable flat functions and an instantiable/nested SDK;
- optional Zod or Valibot request/response validation;
- generated runtime source that can ship inside `@oore/client`, without making consumers install a separate HTTP package.

The choice is not risk-free. Hey API is still `0.x`; its docs tell users to pin exact versions. In the local spike, `npx @hey-api/openapi-ts@0.99.0` pulled the current TypeScript 7 peer and crashed. Installing exact `typescript@5.9.3` made generation pass. The client also parses `application/xml` as `Blob` under automatic parsing, while Oore declares its two plist operations as `string`; those operations need an explicit `parseAs: 'text'` override or a schema/content-type correction.

Pin this toolchain exactly and keep generated code behind Oore-owned exports:

```json
{
  "devDependencies": {
    "@hey-api/openapi-ts": "0.99.0",
    "typescript": "5.9.3"
  }
}
```

The standalone npm package `@hey-api/client-fetch` is deprecated. Its maintained runtime now gets bundled into generated output, even though the generator plugin is still named `@hey-api/client-fetch`. [Hey API Fetch client](https://heyapi.dev/docs/openapi/typescript/clients/fetch), [deprecated npm package](https://www.npmjs.com/package/%40hey-api/client-fetch)

## Oore requirements verified from the current schema

The current [OpenAPI document](/Users/arya/projects/oore.build/apps/docs/public/openapi.json) is OpenAPI 3.1.0 with:

- 121 paths, 150 operations, and 242 component schemas;
- a unique, non-empty `operationId` on every operation;
- 21 tags;
- bearer auth, session cookies, and 24 operations with route-specific or public auth;
- one SSE operation;
- raw octet-stream upload plus binary, image, Git smart-HTTP, XML, HTML, and plain-text responses;
- 34 `oneOf` schemas and one `allOf` schema.

The existing [Orval config](/Users/arya/projects/oore.build/apps/web/orval.config.ts) generates named functions and models grouped by tag. The current [custom transport](/Users/arya/projects/oore.build/apps/web/src/lib/api-client/transport.ts) correctly carries a per-request `baseUrl`, token, cookies, abort signal, demo guard, and Oore error conversion, but it always reads response text and calls `JSON.parse`. It therefore cannot correctly execute the generated binary, SSE, XML, HTML, or plain-text operations. That transport is suitable for the JSON operations Oore web uses today, not for a complete public client.

## Comparison

| Need | Orval 8.24.0 | Hey API 0.99.0 | `openapi-typescript` 7.13 + `openapi-fetch` 0.17 | Kubb 5.0.0 |
|---|---|---|---|---|
| OpenAPI 3.1 | Yes; documents JSON Schema 2020-12 support | Yes; Oore schema generated, but advanced dynamic refs still have an open limitation | Yes, explicit 3.0/3.1 support | Yes, explicit 2.0/3.0/3.1 support |
| Browser + Node Fetch | Yes | Yes | Yes | Yes |
| Isolated client per Oore instance | No first-class `createClient`; use per-call options or a mutator | **Yes:** `createClient`, per-call client override and config | **Yes:** `createClient` | **Yes:** `createClient` |
| Base URL, bearer auth, cookies, custom Fetch | Mutator or request options | **First-class config**; auth follows operation security | Base URL/custom Fetch first-class; auth is authored middleware | First-class config/auth; arbitrary custom transport |
| Named operations and models | Yes | Yes | Named models, but calls are path strings such as `client.GET('/v1/projects')` | Yes |
| Grouping and exports | `tags-split`, schema barrels | Flat tree-shakeable functions or nested class; configurable barrel | One generated type map; no generated domain SDK | Per-operation files, tag/path groups, named barrels or none |
| SSE | No first-party SSE helper; generated Fetch buffers the Oore stream as text | **Typed SSE client** | Manual `parseAs: 'stream'` and parser | Typed async event stream |
| Mixed JSON/binary/text responses | Built-in Fetch handles common success types, but binary operations parse JSON error bodies as `Blob`; a mutator must repair this | **Best default:** success parsing follows actual response `Content-Type`, and errors are JSON-or-text; XML needs an override | Per-call `parseAs`; no generated per-operation choice | Broad support, but the Oore spike exposed a wrong fixed parser on raw upload errors |
| Custom errors/transport | Strong mutator seam, but it replaces much of the generated Fetch behavior | Request/response/error interceptors and custom Fetch; error interceptor can create `OoreApiError` | Middleware and custom Fetch | Strong interceptors and arbitrary transport; built-in `ResponseError` |
| Runtime validation | Zod; JSON only, and bypassed by custom mutators | Zod or Valibot, request and/or response | None in this pair | Zod, request and/or response |
| Deterministic generation | Pin version and verify clean diff; recent barrel-idempotence fixes | Pin version, TS, and formatter; local rerun was byte-identical | `--check` and `--alphabetize` help | Docs promise determinism; local rerun was byte-identical |
| Release health | **Most mature:** stable v8 and frequent releases | Very active, but initial-development `0.x` with breaking releases | Core generator remains maintained; **`openapi-fetch` entered maintenance mode** | Active, but v5 stable was published on 2026-08-20 after a full rewrite |
| Package fit | Good fallback if Oore authors a client layer | **Best foundation** | Too low-level for the API Oore wants | Re-evaluate after v5 settles |

Sources: [Orval Fetch](https://orval.dev/docs/guides/fetch/), [Orval output and validation](https://orval.dev/docs/reference/configuration/output/), [Hey API Fetch client](https://heyapi.dev/docs/openapi/typescript/clients/fetch), [Hey API SDK](https://heyapi.dev/docs/openapi/typescript/plugins/sdk), [openapi-fetch API](https://openapi-ts.dev/openapi-fetch/api), [openapi-fetch middleware](https://openapi-ts.dev/openapi-fetch/middleware-auth), [Kubb Fetch plugin](https://kubb.dev/plugins/plugin-fetch), [Kubb introduction](https://www.kubb.dev/docs/5.x/getting-started/introduction)

## Local generation spike against Oore

All checks used the exact current `apps/docs/public/openapi.json`.

### Orval 8.24.0

- Existing output covers all 150 `operationId` values. It emits 150 operation functions plus 150 URL helpers.
- A separate built-in-Fetch generation also covered all 150 operations and produced status-keyed response unions.
- It generated SSE as `await res.text()`, so it buffers rather than streams.
- For binary-success operations, it generated `await res.blob()` for every status. A documented JSON error response therefore becomes a `Blob` while its TypeScript branch says `ApiError`.
- Runtime Zod validation would not solve these paths: Orval documents validation as JSON-only and warns that custom mutators can bypass it. [Runtime validation matrix](https://orval.dev/docs/reference/configuration/output/#runtime-validation-support-matrix)

Orval remains a credible fallback because it is mature, already adopted, and its mutator can own the whole response pipeline. The cost is that Oore would be writing the isolated client, SSE, content negotiation, auth, and error behavior that Hey API already supplies.

### Hey API 0.99.0

- With exact TypeScript 5.9.3, generation completed in about 150 ms and emitted all 150 operation URLs.
- The generated source passed strict TypeScript checking.
- A second generation was byte-identical for the SDK, model, and client runtime files checked.
- `streamBuildLogs` became a typed `ServerSentEventsResult` operation.
- Raw upload kept the body raw; binary/image downloads became `Blob`; errors are read as text and parsed as JSON when possible.
- Each SDK function accepts a replacement `client`, and the generated runtime exports `createClient({ baseUrl, auth, credentials, fetch, ... })`.
- Its automatic parser treats all non-JSON `application/*` responses as `Blob`; the two Oore `application/xml` plist operations therefore need `parseAs: 'text'`.

Hey API officially calls the package initial development and recommends exact pins. It also has an open limitation for advanced OpenAPI 3.1 `$dynamicRef`/`$dynamicAnchor`; Oore does not use those keywords today. [Versioning](https://heyapi.dev/docs/openapi/typescript/get-started#versioning), [dynamic-ref issue](https://github.com/hey-api/hey-api/issues/3886)

One extra toolchain failure matters: the package peer range accepted the current TypeScript 7.0.2, but the CLI crashed while reading `ts.SyntaxKind`. The exact TypeScript 5.9.3 install passed. Treat TypeScript as part of the pinned generator toolchain, not a loose peer.

### `openapi-typescript` 7.13.0 + `openapi-fetch` 0.17.0

- The Oore schema generated successfully into one 9,725-line type module.
- It has the smallest and simplest runtime and excellent per-instance configuration.
- It does not generate an ergonomic named function per operation. Users call uppercase methods with literal schema paths, so `operationId` does not become the package API.
- It has no runtime validation in this pair and no generated auth policy or SSE API.
- More importantly, the maintainers placed `openapi-fetch` in maintenance mode for 2026 while retaining active work on `openapi-typescript`. [Official 2026 roadmap](https://github.com/openapi-ts/openapi-typescript/discussions/2559)

This is a strong choice for apps that want a thin typed Fetch wrapper. It is the wrong base for Oore's named, discoverable SDK.

### Kubb 5.0.0

- Generated all 150 operation functions and 392 model/operation type files from Oore.
- Generated output passed strict TypeScript after enabling `allowImportingTsExtensions` for its `.ts` self-import.
- A second run was byte-identical for the sample outputs checked.
- It has the strongest transport abstraction here, typed SSE, auth resolvers, status-keyed results, optional Zod validation, tag grouping, and per-operation files. [Transport](https://kubb.dev/plugins/plugin-fetch/guide/transport), [auth](https://kubb.dev/plugins/plugin-fetch/guide/authentication), [options](https://kubb.dev/plugins/plugin-fetch/reference/options)
- The raw artifact upload generated `responseType: 'blob'` because its request body is octet-stream, even though the success response is empty and its documented error responses are JSON. Its TypeScript error branches say `ApiError`, but the runtime would parse them as `Blob`.

Kubb v5's feature set matches Oore well, but the stable v5 release landed on the day of this evaluation after a broad AST/runtime rewrite. Its docs still contain beta install commands. Do not make Oore's canonical package the first production proof of this new major. Recheck after a few patch releases. [Kubb v5 release](https://github.com/kubb-labs/kubb/releases), [current npm metadata](https://registry.npmjs.org/kubb/latest)

## Package API boundary

Do not expose generator internals as the only contract. Ship two layers:

```ts
import { createOoreClient } from '@oore/client'

const oore = createOoreClient({
  baseUrl: 'https://ci.example.com',
  token,
  credentials: 'include',
  fetch,
})

await oore.projects.list({ query: { limit: 20 } })
await oore.builds.streamLogs({ path: { build_id }, onEvent })
```

1. The root export is an Oore-owned `createOoreClient` and `OoreApiError`. It sets instance config, converts parsed API error bodies into an `Error`, applies the XML override, and exposes tag-based groups.
2. `@oore/client/operations` exports every generated flat operation for full coverage and tree shaking.
3. `@oore/client/models` exports every named schema and operation input/response type.
4. The generated default singleton is not a root export. Every root client owns an isolated generated client.
5. Oore web's demo-mode mutation guard remains in Oore web. It is not public SDK behavior.

The package CI should assert that every OpenAPI `operationId` appears in the generated operations export and in the grouped root client. This turns “all API is in the package” into a check, not a review claim.

Before any publish or push, review a generated API inventory with one representative call from every tag, plus these edge cases:

- cookie session and bearer token precedence;
- public and optionally-authenticated routes;
- setup bootstrap token flows;
- abort signals and custom Fetch;
- SSE reconnect/cancel/error behavior in browser and Node;
- raw `Blob`/`ArrayBuffer`/Node upload inputs;
- binary/image/Git protocol downloads;
- XML, HTML, and plain-text responses;
- empty 200, 204, JSON error, network error, and response-validation failure.

## Publishing ergonomics and pinning

None of the four tools owns npm publishing. The client repo must provide package metadata, export maps, build, provenance, compatibility checks, and release automation.

Hey API and Kubb generate their client runtimes into source, so consumers need no separate HTTP runtime dependency. Orval's native Fetch output is also dependency-free unless validation or an authored mutator adds dependencies. `openapi-fetch` remains a consumer runtime dependency unless bundled.

Pin exact generator versions and run a clean-generation check in CI. Current authoritative package metadata: [Orval](https://registry.npmjs.org/orval/latest), [Hey API](https://registry.npmjs.org/%40hey-api%2Fopenapi-ts/latest), [openapi-typescript](https://registry.npmjs.org/openapi-typescript/latest), [openapi-fetch](https://registry.npmjs.org/openapi-fetch/latest), [Kubb](https://registry.npmjs.org/kubb/latest), [Kubb Fetch plugin](https://registry.npmjs.org/%40kubb%2Fplugin-fetch/latest).

## Decision

Proceed with a local, unpublished Hey API prototype and API review. Keep Orval only in the current Oore web flow until that prototype replaces it. Do not create a remote repo, push, or publish until the root API, edge-operation behavior, and generated export inventory pass review.
