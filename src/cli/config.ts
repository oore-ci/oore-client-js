import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** One Oore daemon the CLI can talk to. */
export interface InstanceConfig {
  /** Daemon base URL, for example `https://ci.example.com`. */
  url: string
  /** API token (Settings → API tokens) or a session token. */
  token: string
  /** Project ID or name used when a command needs one and none is given. */
  project?: string
}

export interface CliConfig {
  /** Name of the instance used when `--instance` is not given. */
  default?: string
  instances: Record<string, InstanceConfig>
}

export type Env = Readonly<Record<string, string | undefined>>

/**
 * `$OORE_DEV_CONFIG`, else `$XDG_CONFIG_HOME/oore-dev/config.json`, else
 * `~/.config/oore-dev/config.json`. Kept apart from the operator CLI's files.
 */
export const configPath = (env: Env): string =>
  env.OORE_DEV_CONFIG ||
  join(
    env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config'),
    'oore-dev',
    'config.json',
  )

export async function readConfig(path: string): Promise<CliConfig> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { instances: {} }
    }
    throw error
  }
  const parsed = JSON.parse(text) as Partial<CliConfig>
  return { ...parsed, instances: parsed.instances ?? {} }
}

/** Writes the config readable by the current user only: it holds tokens. */
export async function writeConfig(path: string, config: CliConfig): Promise<void> {
  await mkdir(dirname(path), { mode: 0o700, recursive: true })
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  await chmod(path, 0o600)
}

export interface ResolvedInstance extends InstanceConfig {
  name: string
}

/**
 * Picks the instance: `OORE_URL`/`OORE_TOKEN` (or `--url`/`--token`) override
 * the file, `--instance` picks a named entry, else the default entry, else
 * the only entry.
 */
export function resolveInstance(
  config: CliConfig,
  options: { instance?: string; token?: string; url?: string },
  env: Env,
): ResolvedInstance {
  const names = Object.keys(config.instances)
  const name =
    options.instance ??
    env.OORE_INSTANCE ??
    config.default ??
    (names.length === 1 ? names[0] : undefined)
  const saved = name ? config.instances[name] : undefined
  if (name && !saved && (options.instance || env.OORE_INSTANCE)) {
    throw new Error(
      `No instance named "${name}". Known: ${names.join(', ') || 'none'}`,
    )
  }
  const url = options.url ?? env.OORE_URL ?? saved?.url
  const token = options.token ?? env.OORE_TOKEN ?? saved?.token
  if (!url || !token) {
    throw new Error(
      'No Oore instance configured. Run `oore-dev login --url <daemon url>` ' +
        'with an API token, or set OORE_URL and OORE_TOKEN.',
    )
  }
  return {
    name: name ?? 'env',
    project: env.OORE_PROJECT ?? saved?.project,
    token,
    url,
  }
}
