/**
 * The mapping language's type algebra (arch.md, "Type checking").
 *
 * Nullability is part of the type, so the pipeline compiler (not each op) implements null
 * short-circuiting. `Rel` (a collection) is deliberately not an `MType`: a record field can be
 * a list, never a collection.
 *
 * Three kinds exist only for the checker: `unit` is the input of a pipeline's first step,
 * `unknown` is a value nothing is known about (top), and `never` is the bottom type, used for
 * the element of `[]` and, as `t.null = nullable(never)`, for a literal `null`.
 */

import type { LogicalType } from '../schema'
import { err, ok, type Result } from './result'

export type NonNull =
  | { readonly kind: 'string' }
  | { readonly kind: 'number' }
  | { readonly kind: 'boolean' }
  | { readonly kind: 'date' }
  | { readonly kind: 'list'; readonly of: MType }
  | { readonly kind: 'tuple'; readonly of: readonly MType[] }
  | { readonly kind: 'record'; readonly fields: Readonly<Record<string, MType>> }
  | { readonly kind: 'unit' }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'never' }

export type NullableType = { readonly kind: 'nullable'; readonly of: NonNull }

export type MType = NonNull | NullableType

export type RecordType = Extract<NonNull, { kind: 'record' }>
export type ListType = Extract<NonNull, { kind: 'list' }>
export type TupleType = Extract<NonNull, { kind: 'tuple' }>

/** Type constructors. `t.nullable` flattens, so `nullable(nullable(x))` is `nullable(x)`. */
export const t = {
  string: { kind: 'string' },
  number: { kind: 'number' },
  boolean: { kind: 'boolean' },
  date: { kind: 'date' },
  unit: { kind: 'unit' },
  unknown: { kind: 'unknown' },
  never: { kind: 'never' },
  null: { kind: 'nullable', of: { kind: 'never' } },
  list: (of: MType): MType => ({ kind: 'list', of }),
  tuple: (of: readonly MType[]): MType => ({ kind: 'tuple', of }),
  record: (fields: Readonly<Record<string, MType>>): RecordType => ({ kind: 'record', fields }),
  nullable: (of: MType): MType => (of.kind === 'nullable' ? of : { kind: 'nullable', of }),
} as const satisfies Record<string, MType | ((...args: never[]) => MType)>

export function isNullable(type: MType): type is NullableType {
  return type.kind === 'nullable'
}

/** The type without its null. */
export function stripNull(type: MType): NonNull {
  return type.kind === 'nullable' ? type.of : type
}

/** Whether a value of this type can be null at runtime (`unknown` can be anything). */
export function mayBeNull(type: MType): boolean {
  return type.kind === 'nullable' || type.kind === 'unknown'
}

/** `nullable(x)` when `when` is true, else `x`. */
export function nullableIf(type: MType, when: boolean): MType {
  return when ? t.nullable(type) : type
}

/** Human-readable form used in every type error: `number?`, `list<string>`, `(number, string)`. */
export function show(type: MType): string {
  switch (type.kind) {
    case 'nullable':
      return type.of.kind === 'never' ? 'null' : `${show(type.of)}?`
    case 'list':
      return `list<${show(type.of)}>`
    case 'tuple':
      return `(${type.of.map(show).join(', ')})`
    case 'record':
      return `{ ${Object.entries(type.fields)
        .map(([k, v]) => `${k}: ${show(v)}`)
        .join(', ')} }`
    case 'unit':
      return '()'
    default:
      return type.kind
  }
}

export function equalTypes(a: MType, b: MType): boolean {
  return show(a) === show(b)
}

/** Can a value of type `from` be used where `to` is expected? */
export function assignable(from: MType, to: MType): boolean {
  if (to.kind === 'unknown') return true
  if (from.kind === 'never') return true
  if (from.kind === 'nullable') {
    return to.kind === 'nullable' && assignable(from.of, to.of)
  }
  if (to.kind === 'nullable') return assignable(from, to.of)
  switch (from.kind) {
    case 'list':
      return to.kind === 'list' && assignable(from.of, to.of)
    case 'tuple':
      return (
        to.kind === 'tuple' &&
        to.of.length === from.of.length &&
        from.of.every((f, i) => assignable(f, to.of[i] as MType))
      )
    case 'record':
      return (
        to.kind === 'record' &&
        Object.entries(to.fields).every(
          ([k, v]) => k in from.fields && assignable(from.fields[k] as MType, v),
        )
      )
    default:
      return from.kind === to.kind
  }
}

const SCALAR_KINDS = new Set(['string', 'number', 'boolean', 'date'])

/** Can values of these types be compared for equality (join keys, `eq`, `in`)? */
export function comparable(a: MType, b: MType): boolean {
  const x = stripNull(a)
  const y = stripNull(b)
  if (x.kind === 'unknown' || y.kind === 'unknown') return true
  if (x.kind === 'never' || y.kind === 'never') return true
  if (x.kind === 'list' && y.kind === 'list') return comparable(x.of, y.of)
  return SCALAR_KINDS.has(x.kind) && x.kind === y.kind
}

/** Can values of this type be ordered (`lt`, `min`, sorting)? */
export function orderable(type: MType): boolean {
  const kind = stripNull(type).kind
  return kind === 'number' || kind === 'date' || kind === 'string'
}

/**
 * The common type of two branches (`when` cases, `coalesce`, `union` inputs): equal modulo
 * nullability, nullable when either side is. `never` unifies with anything.
 */
export function unify(a: MType, b: MType): Result<MType, string> {
  const nullable = isNullable(a) || isNullable(b)
  const x = stripNull(a)
  const y = stripNull(b)
  const base = unifyNonNull(x, y)
  if (!base.ok) return base
  return ok(nullableIf(base.value, nullable))
}

function unifyNonNull(x: NonNull, y: NonNull): Result<MType, string> {
  const mismatch = () => err(`${show(x)} and ${show(y)} have no common type`)
  if (x.kind === 'never') return ok(y)
  if (y.kind === 'never') return ok(x)
  if (x.kind === 'unknown' || y.kind === 'unknown') return ok(t.unknown)
  if (x.kind === 'list' && y.kind === 'list') {
    const of = unify(x.of, y.of)
    return of.ok ? ok(t.list(of.value)) : mismatch()
  }
  if (x.kind === 'tuple' && y.kind === 'tuple') {
    if (x.of.length !== y.of.length) return mismatch()
    const of: MType[] = []
    for (const [i, a] of x.of.entries()) {
      const u = unify(a, y.of[i] as MType)
      if (!u.ok) return mismatch()
      of.push(u.value)
    }
    return ok(t.tuple(of))
  }
  if (x.kind === 'record' && y.kind === 'record') {
    const keys = Object.keys(x.fields)
    if (keys.length !== Object.keys(y.fields).length) return mismatch()
    const fields: Record<string, MType> = {}
    for (const k of keys) {
      const other = y.fields[k]
      if (!other) return mismatch()
      const u = unify(x.fields[k] as MType, other)
      if (!u.ok) return mismatch()
      fields[k] = u.value
    }
    return ok(t.record(fields))
  }
  return x.kind === y.kind ? ok(x) : mismatch()
}

/** Unify a non-empty list of types, left to right. */
export function unifyAll(types: readonly MType[]): Result<MType, string> {
  let acc: MType = t.never
  for (const type of types) {
    const u = unify(acc, type)
    if (!u.ok) return u
    acc = u.value
  }
  return ok(acc)
}

/** Static type of a JSON literal: `null` is `t.null`, `[]` is `list<never>`. */
export function typeOfJson(value: unknown): MType {
  if (value === null) return t.null
  switch (typeof value) {
    case 'string':
      return t.string
    case 'number':
      return t.number
    case 'boolean':
      return t.boolean
  }
  if (Array.isArray(value)) {
    const element = unifyAll(value.map(typeOfJson))
    return t.list(element.ok ? element.value : t.unknown)
  }
  if (typeof value === 'object') {
    return t.record(
      Object.fromEntries(Object.entries(value as object).map(([k, v]) => [k, typeOfJson(v)])),
    )
  }
  return t.unknown
}

/** A connector/target logical type as an `MType`. References are opaque ids. */
export function fromLogicalType(logical: LogicalType): NonNull {
  switch (logical) {
    case 'string':
      return t.string
    case 'integer':
    case 'decimal':
      return t.number
    case 'boolean':
      return t.boolean
    case 'date':
    case 'timestamp':
      return t.date
    default:
      return t.unknown
  }
}

/**
 * Parse a type name as written in `assert_type`: `string`, `number`, `boolean`, `date`,
 * `list<T>`, and a trailing `?` for nullable.
 */
export function parseTypeName(text: string): Result<MType, string> {
  const source = text.replace(/\s+/g, '')
  const parse = (s: string): MType | undefined => {
    if (s.endsWith('?')) {
      const inner = parse(s.slice(0, -1))
      return inner && inner.kind !== 'nullable' ? t.nullable(inner) : undefined
    }
    if (s.startsWith('list<') && s.endsWith('>')) {
      const inner = parse(s.slice(5, -1))
      return inner && t.list(inner)
    }
    switch (s) {
      case 'string':
        return t.string
      case 'number':
        return t.number
      case 'boolean':
        return t.boolean
      case 'date':
        return t.date
      default:
        return undefined
    }
  }
  const type = parse(source)
  return type ? ok(type) : err(`unknown type '${text}'`)
}

/** A type name already validated by `parseTypeName` (e.g. by a params schema). */
export function typeName(text: string): MType {
  const type = parseTypeName(text)
  if (!type.ok) throw new Error(type.error)
  return type.value
}
