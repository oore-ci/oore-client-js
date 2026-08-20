interface TreeShakeCase {
  entrypoint: string
  forbidden: ReadonlyArray<string>
  name: string
  required: string
}

const root = new URL('../', import.meta.url)
const outdir = new URL('.tmp/tree-shaking/', root)
const cases: ReadonlyArray<TreeShakeCase> = [
  {
    entrypoint: 'tests/fixtures/tree-shake-core.ts',
    forbidden: ['/v1/users', '/v1/pipelines', '/v1/builds'],
    name: 'core',
    required: '/v1/projects',
  },
  {
    entrypoint: 'tests/fixtures/tree-shake-react-query.ts',
    forbidden: ['/v1/users', '/v1/pipelines', '/v1/builds'],
    name: 'react-query',
    required: '/v1/projects',
  },
  {
    entrypoint: 'tests/fixtures/tree-shake-msw.ts',
    forbidden: ['/v1/users', '/v1/pipelines', '/v1/builds'],
    name: 'msw',
    required: '/v1/projects',
  },
  {
    entrypoint: 'tests/fixtures/tree-shake-valibot.ts',
    forbidden: ['has_keystore', 'notification_type'],
    name: 'valibot',
    required: 'current_user_role',
  },
]

const sizes: Array<string> = []
for (const item of cases) {
  const result = await Bun.build({
    entrypoints: [new URL(item.entrypoint, root).pathname],
    minify: true,
    outdir: new URL(`${item.name}/`, outdir).pathname,
    target: 'browser',
  })
  if (!result.success) {
    throw new Error(
      `${item.name} consumer bundle failed:\n${result.logs.map(String).join('\n')}`,
    )
  }

  const output = result.outputs.find((file) => file.path.endsWith('.js'))
  if (!output) throw new Error(`${item.name} consumer bundle emitted no JavaScript`)
  const bundled = await output.text()

  if (!bundled.includes(item.required)) {
    throw new Error(`${item.name} bundle dropped its selected public symbol`)
  }
  for (const forbidden of item.forbidden) {
    if (bundled.includes(forbidden)) {
      throw new Error(`${item.name} bundle retained unused code: ${forbidden}`)
    }
  }

  sizes.push(`${item.name}=${output.size}B`)
}

console.log(`Verified selective consumer bundles (${sizes.join(', ')}).`)
