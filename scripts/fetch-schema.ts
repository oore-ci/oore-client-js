interface OpenApiOperation {
  operationId?: string
}

interface OpenApiDocument {
  openapi?: string
  paths?: Record<string, Record<string, OpenApiOperation>>
  components?: { schemas?: Record<string, unknown> }
}

interface GitHubRelease {
  tag_name: string
  draft: boolean
  published_at: string | null
}

const SOURCE_REPOSITORY = 'oore-ci/oore.build'
const SCHEMA_PATH = 'apps/docs/public/openapi.json'
const HTTP_METHODS = new Set([
  'delete',
  'get',
  'head',
  'options',
  'patch',
  'post',
  'put',
  'trace',
])

// The newest published oore.build release, in any channel. Its spec holds
// only operations that a released server serves. docs.oore.build tracks
// stable only and blocks GitHub-hosted runners, so it is not used.
async function latestReleaseSchemaUrl() {
  const token = process.env.GITHUB_TOKEN
  const response = await fetch(
    `https://api.github.com/repos/${SOURCE_REPOSITORY}/releases?per_page=100`,
    {
      headers: {
        accept: 'application/vnd.github+json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    },
  )
  if (!response.ok) {
    throw new Error(
      `Could not list ${SOURCE_REPOSITORY} releases: ${response.status} ${response.statusText}`,
    )
  }
  const latest = ((await response.json()) as Array<GitHubRelease>)
    .filter((release) => !release.draft && release.published_at)
    .sort((a, b) => b.published_at!.localeCompare(a.published_at!))[0]
  if (!latest) throw new Error(`${SOURCE_REPOSITORY} has no published release`)
  return `https://raw.githubusercontent.com/${SOURCE_REPOSITORY}/${latest.tag_name}/${SCHEMA_PATH}`
}

const schemaUrl = process.env.OORE_OPENAPI_URL ?? (await latestReleaseSchemaUrl())
const response = await fetch(schemaUrl)
if (!response.ok) {
  throw new Error(
    `Could not fetch ${schemaUrl}: ${response.status} ${response.statusText}`,
  )
}

const schema = (await response.json()) as OpenApiDocument
if (!schema.openapi?.startsWith('3.') || !schema.paths) {
  throw new Error(`${schemaUrl} did not return an OpenAPI 3 document`)
}

function operationIdsOf(document: OpenApiDocument) {
  return Object.values(document.paths ?? {}).flatMap((path) =>
    Object.entries(path)
      .filter(([method]) => HTTP_METHODS.has(method))
      .map(([, operation]) => operation.operationId),
  )
}

const operationIds = operationIdsOf(schema)
if (
  operationIds.some((operationId) => !operationId) ||
  new Set(operationIds).size !== operationIds.length
) {
  throw new Error('Every operation must have a unique operationId')
}

// A sync must never silently drop operations or schemas: a stale or
// partial source would otherwise ship a release that removes live APIs.
const schemaFile = new URL('../openapi/openapi.json', import.meta.url)
const current = (await Bun.file(schemaFile).json()) as OpenApiDocument
const removedOperations = [...operationIdsOf(current)].filter(
  (operationId) => !operationIds.includes(operationId),
)
const removedSchemas = Object.keys(current.components?.schemas ?? {}).filter(
  (name) => !(name in (schema.components?.schemas ?? {})),
)
if (
  (removedOperations.length > 0 || removedSchemas.length > 0) &&
  process.env.OORE_ALLOW_SCHEMA_REMOVALS !== 'true'
) {
  throw new Error(
    [
      `${schemaUrl} removes ${removedOperations.length} operations and ${removedSchemas.length} schemas.`,
      ...removedOperations.map((operationId) => `  operation ${operationId}`),
      ...removedSchemas.map((name) => `  schema ${name}`),
      'Set OORE_ALLOW_SCHEMA_REMOVALS=true to accept the removals.',
    ].join('\n'),
  )
}

await Bun.write(
  schemaFile,
  `${JSON.stringify(schema, null, 2)}\n`,
)

console.log(`Fetched ${operationIds.length} operations from ${schemaUrl}.`)
