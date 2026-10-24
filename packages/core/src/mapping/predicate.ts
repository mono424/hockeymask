/**
 * The one predicate vocabulary, shared by `when`, `filter_list`, the `filter` node, join
 * `where`, aggregate `where`, and `rows` expectations.
 *
 * Shape: `{ path?, <predicate>: operand }` with exactly one predicate key, or a composition
 * `{ all: { of: [...] } }`, `{ any: { of: [...] } }`, `{ not: cond }`. Without `path` the
 * predicate tests the piped value. An operand is a literal, `{ ref: field }` or
 * `{ param: name }`.
 *
 * Null never compares: ordering and equality with a null side are false, `neq` and `not_in`
 * are their negations and so hold for null (arch.md, "Null semantics").
 */

import { fieldType, type RecordEnv, type RunContext } from './context'
import { err, ok, type Result } from './result'
import { type DateExpr, Instant, parseDateExpr, resolveDateExpr, usesClock } from './time'
import { comparable, type MType, orderable, show, stripNull, t, typeOfJson } from './types'
import { compareVals, type Json, type Rec, type Val } from './values'

export type Test = (piped: Val, record: Rec, ctx: RunContext) => boolean

const COMPARISONS = ['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'before', 'after'] as const
const MEMBERSHIP = ['in', 'not_in'] as const
const PRESENCE = ['is_null', 'is_blank'] as const
const COMPOSITION = ['all', 'any', 'not'] as const

/** Every predicate name; the `if_<name>` sugar is derived from the non-composite ones. */
export const PREDICATES = [
  ...COMPARISONS,
  ...MEMBERSHIP,
  'matches',
  ...PRESENCE,
  ...COMPOSITION,
] as const
export type PredicateName = (typeof PREDICATES)[number]

/** Predicate JSON, loosely typed: validated by `compilePredicate`. */
export type Predicate = { readonly [key: string]: unknown }

export type Getter = (piped: Val, record: Rec, ctx: RunContext) => Val

export interface Operand {
  readonly type: MType
  readonly get: Getter
}

/**
 * Compile a predicate. `piped` is the type of the piped value, or undefined where there is
 * none (`filter`, join `where`, aggregate `where`), in which case `path` is required.
 */
export function compilePredicate(
  raw: unknown,
  env: RecordEnv,
  piped?: MType,
): Result<Test, string> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return err('a condition must be an object such as { "eq": 1 }')
  }
  const cond = raw as Predicate
  const keys = Object.keys(cond).filter((k) => k !== 'path')
  if (keys.length !== 1) {
    return err(
      `a condition needs exactly one predicate, got ${keys.length ? keys.join(', ') : 'none'}`,
    )
  }
  const name = keys[0] as string
  if (!(PREDICATES as readonly string[]).includes(name)) return err(`unknown predicate '${name}'`)
  const value = cond[name]

  if ((COMPOSITION as readonly string[]).includes(name)) {
    if ('path' in cond) return err(`'${name}' does not take a path; put paths on its conditions`)
    return compileComposition(name as (typeof COMPOSITION)[number], value, env, piped)
  }

  const subject = compileSubject(cond.path, env, piped)
  if (!subject.ok) return subject
  const { type, get } = subject.value
  const base = stripNull(type)

  switch (name) {
    case 'is_null':
    case 'is_blank': {
      if (typeof value !== 'boolean') return err(`'${name}' takes true or false`)
      if (name === 'is_blank' && base.kind !== 'string' && base.kind !== 'unknown') {
        return err(`is_blank applies to strings, not ${show(type)}`)
      }
      const blank =
        name === 'is_null'
          ? (v: Val) => v === null
          : (v: Val) => v === null || (typeof v === 'string' && v.trim() === '')
      return ok((p, r, c) => blank(get(p, r, c)) === value)
    }
    case 'matches': {
      if (typeof value !== 'string') return err('matches takes a regular expression string')
      if (base.kind !== 'string' && base.kind !== 'unknown') {
        return err(`matches applies to strings, not ${show(type)}`)
      }
      const regex = compileRegex(value)
      if (!regex.ok) return regex
      const re = regex.value
      return ok((p, r, c) => {
        const v = get(p, r, c)
        return typeof v === 'string' && re.test(v)
      })
    }
    case 'in':
    case 'not_in': {
      const operand = compileOperand(value, env, base.kind === 'date')
      if (!operand.ok) return operand
      const listType = stripNull(operand.value.type)
      if (listType.kind !== 'list')
        return err(`'${name}' takes a list, got ${show(operand.value.type)}`)
      if (!comparable(type, listType.of)) {
        return err(`cannot test ${show(type)} for membership in ${show(listType)}`)
      }
      const list = operand.value.get
      const member: Test = (p, r, c) => {
        const v = get(p, r, c)
        const values = list(p, r, c)
        if (v === null || !Array.isArray(values)) return false
        return (values as readonly Val[]).some((x) => x !== null && compareVals(v, x) === 0)
      }
      return ok(name === 'in' ? member : (p, r, c) => !member(p, r, c))
    }
  }

  // Comparisons.
  const isDate = name === 'before' || name === 'after'
  if (isDate && base.kind !== 'date' && base.kind !== 'unknown') {
    return err(`'${name}' applies to dates, not ${show(type)}`)
  }
  if (!isDate && name !== 'eq' && name !== 'neq' && !orderable(base) && base.kind !== 'unknown') {
    return err(`'${name}' applies to numbers, strings and dates, not ${show(type)}`)
  }
  if (value === null) return err(`'${name}' cannot compare with null; use is_null`)
  const operand = compileOperand(value, env, base.kind === 'date' || isDate)
  if (!operand.ok) return operand
  if (!comparable(type, operand.value.type)) {
    return err(`cannot compare ${show(type)} with ${show(operand.value.type)}`)
  }
  const other = operand.value.get
  const test = COMPARE[name as (typeof COMPARISONS)[number]]
  return ok((p, r, c) => {
    const a = get(p, r, c)
    const b = other(p, r, c)
    const holds = a !== null && b !== null && test(compareVals(a, b))
    return name === 'neq' ? !holds : holds
  })
}

const COMPARE: Record<(typeof COMPARISONS)[number], (c: number) => boolean> = {
  eq: (c) => c === 0,
  neq: (c) => c === 0, // negated by the caller, so null sides make `neq` true
  lt: (c) => c < 0,
  lte: (c) => c <= 0,
  gt: (c) => c > 0,
  gte: (c) => c >= 0,
  before: (c) => c < 0,
  after: (c) => c > 0,
}

function compileComposition(
  name: (typeof COMPOSITION)[number],
  value: unknown,
  env: RecordEnv,
  piped: MType | undefined,
): Result<Test, string> {
  if (name === 'not') {
    const inner = compilePredicate(value, env, piped)
    if (!inner.ok) return inner
    const test = inner.value
    return ok((p, r, c) => !test(p, r, c))
  }
  const of = (value as { of?: unknown } | null)?.of
  if (
    typeof value !== 'object' ||
    value === null ||
    Object.keys(value).length !== 1 ||
    !Array.isArray(of)
  ) {
    return err(`'${name}' takes { "of": [conditions] }`)
  }
  const tests: Test[] = []
  for (const [i, c] of of.entries()) {
    const compiled = compilePredicate(c, env, piped)
    if (!compiled.ok) return err(`${name}.of[${i}]: ${compiled.error}`)
    tests.push(compiled.value)
  }
  return ok(
    name === 'all'
      ? (p, r, c) => tests.every((x) => x(p, r, c))
      : (p, r, c) => tests.some((x) => x(p, r, c)),
  )
}

function compileSubject(
  path: unknown,
  env: RecordEnv,
  piped: MType | undefined,
): Result<{ type: MType; get: Getter }, string> {
  if (path !== undefined) {
    if (typeof path !== 'string') return err('path must be a field name')
    const type = fieldType(env.record, path)
    if (!type.ok) return type
    return ok({ type: type.value, get: (_p, r) => r[path] ?? null })
  }
  if (!piped || piped.kind === 'unit') {
    return err('this condition has no piped value to test; give it a "path"')
  }
  return ok({ type: piped, get: (p) => p })
}

/** Literal, `{ ref }` or `{ param }`. Strings compared with a date are date expressions. */
export function compileOperand(
  value: unknown,
  env: RecordEnv,
  asDate: boolean,
): Result<Operand, string> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const keys = Object.keys(value)
    const o = value as { ref?: unknown; param?: unknown }
    if (keys.length === 1 && typeof o.ref === 'string') {
      const ref = o.ref
      const type = fieldType(env.record, ref)
      if (!type.ok) return type
      return ok({ type: type.value, get: (_p, r) => r[ref] ?? null })
    }
    if (keys.length === 1 && typeof o.param === 'string') {
      const name = o.param
      if (!Object.hasOwn(env.params, name)) return err(`unknown param '${name}'`)
      return literal(env.params[name] as Json, env, asDate)
    }
    return err('a comparison value is a literal, { "ref": field } or { "param": name }')
  }
  return literal(value as Json, env, asDate)
}

function literal(value: Json, env: RecordEnv, asDate: boolean): Result<Operand, string> {
  if (asDate && typeof value === 'string') {
    const expr = parseDateExpr(value)
    if (!expr.ok) return expr
    if (usesClock(expr.value)) env.clock.used = true
    return ok({ type: t.date, get: dateGetter(expr.value) })
  }
  if (asDate && Array.isArray(value) && value.every((v) => typeof v === 'string')) {
    const exprs: DateExpr[] = []
    for (const v of value as string[]) {
      const expr = parseDateExpr(v)
      if (!expr.ok) return expr
      if (usesClock(expr.value)) env.clock.used = true
      exprs.push(expr.value)
    }
    const getters = exprs.map(dateGetter)
    return ok({ type: t.list(t.date), get: (p, r, c) => getters.map((g) => g(p, r, c)) })
  }
  const constant = value as Val
  return ok({ type: typeOfJson(value), get: () => constant })
}

/** Resolve a date expression against the run clock, once per distinct clock. */
function dateGetter(expr: DateExpr): Getter {
  let key = ''
  let cached: Instant = Instant.ofEpochMs(0)
  return (_p, _r, ctx) => {
    const k = `${ctx.now.epochMs}|${ctx.tz}`
    if (k !== key) {
      cached = resolveDateExpr(expr, ctx)
      key = k
    }
    return cached
  }
}

export function compileRegex(pattern: string): Result<RegExp, string> {
  try {
    return ok(new RegExp(pattern, 'u'))
  } catch (e) {
    return err(`invalid regular expression: ${(e as Error).message}`)
  }
}

/**
 * Fields a passing record is known to have non-null: `{ path, is_null: false }` at the top
 * level or inside `all`. The `filter` node narrows its output type with these.
 */
export function nonNullPaths(raw: unknown): string[] {
  if (typeof raw !== 'object' || raw === null) return []
  const cond = raw as Predicate
  if (typeof cond.path === 'string' && cond.is_null === false) return [cond.path]
  const of = (cond.all as { of?: unknown } | undefined)?.of
  return Array.isArray(of) ? of.flatMap(nonNullPaths) : []
}
