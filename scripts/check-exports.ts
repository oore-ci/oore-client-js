import { access } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

interface PackageExport {
  import: string
  types: string
}

interface PackageJson {
  publishConfig?: { access?: string }
  repository?: { url?: string }
  exports: Record<string, PackageExport | string>
  name: string
  private?: boolean
  sideEffects?: boolean
  version: string
}

const root = new URL('../', import.meta.url)
const exists = async (url: URL): Promise<boolean> => {
  try {
    await access(url)
    return true
  } catch {
    return false
  }
}
const packageJson = (await Bun.file(new URL('package.json', root)).json()) as PackageJson
const expected = [
  '.',
  './client',
  './logs',
  './models',
  './msw',
  './msw/scenarios',
  './operations',
  './package.json',
  './react-query',
  './valibot',
]

if (JSON.stringify(Object.keys(packageJson.exports).sort()) !== JSON.stringify(expected.sort())) {
  throw new Error('The package export map does not match the reviewed public entrypoints')
}
if (packageJson.name !== '@oore/client') throw new Error('Unexpected package name')
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(packageJson.version)) {
  throw new Error('The package version must be valid semver')
}
if (packageJson.private === true || packageJson.publishConfig?.access !== 'public') {
  throw new Error('The approved scoped package must be publishable as public')
}
if (
  packageJson.repository?.url !==
  'git+https://github.com/oore-ci/oore-client-js.git'
) {
  throw new Error('The package repository must match npm trusted publishing')
}
if (packageJson.sideEffects !== false) throw new Error('sideEffects must be false')

for (const [subpath, target] of Object.entries(packageJson.exports)) {
  if (typeof target === 'string') continue

  const runtime = new URL(target.import.replace(/^\.\//, ''), root)
  const declarations = new URL(target.types.replace(/^\.\//, ''), root)
  if (!(await exists(runtime))) throw new Error(`Missing runtime export for ${subpath}`)
  if (!(await exists(declarations))) throw new Error(`Missing type export for ${subpath}`)

  const namespace = await import(pathToFileURL(runtime.pathname).href)
  if ('default' in namespace) throw new Error(`${subpath} must not expose a default export`)
}

const rootRuntime = await Bun.file(new URL('dist/index.js', root)).text()
for (const adapter of ['react-query.js', 'msw.js', 'valibot.js']) {
  if (rootRuntime.includes(adapter)) {
    throw new Error(`The root entrypoint must not import ${adapter}`)
  }
}

console.log(`Verified ${expected.length} isolated package entrypoints.`)
