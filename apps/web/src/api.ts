/** Typed client for the demo API, plus TanStack Query hooks per resource. */

import type {
  CompileIssue,
  MappingVersion,
  RowSet,
  Table,
  TableRef,
  TargetEntity,
  TargetSchema,
} from '@hockeymask/core'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { queryClient } from './lib/query'

export type ServiceStatus = 'ok' | 'unreachable'

export interface Health {
  status: 'ok'
  database: 'ok' | 'error'
  sources: Record<string, ServiceStatus>
}

export interface Source {
  key: string
  system: string
  dialect: string
  baseUrl: string
  description: string
  status: ServiceStatus
}

export interface GraphRecord {
  id: string
  graph: MappingVersion
  issues: CompileIssue[]
  updatedAt: string
}

/** A target entity as the schema page edits it. */
export interface EntityRecord {
  entity: TargetEntity
  /** Replaced on the schema page, rather than derived from its table. */
  edited: boolean
}

/** Statuses the Vite dev proxy answers with when the API process is not running. */
const GATEWAY = new Set([502, 503, 504])

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
    /** The API itself could not be reached, as opposed to rejecting the request. */
    readonly unreachable = false,
  ) {
    super(detail)
    this.name = 'ApiError'
  }
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>

export async function request<T>(
  path: string,
  init: RequestInit = {},
  fetchImpl: Fetch = (input, i) => fetch(input, i),
): Promise<T> {
  let response: Response
  try {
    response = await fetchImpl(`/api${path}`, {
      ...init,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    })
  } catch {
    throw new ApiError(0, 'The demo API is not reachable.', true)
  }
  const text = await response.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = null
  }
  if (!response.ok) {
    const unreachable = GATEWAY.has(response.status) || (response.status === 500 && body === null)
    const sent = (body as { detail?: unknown } | null)?.detail
    const detail =
      typeof sent === 'string'
        ? sent
        : unreachable
          ? 'The demo API is not reachable.'
          : `Request failed (${response.status}).`
    throw new ApiError(response.status, detail, unreachable)
  }
  return body as T
}

const enc = encodeURIComponent

export const api = {
  health: () => request<Health>('/health'),
  sources: () => request<Source[]>('/sources'),
  tables: (source: string) => request<TableRef[]>(`/sources/${enc(source)}/tables`),
  table: (source: string, table: string) =>
    request<Table>(`/sources/${enc(source)}/tables/${enc(table)}`),
  sample: (source: string, table: string, limit: number) =>
    request<RowSet>(`/sources/${enc(source)}/tables/${enc(table)}/sample?limit=${limit}`),
  targetSchema: () => request<TargetSchema>('/target/schema'),
  targetEntities: () => request<EntityRecord[]>('/target/entities'),
  saveTargetEntity: (name: string, entity: unknown) =>
    request<EntityRecord>(`/target/entities/${enc(name)}`, {
      method: 'PUT',
      body: JSON.stringify(entity),
    }),
  resetTargetEntity: (name: string) =>
    request<EntityRecord>(`/target/entities/${enc(name)}`, { method: 'DELETE' }),
  graph: (id: string) => request<GraphRecord>(`/graphs/${enc(id)}`),
  saveGraph: (id: string, graph: MappingVersion) =>
    request<GraphRecord>(`/graphs/${enc(id)}`, { method: 'PUT', body: JSON.stringify({ graph }) }),
  renameGraph: (id: string, name: string) =>
    request<GraphRecord>(`/graphs/${enc(id)}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
  deleteGraph: (id: string) => request<null>(`/graphs/${enc(id)}`, { method: 'DELETE' }),
  /** Answer one of the agent's tool calls. */
  answerTool: (toolCallId: string, answer: { output: unknown } | { error: string }) =>
    request<null>(`/agent/tools/${enc(toolCallId)}`, {
      method: 'POST',
      body: JSON.stringify(answer),
    }),
}

/** The same requests through the query cache, for code outside components (the agent's tools). */
export const cached = {
  tables: (source: string) =>
    queryClient.fetchQuery({ queryKey: ['tables', source], queryFn: () => api.tables(source) }),
  table: (source: string, table: string) =>
    queryClient.fetchQuery({
      queryKey: ['table', source, table],
      queryFn: () => api.table(source, table),
    }),
  targetSchema: () =>
    queryClient.fetchQuery({
      queryKey: ['target'],
      queryFn: api.targetSchema,
      staleTime: Number.POSITIVE_INFINITY,
    }),
  graph: (id: string) =>
    queryClient.fetchQuery({ queryKey: ['graph', id], queryFn: () => api.graph(id), retry: false }),
}

export const useHealth = () =>
  useQuery({ queryKey: ['health'], queryFn: api.health, refetchInterval: 15_000, retry: false })
export const useSources = () => useQuery({ queryKey: ['sources'], queryFn: api.sources })
export const useTables = (source: string | undefined) =>
  useQuery({
    queryKey: ['tables', source],
    queryFn: () => api.tables(source ?? ''),
    enabled: Boolean(source),
  })
export const useTable = (source: string, table: string) =>
  useQuery({ queryKey: ['table', source, table], queryFn: () => api.table(source, table) })
export const useTargetSchema = () =>
  useQuery({ queryKey: ['target'], queryFn: api.targetSchema, staleTime: Number.POSITIVE_INFINITY })
export const useGraph = (id: string) =>
  useQuery({ queryKey: ['graph', id], queryFn: () => api.graph(id), retry: false })

export function useSaveGraph(id: string) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (graph: MappingVersion) => api.saveGraph(id, graph),
    onSuccess: (saved) => client.setQueryData(['graph', id], saved),
  })
}

export const useTargetEntities = () =>
  useQuery({ queryKey: ['target-entities'], queryFn: api.targetEntities })

/** Saves an entity, or with `entity: null` resets it; what is checked against it refetches. */
export function useEditTargetEntity() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ name, entity }: { name: string; entity: unknown }) =>
      entity === null ? api.resetTargetEntity(name) : api.saveTargetEntity(name, entity),
    onSuccess: () =>
      Promise.all(
        ['target', 'target-entities', 'graph'].map((key) =>
          client.invalidateQueries({ queryKey: [key] }),
        ),
      ),
  })
}
