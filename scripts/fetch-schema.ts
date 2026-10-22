interface OpenApiOperation {
  operationId?: string
}

interface OpenApiDocument {
  components?: { schemas?: Record<string, unknown> }
  openapi?: string
  paths?: Record<string, Record<string, OpenApiOperation>>
}

// The spec oore.build's CI keeps in sync with oore-contract. The docs site
// deploys separately and can lag behind, so it is not a safe source.
const DEFAULT_SCHEMA_URL =
  'https://raw.githubusercontent.com/oore-ci/oore.build/master/apps/docs/public/openapi.json'
const SCHEMA_FILE = new URL('../openapi/openapi.json', import.meta.url)
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

const schemaUrl = process.env.OORE_OPENAPI_URL ?? DEFAULT_SCHEMA_URL
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

const operationIdsOf = (document: OpenApiDocument) =>
  Object.values(document.paths ?? {}).flatMap((path) =>
    Object.entries(path)
      .filter(([method]) => HTTP_METHODS.has(method))
      .map(([, operation]) => operation.operationId),
  )
const schemaNamesOf = (document: OpenApiDocument) =>
  Object.keys(document.components?.schemas ?? {})
const missingFrom = (next: Array<string | undefined>, previous: Array<string | undefined>) => {
  const kept = new Set(next)
  return previous.filter((name): name is string => !!name && !kept.has(name))
}

const operationIds = operationIdsOf(schema)
if (
  operationIds.some((operationId) => !operationId) ||
  new Set(operationIds).size !== operationIds.length
) {
  throw new Error('Every operation must have a unique operationId')
}

// A removed operation or schema is a breaking release of @oore/client, and
// usually means the source is stale. Refuse it unless someone opts in.
const current = (await Bun.file(SCHEMA_FILE).json()) as OpenApiDocument
const removedOperations = missingFrom(operationIds, operationIdsOf(current))
const removedSchemas = missingFrom(schemaNamesOf(schema), schemaNamesOf(current))
if (removedOperations.length || removedSchemas.length) {
  const report = [
    `${schemaUrl} removes ${removedOperations.length} operations and ${removedSchemas.length} schemas.`,
    ...removedOperations.map((name) => `  operation ${name}`),
    ...removedSchemas.map((name) => `  schema ${name}`),
  ].join('\n')
  if (process.env.OORE_ALLOW_REMOVALS !== 'true') {
    throw new Error(
      `${report}\nSet OORE_ALLOW_REMOVALS=true to accept the removals.`,
    )
  }
  console.warn(report)
}

await Bun.write(
  SCHEMA_FILE,
  `${JSON.stringify(schema, null, 2)}\n`,
)

console.log(`Fetched ${operationIds.length} operations from ${schemaUrl}.`)
