/**
 * The one place the app touches localStorage. Every access is wrapped: storage can be
 * full, disabled or absent (private windows), and the app must still work in memory.
 */

import { useCallback, useState, useSyncExternalStore } from 'react'
import type { GraphRef, Integration } from './integrations'

const KEY = 'hockeymask.integrations.v1'

export interface Selection {
  integrationId: string | null
  graphId: string | null
}

export interface State {
  integrations: Integration[]
  selection: Selection
}

const EMPTY: State = { integrations: [], selection: { integrationId: null, graphId: null } }

export function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = globalThis.localStorage?.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

export function writeJson(key: string, value: unknown): void {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value))
  } catch {
    // in-memory state still works for this session
  }
}

let state: State = readJson(KEY, EMPTY)
const listeners = new Set<() => void>()

function update(next: State): void {
  state = next
  writeJson(KEY, next)
  for (const listener of listeners) listener()
}

export function getState(): State {
  return state
}

export function useStore(): State {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => state,
  )
}

export function addIntegration(integration: Integration): void {
  update({
    integrations: [...state.integrations, integration],
    selection: { integrationId: integration.id, graphId: integration.graphs[0]?.id ?? null },
  })
}

/** Drops the integration from the list; its graph documents stay on the server. */
export function removeIntegration(id: string): void {
  const integrations = state.integrations.filter((i) => i.id !== id)
  const next = state.selection.integrationId === id ? integrations[0] : undefined
  update({
    integrations,
    selection: next
      ? { integrationId: next.id, graphId: next.graphs[0]?.id ?? null }
      : state.selection.integrationId === id
        ? { integrationId: null, graphId: null }
        : state.selection,
  })
}

export function addGraph(integrationId: string, graph: GraphRef): void {
  update({
    integrations: state.integrations.map((i) =>
      i.id === integrationId ? { ...i, graphs: [...i.graphs, graph] } : i,
    ),
    selection: { integrationId, graphId: graph.id },
  })
}

/** Renames the mapping in its integration's list; its id, and so its document, stay. */
export function renameGraph(graphId: string, name: string): void {
  update({
    ...state,
    integrations: state.integrations.map((i) => ({
      ...i,
      graphs: i.graphs.map((g) => (g.id === graphId ? { ...g, name } : g)),
    })),
  })
}

/** Drops the mapping from its integration; the caller deletes its graph document. */
export function removeGraph(graphId: string): void {
  const integrations = state.integrations.map((i) => ({
    ...i,
    graphs: i.graphs.filter((g) => g.id !== graphId),
  }))
  const { selection } = state
  const owner = integrations.find((i) => i.id === selection.integrationId)
  update({
    integrations,
    selection:
      selection.graphId === graphId
        ? { ...selection, graphId: owner?.graphs[0]?.id ?? null }
        : selection,
  })
}

/** What is open: the selected integration and mapping, else the first of each. */
export function openMapping({ integrations, selection }: State): {
  integration: Integration | null
  graph: GraphRef | null
} {
  const integration =
    integrations.find((i) => i.id === selection.integrationId) ?? integrations[0] ?? null
  const graph =
    integration?.graphs.find((g) => g.id === selection.graphId) ?? integration?.graphs[0] ?? null
  return { integration, graph }
}

export function select(selection: Partial<Selection>): void {
  update({ ...state, selection: { ...state.selection, ...selection } })
}

/** useState that survives reloads, under its own localStorage key. */
export function usePersistentState<T>(key: string, initial: () => T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => readJson(key, initial()))
  const set = useCallback(
    (next: T) => {
      setValue(next)
      writeJson(key, next)
    },
    [key],
  )
  return [value, set]
}
