/**
 * Node expectations and the action building blocks (arch.md, "Failure policy and
 * partial results"), shared by the version's `expect` block and `assert` nodes.
 *
 * Every clause is detected on the node's raw output first; then `drop_rows` removes the
 * rows it names, then `set_null` / `set_default` repair the remaining violating rows. So
 * the order clauses are written in never matters. Every breach is reported as an issue,
 * whatever its action.
 */

import type { RecordEnv, RunContext } from './context'
import type { Action, ActionSpec, Bound, Clause, NodeExpectation } from './document'
import type { NodeIssue, NodeOutput, RunIssue } from './nodes/def'
import { compilePredicate, type Test } from './predicate'
import { err, ok, type Result } from './result'
import {
  assignable,
  comparable,
  type MType,
  type RecordType,
  show,
  stripNull,
  t,
  typeOfJson,
} from './types'
import { type Json, keyOf, type Rec, type Relation, toJson, type Val } from './values'

type ActionName = 'alert' | 'drop_rows' | 'set_null' | 'set_default' | 'skip_downstream' | 'stop'

const VALID: Readonly<Record<Clause | 'acyclic', readonly ActionName[]>> = {
  count: ['alert', 'skip_downstream', 'stop'],
  unique: ['alert', 'drop_rows', 'skip_downstream', 'stop'],
  keyed: ['alert', 'skip_downstream', 'stop'],
  rows: ['alert', 'drop_rows', 'set_null', 'set_default', 'skip_downstream', 'stop'],
  acyclic: ['alert', 'skip_downstream', 'stop'],
}

export function actionName(action: Action): ActionName {
  if (typeof action === 'string') return action
  return 'set_null' in action ? 'set_null' : 'set_default'
}

/** Precedence: a bound's own action, then the clause's, then `default`, then the plain spec. */
export function resolveAction(spec: ActionSpec | undefined, clause: Clause, own?: Action): Action {
  if (own !== undefined) return own
  if (spec === undefined) return 'alert'
  if (typeof spec === 'string' || 'set_null' in spec || 'set_default' in spec) return spec as Action
  const keyed = spec as Partial<Record<Clause | 'default', Action>>
  return keyed[clause] ?? keyed.default ?? 'alert'
}

/** Check an action fits its check and the output type; returns the repaired output type. */
export function checkAction(
  action: Action,
  check: Clause | 'acyclic',
  output: NodeOutput,
): Result<NodeOutput, string> {
  const name = actionName(action)
  if (!VALID[check].includes(name)) return err(`action ${name} does not apply to ${check}`)
  if (typeof action === 'string') return ok(output)
  const fields = 'set_null' in action ? action.set_null : Object.keys(action.set_default)
  const unknown = fields.filter((f) => !Object.hasOwn(output.type.fields, f))
  if (unknown.length) return err(`${name} names unknown fields: ${unknown.join(', ')}`)
  if ('set_default' in action) {
    for (const [f, v] of Object.entries(action.set_default)) {
      const type = output.type.fields[f] as MType
      if (v === null || !assignable(typeOfJson(v), stripNull(type))) {
        return err(`set_default ${f}: ${JSON.stringify(v)} is not a ${show(stripNull(type))}`)
      }
    }
    return ok(output)
  }
  // set_null widens the repaired fields, so every consumer is checked against nulls there.
  const widened = { ...output.type.fields }
  for (const f of action.set_null) widened[f] = t.nullable(widened[f] as MType)
  return ok({ ...output, type: t.record(widened) })
}

export interface Violation {
  readonly clause: string
  readonly action: Action
  readonly message: string
  readonly count: number
  readonly samples: readonly Json[]
  /** Positions of the violating rows, for row actions. */
  readonly rows?: readonly number[]
}

export interface Outcome {
  readonly rows: Relation
  readonly changed: number
  readonly issues: readonly RunIssue[]
  readonly stop: boolean
  readonly skipDownstream: boolean
}

/** Apply the actions of the detected violations to `rows`, reporting each as an issue. */
export function applyViolations(
  node: string,
  code: string,
  rows: Relation,
  violations: readonly Violation[],
): Outcome {
  const dropped = new Set<number>()
  for (const v of violations) {
    if (actionName(v.action) === 'drop_rows') for (const i of v.rows ?? []) dropped.add(i)
  }
  const patches = new Map<number, Record<string, Val>>()
  for (const v of violations) {
    if (typeof v.action === 'string') continue
    const patch: Record<string, Val> =
      'set_null' in v.action
        ? Object.fromEntries(v.action.set_null.map((f) => [f, null]))
        : (v.action.set_default as Record<string, Val>)
    for (const i of v.rows ?? []) {
      if (!dropped.has(i)) patches.set(i, { ...patches.get(i), ...patch })
    }
  }
  const out: Rec[] = []
  for (const [i, row] of rows.entries()) {
    if (dropped.has(i)) continue
    const patch = patches.get(i)
    out.push(patch ? { ...row, ...patch } : row)
  }
  const affected = (v: Violation) =>
    actionName(v.action) === 'drop_rows'
      ? (v.rows ?? []).length
      : typeof v.action === 'string'
        ? undefined
        : (v.rows ?? []).filter((i) => !dropped.has(i)).length
  return {
    rows: out,
    changed: dropped.size + patches.size,
    stop: violations.some((v) => v.action === 'stop'),
    skipDownstream: violations.some((v) => v.action === 'skip_downstream'),
    issues: violations.map((v) => ({
      node,
      code,
      clause: v.clause,
      action: v.action,
      message: v.message,
      count: v.count,
      samples: v.samples,
      ...(affected(v) === undefined ? {} : { rowsAffected: affected(v) }),
    })),
  }
}

const SAMPLES = 5

export function countViolation(
  count: number,
  bound: Bound & { readonly shiftRatio?: Bound },
  action: Action,
  baseline: number | undefined,
): Violation | undefined {
  const problems: string[] = []
  if (bound.min !== undefined && count < bound.min)
    problems.push(`count ${count} below ${bound.min}`)
  if (bound.max !== undefined && count > bound.max)
    problems.push(`count ${count} above ${bound.max}`)
  const shift = bound.shiftRatio
  if (shift && baseline !== undefined && baseline > 0) {
    const ratio = count / baseline
    if (
      (shift.min !== undefined && ratio < shift.min) ||
      (shift.max !== undefined && ratio > shift.max)
    ) {
      problems.push(`count ${count} is ${ratio.toFixed(2)}x the baseline ${baseline}`)
    }
  }
  return problems.length
    ? { clause: 'count', action, message: problems.join('; '), count: 1, samples: [count] }
    : undefined
}

export function uniqueViolation(
  rows: Relation,
  keys: readonly string[],
  action: Action,
): Violation | undefined {
  const groups = new Map<string, number[]>()
  for (const [i, row] of rows.entries()) {
    const k = keyOf(row, keys)
    const g = groups.get(k)
    if (g) g.push(i)
    else groups.set(k, [i])
  }
  const duplicates = [...groups.values()].filter((g) => g.length > 1)
  if (duplicates.length === 0) return undefined
  return {
    clause: 'unique',
    action,
    message: `${keys.join(', ')} not unique: ${duplicates.length} duplicated keys`,
    count: duplicates.length,
    samples: duplicates
      .slice(0, SAMPLES)
      .map((g) => keys.map((k) => toJson((rows[g[0] as number] as Rec)[k] ?? null))),
    rows: duplicates.flat(),
  }
}

export function rowsViolation(
  rows: Relation,
  test: Test,
  ctx: RunContext,
  action: Action,
): Violation | undefined {
  const bad: number[] = []
  for (const [i, row] of rows.entries()) if (!test(null, row, ctx)) bad.push(i)
  if (bad.length === 0) return undefined
  return {
    clause: 'rows',
    action,
    message: `${bad.length} rows fail the row condition`,
    count: bad.length,
    samples: bad.slice(0, SAMPLES).map((i) => toJson(rows[i] as Rec)),
    rows: bad,
  }
}

type Keyed = NonNullable<NodeExpectation['keyed']>

/** A key with no row counts as 0, so it fails a positive `min` and passes any `max`. */
export function keyedViolations(
  rows: Relation,
  keyed: Keyed,
  spec: ActionSpec | undefined,
): Violation[] {
  const values = new Map<string, Val>()
  for (const row of rows) {
    const by = row[keyed.by] ?? null
    const k = typeof by === 'string' ? by : JSON.stringify(toJson(by))
    if (!values.has(k)) values.set(k, row[keyed.value] ?? null)
  }
  const out: Violation[] = []
  for (const [key, bound] of Object.entries(keyed.bounds)) {
    const raw = values.get(key)
    const value = typeof raw === 'number' ? raw : 0
    const low = bound.min !== undefined && value < bound.min
    const high = bound.max !== undefined && value > bound.max
    if (low || high) {
      out.push({
        clause: 'keyed',
        action: resolveAction(spec, 'keyed', bound.onFail),
        message: `${keyed.by} ${key}: ${keyed.value} ${value} ${low ? `below ${bound.min}` : `above ${bound.max}`}`,
        count: 1,
        samples: [key],
      })
    }
  }
  return out
}

export interface CheckOptions {
  /** Previous count of this node, for `count.shiftRatio`. */
  readonly baseline?: number
  /** Fixtures run at sample scale, so production `count` envelopes are skipped. */
  readonly skipCount?: boolean
}

export type Checker = (rows: Relation, ctx: RunContext, options: CheckOptions) => Outcome

/** Compile a node's `expect` entry against its output; returns the repaired output type. */
export function compileExpectation(
  node: string,
  exp: NodeExpectation,
  output: NodeOutput,
  renv: (record: RecordType) => RecordEnv,
): Result<{ output: NodeOutput; check: Checker }, readonly NodeIssue[]> {
  const issues: NodeIssue[] = []
  const issue = (field: Clause, message: string) =>
    issues.push({ message, field, code: 'invalid_expectation' })
  let repaired = output
  const fields = output.type.fields
  const missing = (names: readonly string[]) => names.filter((f) => !Object.hasOwn(fields, f))

  for (const clause of ['count', 'unique', 'keyed', 'rows'] as const) {
    if (exp[clause] === undefined) continue
    const action = resolveAction(exp.onFail, clause)
    const checked = checkAction(action, clause, repaired)
    if (checked.ok) repaired = checked.value
    else issue(clause, checked.error)
  }
  if (exp.unique && missing(exp.unique).length) {
    issue('unique', `unknown fields: ${missing(exp.unique).join(', ')}`)
  }
  if (exp.keyed) {
    const keyed = exp.keyed
    if (missing([keyed.by, keyed.value]).length) {
      issue('keyed', `unknown fields: ${missing([keyed.by, keyed.value]).join(', ')}`)
    } else if (!comparable(fields[keyed.value] as MType, t.number)) {
      issue('keyed', `${keyed.value} must be a number`)
    }
    for (const bound of Object.values(keyed.bounds)) {
      if (bound.onFail === undefined) continue
      const checked = checkAction(bound.onFail, 'keyed', repaired)
      if (!checked.ok) issue('keyed', checked.error)
    }
  }
  let test: Test | undefined
  if (exp.rows) {
    const compiled = compilePredicate(exp.rows.cond, renv(output.type))
    if (compiled.ok) test = compiled.value
    else issue('rows', compiled.error)
  }
  if (issues.length) return { ok: false, error: issues }

  const check: Checker = (rows, ctx, options) => {
    const violations: Violation[] = []
    const push = (v: Violation | undefined) => v && violations.push(v)
    if (exp.count && !options.skipCount) {
      push(
        countViolation(
          rows.length,
          exp.count,
          resolveAction(exp.onFail, 'count'),
          options.baseline,
        ),
      )
    }
    if (exp.unique) push(uniqueViolation(rows, exp.unique, resolveAction(exp.onFail, 'unique')))
    if (exp.keyed) violations.push(...keyedViolations(rows, exp.keyed, exp.onFail))
    if (test) push(rowsViolation(rows, test, ctx, resolveAction(exp.onFail, 'rows')))
    return applyViolations(node, 'expectation', rows, violations)
  }
  return ok({ output: repaired, check })
}
