/**
 * The testbench, per mapping: the rows fed to each source and the last run. The Testbench
 * view and the agent's `run_testbench` tool share both, so each sees what the other ran.
 * Feeds persist in localStorage; the last run, and the one before it, live in memory.
 */

import {
  type CompileIssue,
  compileVersion,
  execute,
  type MappingVersion,
  type NodeJson,
  type RunResult,
  type TargetSchema,
} from '@hockeymask/core'
import { useSyncExternalStore } from 'react'
import { readJson, writeJson } from './store'

export type DataRow = Record<string, unknown>

/** JSON text of the rows fed to each source, by source node id. */
export type Feeds = Record<string, string>

export interface Run {
  /** Problems that stopped the run before it started: feeds, compile issues. */
  errors: string[]
  result: RunResult | null
}

export interface Bench {
  feeds: Feeds
  run: Run | null
  /** The last run with a result before `run`: what the delta view compares against. */
  previous: Run | null
}

export const sourcesOf = (version: MappingVersion) => version.nodes.filter((n) => n.op === 'source')

/** One row per line: thousands of sample rows stay scannable, and small enough to persist. */
export const rowsJson = (rows: readonly DataRow[]) =>
  rows.length === 0 ? '[]' : `[\n${rows.map((r) => `  ${JSON.stringify(r)}`).join(',\n')}\n]`

/** A JSON array of objects, or one object; blank text is no rows. */
export function parseRows(json: string | undefined): DataRow[] {
  if (!json?.trim()) return []
  const value: unknown = JSON.parse(json)
  const rows = Array.isArray(value) ? value : [value]
  if (!rows.every((r) => r !== null && typeof r === 'object' && !Array.isArray(r))) {
    throw new Error('expected an object or an array of objects')
  }
  return rows as DataRow[]
}

/** How many rows a feed holds, or the reason it cannot be read. */
export function feedStatus(json: string | undefined): { rows: number } | { error: string } {
  try {
    return { rows: parseRows(json).length }
  } catch (error) {
    return { error: (error as Error).message }
  }
}

const located = (issue: CompileIssue) =>
  [issue.node, issue.field].filter(Boolean).join(' · ') + (issue.node ? ': ' : '') + issue.message

const nameOf = (node: NodeJson) => node.label ?? node.id

/** Feed each source its rows and run the mapping engine on them. */
export function runFeeds(
  version: MappingVersion,
  feeds: Feeds,
  targets: TargetSchema | undefined,
  now: Date = new Date(),
): Run {
  const errors: string[] = []
  const snapshot: Record<string, DataRow[]> = {}
  for (const node of sourcesOf(version)) {
    try {
      snapshot[node.id] = parseRows(feeds[node.id])
    } catch (error) {
      snapshot[node.id] = []
      errors.push(`${nameOf(node)}: invalid JSON (${(error as Error).message}).`)
    }
  }
  if (!targets) {
    return { errors: [...errors, 'The target model is not loaded yet.'], result: null }
  }
  const compiled = compileVersion(version, { targets })
  if (!compiled.ok) return { errors: [...errors, ...compiled.issues.map(located)], result: null }
  try {
    const result = execute(
      compiled.plan,
      snapshot,
      { now: now.toISOString() },
      { retain: true, fixture: true },
    )
    return { errors, result }
  } catch (error) {
    return { errors: [...errors, (error as Error).message], result: null }
  }
}

const storageKey = (graphId: string) => `hockeymask.testbench.feeds.${graphId}`
const benches = new Map<string, Bench>()
const listeners = new Set<() => void>()

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getBench(graphId: string): Bench {
  let bench = benches.get(graphId)
  if (!bench) {
    bench = { feeds: readJson<Feeds>(storageKey(graphId), {}), run: null, previous: null }
    benches.set(graphId, bench)
  }
  return bench
}

/** Update feeds or record a run; a new run makes the last one with a result the baseline. */
export function setBench(graphId: string, patch: Partial<Pick<Bench, 'feeds' | 'run'>>): void {
  const bench = getBench(graphId)
  const previous = patch.run && bench.run?.result ? bench.run : bench.previous
  const next = { ...bench, ...patch, previous }
  benches.set(graphId, next)
  if (patch.feeds) writeJson(storageKey(graphId), patch.feeds)
  for (const listener of listeners) listener()
}

/** Replace some sources' rows, keeping the rest; reads the store, so async callers stay current. */
export function setFeeds(graphId: string, feeds: Feeds): void {
  setBench(graphId, { feeds: { ...getBench(graphId).feeds, ...feeds } })
}

export function useBench(graphId: string): Bench {
  return useSyncExternalStore(subscribe, () => getBench(graphId))
}
