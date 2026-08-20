interface OpenApiOperation {
  operationId?: string
  responses?: Record<
    string,
    { content?: Record<string, unknown> } | undefined
  >
}

interface OpenApiDocument {
  components?: { schemas?: Record<string, unknown> }
  paths?: Record<string, Record<string, OpenApiOperation>>
}

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

const camelCase = (value: string): string =>
  value
    .replace(/[-_]+([a-zA-Z0-9])/g, (_, character: string) =>
      character.toUpperCase(),
    )
    .replace(/^[A-Z]/, (character) => character.toLowerCase())

const pascalCase = (value: string): string => {
  const camel = camelCase(value)
  return camel.length ? `${camel[0]?.toUpperCase()}${camel.slice(1)}` : camel
}

const schema = (await Bun.file(
  new URL('../openapi/openapi.json', import.meta.url),
).json()) as OpenApiDocument
const sdk = await Bun.file(
  new URL('../src/generated/sdk.gen.ts', import.meta.url),
).text()
const reactQuery = await Bun.file(
  new URL('../src/generated/@tanstack/react-query.gen.ts', import.meta.url),
).text()
const msw = await Bun.file(new URL('../src/msw.ts', import.meta.url)).text()
const types = await Bun.file(
  new URL('../src/generated/types.gen.ts', import.meta.url),
).text()
const valibot = await Bun.file(
  new URL('../src/valibot.ts', import.meta.url),
).text()

const operations = Object.values(schema.paths ?? {}).flatMap((path) =>
  Object.entries(path)
    .filter(([method]) => HTTP_METHODS.has(method))
    .map(([method, operation]) => ({
      method,
      name: camelCase(operation.operationId ?? ''),
      operationId: operation.operationId,
      streams: Object.values(operation.responses ?? {}).some((response) =>
        Object.hasOwn(response?.content ?? {}, 'text/event-stream'),
      ),
    })),
)

const operationIds = operations.map(({ operationId }) => operationId)
if (operationIds.some((operationId) => !operationId)) {
  throw new Error('Every OpenAPI operation must define operationId')
}
if (new Set(operationIds).size !== operationIds.length) {
  throw new Error('OpenAPI operationId values must be unique')
}

const missing: Array<string> = []
for (const operation of operations) {
  const name = operation.name
  const pascal = pascalCase(name)

  if (!sdk.includes(`export const ${name} =`)) missing.push(`operation:${name}`)
  if (!msw.includes(` as ${name}Mock,`)) missing.push(`msw:${name}`)

  if (operation.method === 'get' && !operation.streams) {
    if (!reactQuery.includes(`export const ${name}Options =`)) {
      missing.push(`query-options:${name}`)
    }
    if (
      !reactQuery.includes(
        `use${pascal}Query = (options`) ||
      !reactQuery.includes(`useQuery(${name}Options(options))`)
    ) {
      missing.push(`query-hook:${name}`)
    }
  } else if (operation.method !== 'get') {
    if (!reactQuery.includes(`export const ${name}Mutation =`)) {
      missing.push(`mutation-options:${name}`)
    }
    if (
      !reactQuery.includes(`export const use${pascal}Mutation =`) ||
      !reactQuery.includes(`useMutation({ ...${name}Mutation()`)
    ) {
      missing.push(`mutation-hook:${name}`)
    }
  }
}

const schemaNames = Object.keys(schema.components?.schemas ?? {})
for (const schemaName of schemaNames) {
  const pascal = pascalCase(schemaName)
  if (!types.includes(`export type ${pascal} =`)) missing.push(`type:${pascal}`)
  if (!valibot.includes(`export { v${pascal} } from`)) {
    missing.push(`valibot:v${pascal}`)
  }
}

if (missing.length) {
  throw new Error(`Missing generated API coverage:\n${missing.join('\n')}`)
}

console.log(
  `Verified ${operations.length} operations and ${schemaNames.length} schemas across core, React Query, MSW, types, and Valibot.`,
)
