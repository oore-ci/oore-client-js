import { createClient } from './generated/client/index.js'
import type { Client, Config } from './generated/client/index.js'

export type OoreClient = Client

export type OoreToken =
  | string
  | (() => Promise<string | undefined> | string | undefined)

export interface OoreClientOptions
  extends Omit<
    Config,
    'auth' | 'baseUrl' | 'parseAs' | 'responseStyle' | 'throwOnError'
  > {
  /** Base URL of the Oore daemon, for example `http://127.0.0.1:8787`. */
  baseUrl: string
  /** Bearer token or a function that resolves the current token. */
  token?: OoreToken
}

interface ApiErrorBody {
  code: string
  details?: string | null
  error: string
}

export interface OoreApiErrorOptions {
  cause?: unknown
  code?: string | undefined
  details?: string | null | undefined
  request?: Request | undefined
  response: Response
}

/** A non-2xx response returned by an Oore daemon. */
export class OoreApiError extends Error {
  readonly code: string | undefined
  readonly details: string | null | undefined
  readonly request: Request | undefined
  readonly response: Response
  readonly status: number

  constructor(message: string, options: OoreApiErrorOptions) {
    super(message, { cause: options.cause })
    this.name = 'OoreApiError'
    this.code = options.code
    this.details = options.details
    this.request = options.request
    this.response = options.response
    this.status = options.response.status
  }
}

export const isOoreApiError = (error: unknown): error is OoreApiError =>
  error instanceof OoreApiError

const isApiErrorBody = (value: unknown): value is ApiErrorBody => {
  if (!value || typeof value !== 'object') return false

  const body = value as Record<string, unknown>
  return typeof body.code === 'string' && typeof body.error === 'string'
}

const normalizeBaseUrl = (baseUrl: string): string => {
  const normalized = baseUrl.trim().replace(/\/+$/, '')
  if (!normalized) throw new TypeError('Oore client baseUrl must not be empty')
  return normalized
}

/** Creates an isolated client for one Oore daemon. */
export const createOoreClient = (options: OoreClientOptions): OoreClient => {
  const { baseUrl, credentials = 'include', token, ...config } = options

  const client = createClient({
    ...config,
    auth:
      typeof token === 'function'
        ? async () => (await token()) ?? undefined
        : token,
    baseUrl: normalizeBaseUrl(baseUrl),
    credentials,
    parseAs: 'auto',
    responseStyle: 'data',
    throwOnError: true,
  })

  client.interceptors.error.use((error, response, request) => {
    if (!response || error instanceof OoreApiError) return error

    const body = isApiErrorBody(error) ? error : undefined
    const message =
      body?.error ||
      (typeof error === 'string' && error) ||
      response.statusText ||
      `Oore request failed with status ${response.status}`

    return new OoreApiError(message, {
      cause: error,
      code: body?.code,
      details: body?.details,
      request,
      response,
    })
  })

  return client
}
