import { access } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

interface PackageExport {
  import: string
  types: string
}

interface PackageJson {
  bin?: Record<string, string>
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
  './events',
  './logs',
  './models',
  './msw',
  './msw/scenarios',
  './openapi.json',
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
  if (typeof target === 'string') {
    if (!(await exists(new URL(target.replace(/^\.\//, ''), root)))) {
      throw new Error(`Missing file export for ${subpath}`)
    }
    continue
  }

  const runtime = new URL(target.import.replace(/^\.\//, ''), root)
  const declarations = new URL(target.types.replace(/^\.\//, ''), root)
  if (!(await exists(runtime))) throw new Error(`Missing runtime export for ${subpath}`)
  if (!(await exists(declarations))) throw new Error(`Missing type export for ${subpath}`)

  const namespace = await import(pathToFileURL(runtime.pathname).href)
  if ('default' in namespace) throw new Error(`${subpath} must not expose a default export`)
}

const rootRuntime = await Bun.file(new URL('dist/index.js', root)).text()
for (const adapter of ['react-query.js', 'msw.js', 'valibot.js', 'cli/']) {
  if (rootRuntime.includes(adapter)) {
    throw new Error(`The root entrypoint must not import ${adapter}`)
  }
}

// The developer CLI ships as a bin only; no export may reach it.
if (JSON.stringify(packageJson.bin) !== JSON.stringify({ 'oore-dev': './dist/cli/main.js' })) {
  throw new Error('The package bin must be exactly oore-dev -> ./dist/cli/main.js')
}
const bin = new URL('dist/cli/main.js', root)
if (!(await exists(bin))) throw new Error('Missing CLI bin dist/cli/main.js')
if (!(await Bun.file(bin).text()).startsWith('#!/usr/bin/env node\n')) {
  throw new Error('The CLI bin must start with a node shebang')
}
// Prefer Node, which users run the bin with; fall back to Bun on runners without it.
const runtime = Bun.which('node') ?? process.execPath
const help = Bun.spawnSync([runtime, bin.pathname, '--help'])
if (help.exitCode !== 0 || !help.stdout.toString().startsWith('Usage: oore-dev')) {
  throw new Error(`The CLI bin does not run under ${runtime}:\n${help.stderr.toString()}`)
}

console.log(`Verified ${expected.length} isolated package entrypoints and the oore-dev bin.`)
