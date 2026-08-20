interface OpenApiOperation {
  operationId?: string
}

interface OpenApiDocument {
  openapi?: string
  paths?: Record<string, Record<string, OpenApiOperation>>
}

const DEFAULT_SCHEMA_URL = 'https://docs.oore.build/openapi.json'
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

const operationIds = Object.values(schema.paths).flatMap((path) =>
  Object.entries(path)
    .filter(([method]) => HTTP_METHODS.has(method))
    .map(([, operation]) => operation.operationId),
)
if (
  operationIds.some((operationId) => !operationId) ||
  new Set(operationIds).size !== operationIds.length
) {
  throw new Error('Every operation must have a unique operationId')
}

await Bun.write(
  new URL('../openapi/openapi.json', import.meta.url),
  `${JSON.stringify(schema, null, 2)}\n`,
)

console.log(`Fetched ${operationIds.length} operations from ${schemaUrl}.`)
