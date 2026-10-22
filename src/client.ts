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

const MAX_TEXT_MESSAGE_LENGTH = 200

/** Uses a text body as the message only when it reads like one, not a page. */
const textMessage = (body: unknown, response: Response): string | undefined => {
  if (typeof body !== 'string') return undefined

  const text = body.trim()
  const contentType = response.headers.get('content-type') ?? ''
  if (
    !text ||
    text.length > MAX_TEXT_MESSAGE_LENGTH ||
    text.startsWith('<') ||
    contentType.includes('html')
  ) {
    return undefined
  }
  return text
}

/**
 * Turns a failed response's parsed body into an `OoreApiError`. The raw body
 * stays on `cause`.
 */
export const toOoreApiError = (
  body: unknown,
  response: Response,
  request?: Request,
): OoreApiError => {
  if (body instanceof OoreApiError) return body

  const apiBody = isApiErrorBody(body) ? body : undefined
  const message =
    apiBody?.error ||
    textMessage(body, response) ||
    response.statusText ||
    `Oore request failed with status ${response.status}`

  return new OoreApiError(message, {
    cause: body,
    code: apiBody?.code,
    details: apiBody?.details,
    request,
    response,
  })
}

/**
 * Reads a body without Content-Type and labels it, so `parseAs: 'auto'`
 * returns JSON or text instead of a raw stream or `null`.
 */
const labelUntypedBody = async (response: Response): Promise<Response> => {
  if (
    !response.ok ||
    response.status === 204 ||
    response.headers.has('content-type') ||
    !response.body
  ) {
    return response
  }

  const text = await response.text()
  let contentType = 'text/plain'
  if (!text.trim()) {
    contentType = 'application/json'
  } else {
    try {
      JSON.parse(text)
      contentType = 'application/json'
    } catch {
      // Plain text.
    }
  }

  const headers = new Headers(response.headers)
  headers.set('content-type', contentType)
  if (!text.trim()) headers.set('content-length', '0')
  return new Response(text.trim() ? text : null, {
    headers,
    status: response.status,
    statusText: response.statusText,
  })
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

  client.interceptors.response.use((response, _request, requestOptions) =>
    requestOptions.parseAs === 'auto' ? labelUntypedBody(response) : response,
  )

  client.interceptors.error.use((error, response, request) => {
    if (!response || error instanceof OoreApiError) return error
    return toOoreApiError(error, response, request)
  })

  return client
}
