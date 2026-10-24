/** HTTP plumbing shared by the demo connectors: fetch + JSON with the connector error semantics. */

import { ConnectorError, SourceUnavailable } from '@hockeymask/core'

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface HttpOptions {
  baseUrl: string
  token?: string
  /** Injected for tests and in-process wiring; defaults to the global fetch. */
  fetch?: FetchLike
  timeoutMs?: number
}

/** fetch + JSON with the connector error semantics. */
export async function requestJson(
  system: string,
  options: HttpOptions,
  path: string,
  init: { method: 'GET' | 'POST'; headers?: Record<string, string>; body?: string },
  errorMessage: (status: number, body: unknown) => string,
): Promise<{ status: number; body: unknown }> {
  const doFetch = options.fetch ?? ((input, i) => fetch(input, i))
  let response: Response
  try {
    response = await doFetch(new URL(path, options.baseUrl).toString(), {
      ...init,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${options.token ?? 'demo'}`,
        ...init.headers,
      },
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    })
  } catch (error) {
    throw new SourceUnavailable(`${system} is unreachable: ${(error as Error).message}`)
  }
  const text = await response.text()
  let body: unknown = text
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    // keep the raw text for the error message
  }
  if (response.status >= 400) throw new ConnectorError(errorMessage(response.status, body))
  return { status: response.status, body }
}

export const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/
