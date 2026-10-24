/**
 * What changed between two runs' rows of one sink. Rows are matched by their identifier (the
 * sink's upsert key), so a row whose values changed is one changed row, not a removal plus an
 * addition. Without a key a row is identified by all of its values.
 */

import type { DataRow } from './testbench'

export type RowChange = 'added' | 'removed' | 'changed' | 'same'

export interface DeltaRow {
  row: DataRow
  change: RowChange
  /** The earlier row of a changed one. */
  before?: DataRow
  /** Fields whose value differs from `before`. */
  fields?: string[]
}

export interface Delta {
  /** Added and changed rows in run order, then removed ones, then the unchanged. */
  rows: DeltaRow[]
  added: number
  removed: number
  changed: number
}

/** JSON with object keys sorted, so equal values compare equal. */
const stable = (value: unknown): string =>
  JSON.stringify(value ?? null, (_, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  )

/** Identifiers in row order; a repeated identifier gets its occurrence, so duplicates pair up. */
function identify(rows: readonly DataRow[], key: readonly string[]): string[] {
  const seen = new Map<string, number>()
  return rows.map((row) => {
    const id = key.length > 0 ? stable(key.map((k) => row[k])) : stable(row)
    const n = seen.get(id) ?? 0
    seen.set(id, n + 1)
    return `${id}#${n}`
  })
}

export function diffRows(
  before: readonly DataRow[],
  after: readonly DataRow[],
  key: readonly string[],
): Delta {
  const earlier = new Map<string, DataRow>()
  identify(before, key).forEach((id, i) => earlier.set(id, before[i] as DataRow))

  const changes: DeltaRow[] = []
  const same: DeltaRow[] = []
  let added = 0
  let changed = 0
  identify(after, key).forEach((id, i) => {
    const row = after[i] as DataRow
    const old = earlier.get(id)
    earlier.delete(id)
    if (!old) {
      added += 1
      changes.push({ row, change: 'added' })
      return
    }
    const names = [...new Set([...Object.keys(old), ...Object.keys(row)])]
    const fields = names.filter((f) => stable(old[f]) !== stable(row[f]))
    if (fields.length === 0) same.push({ row, change: 'same' })
    else {
      changed += 1
      changes.push({ row, change: 'changed', before: old, fields })
    }
  })
  const removed = [...earlier.values()].map((row): DeltaRow => ({ row, change: 'removed' }))
  return {
    rows: [...changes, ...removed, ...same],
    added,
    removed: removed.length,
    changed,
  }
}
