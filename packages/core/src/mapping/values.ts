/**
 * Runtime values and the relations that carry them.
 *
 * A record is a plain frozen-by-convention object; an absent key reads as null (that is how
 * `omit_if_null` and `skip_field` leave a field out of a write). Nothing here depends on
 * insertion order: hashing and sorting go through `canonicalKey` and `compareVals`, so two
 * runs over the same snapshot produce identical output (arch.md, "Execution model").
 */

import { Instant } from './time'

export type Val =
  | null
  | string
  | number
  | boolean
  | Instant
  | readonly Val[]
  | { readonly [key: string]: Val }

export type Rec = Readonly<Record<string, Val>>

/** A collection: records of one record type, in no meaningful order. */
export type Relation = readonly Rec[]

/** JSON as stored in a version (params, tables, literals, fixtures). */
export type Json =
  | null
  | string
  | number
  | boolean
  | readonly Json[]
  | { readonly [key: string]: Json }

/** Returned by a step to leave its field out of the record entirely (`omit_if_null`). */
export const OMIT: unique symbol = Symbol('omit')
export type Omitted = typeof OMIT

export function isRecordVal(v: Val): v is { readonly [key: string]: Val } {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Instant)
}

/** A string that is equal for equal values, used for hashing (joins, distinct, union, groups). */
export function canonicalKey(v: Val): string {
  if (v === null) return 'n'
  switch (typeof v) {
    case 'string':
      return `s${JSON.stringify(v)}`
    case 'number':
      return `d${Object.is(v, -0) ? 0 : v}`
    case 'boolean':
      return v ? 't' : 'f'
  }
  if (v instanceof Instant) return `i${v.epochMs}`
  if (Array.isArray(v)) return `[${(v as readonly Val[]).map(canonicalKey).join(',')}]`
  const rec = v as { readonly [key: string]: Val }
  return `{${Object.keys(rec)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalKey(rec[k] as Val)}`)
    .join(',')}}`
}

/** Canonical key of a tuple of fields of a record; absent fields count as null. */
export function keyOf(rec: Rec, fields: readonly string[]): string {
  return canonicalKey(fields.map((f) => rec[f] ?? null))
}

const rank = (v: Val): number => {
  if (v === null) return 0
  switch (typeof v) {
    case 'boolean':
      return 1
    case 'number':
      return 2
    case 'string':
      return 3
  }
  if (v instanceof Instant) return 4
  return Array.isArray(v) ? 5 : 6
}

/**
 * A total order over values: null first, then booleans, numbers, strings (by UTF-16 code
 * unit, never locale), dates, lists (lexicographic), records (by canonical key).
 */
export function compareVals(a: Val, b: Val): number {
  const ra = rank(a)
  const rb = rank(b)
  if (ra !== rb) return ra - rb
  switch (ra) {
    case 0:
      return 0
    case 1:
    case 2:
      return Number(a) - Number(b)
    case 3:
      return a === b ? 0 : (a as string) < (b as string) ? -1 : 1
    case 4:
      return (a as Instant).epochMs - (b as Instant).epochMs
    case 5: {
      const x = a as readonly Val[]
      const y = b as readonly Val[]
      for (let i = 0; i < Math.min(x.length, y.length); i++) {
        const c = compareVals(x[i] as Val, y[i] as Val)
        if (c !== 0) return c
      }
      return x.length - y.length
    }
    default: {
      const x = canonicalKey(a)
      const y = canonicalKey(b)
      return x === y ? 0 : x < y ? -1 : 1
    }
  }
}

export function valEquals(a: Val, b: Val): boolean {
  return compareVals(a, b) === 0
}

/** Values as JSON: dates become ISO strings. For fixtures, metrics and diagnostics. */
export function toJson(v: Val): Json {
  if (v instanceof Instant) return v.toISOString()
  if (Array.isArray(v)) return (v as readonly Val[]).map(toJson)
  if (isRecordVal(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toJson(x)]))
  return v as Json
}

/** Sort records by the values of `fields`, ties by whole-record canonical key. */
export function sortRecords(rows: readonly Rec[], fields: readonly string[]): Rec[] {
  return [...rows].sort((a, b) => {
    for (const f of fields) {
      const c = compareVals(a[f] ?? null, b[f] ?? null)
      if (c !== 0) return c
    }
    const x = canonicalKey(a)
    const y = canonicalKey(b)
    return x === y ? 0 : x < y ? -1 : 1
  })
}
