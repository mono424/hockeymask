/**
 * List ops for list-typed fields within one record: `each`, `filter_list`, `index`, `first`,
 * `last`, `len`, `unique`, `sum`, `min`, `max`, `contains`. Collection-wide work belongs to
 * collection nodes.
 */

import { z } from 'zod'
import { compileOperand, compilePredicate } from '../predicate'
import { compileSteps } from '../pipeline'
import { err, expectOk, ok, type Result } from '../result'
import { comparable, type ListType, type MType, orderable, show, stripNull, t } from '../types'
import { canonicalKey, compareVals, type Val } from '../values'
import { defineOp, never, params } from './def'

const listIn = (input: MType, op: string): Result<MType, string> =>
  input.kind === 'list' ? ok(input.of) : err(`${op} expects a list, got ${show(input)}`)

/** Applies a nested pipeline to every element. Nesting depth is capped at 1. */
export const each = defineOp({
  name: 'each',
  params: params({ pipeline: z.array(z.unknown()).min(1) }),
  nulls: 'propagate',
  fallible: (p, env, input) =>
    expectOk(compileSteps(p.pipeline, { ...env, depth: env.depth + 1 }, (input as ListType).of))
      .fallible,
  signature: (input, p, env) => {
    if (env.depth >= 1) return err('each cannot be nested inside each')
    const element = listIn(input, 'each')
    if (!element.ok) return element
    const nested = compileSteps(p.pipeline, { ...env, depth: env.depth + 1 }, element.value)
    if (!nested.ok) return err(`each step ${nested.error.step}: ${nested.error.message}`)
    if (nested.value.omittable) return err('each cannot end in omit_if_null')
    return ok(t.list(nested.value.type))
  },
  run: (p, env, input) => {
    const { run } = expectOk(
      compileSteps(p.pipeline, { ...env, depth: env.depth + 1 }, (input as ListType).of),
    )
    return (list, ctx) => {
      const out: Val[] = []
      for (const [i, element] of (list as readonly Val[]).entries()) {
        const r = run(element, ctx)
        if (!r.ok)
          return err({
            code: r.error.code,
            detail: `element ${i}, ${r.error.op}: ${r.error.detail}`,
          })
        out.push(r.value as Val)
      }
      return ok(out)
    }
  },
})

export const filterList = defineOp({
  name: 'filter_list',
  params: params({ cond: z.unknown() }),
  nulls: 'propagate',
  fallible: never,
  signature: (input, p, env) => {
    const element = listIn(input, 'filter_list')
    if (!element.ok) return element
    const test = compilePredicate(p.cond, env, element.value)
    return test.ok ? ok(input) : test
  },
  run: (p, env, input) => {
    const test = expectOk(compilePredicate(p.cond, env, (input as ListType).of))
    return (list, ctx) => ok((list as readonly Val[]).filter((e) => test(e, ctx.record, ctx)))
  },
})

const pick = (name: string, at: (length: number) => number) =>
  defineOp({
    name,
    params: params({}),
    nulls: 'propagate',
    fallible: never,
    signature: (input) => {
      const element = listIn(input, name)
      return element.ok ? ok(t.nullable(element.value)) : element
    },
    run: () => (list) => ok((list as readonly Val[])[at((list as readonly Val[]).length)] ?? null),
  })

export const first = pick('first', () => 0)
export const last = pick('last', (n) => n - 1)

/** Element at `at`; a negative index counts from the end. Out of range gives null. */
export const index = defineOp({
  name: 'index',
  params: params({ at: z.number().int() }),
  nulls: 'propagate',
  fallible: never,
  signature: (input) => {
    const element = listIn(input, 'index')
    return element.ok ? ok(t.nullable(element.value)) : element
  },
  run: (p) => (list) => ok((list as readonly Val[]).at(p.at) ?? null),
})

/** Length of a list, or of a string in code points. */
export const len = defineOp({
  name: 'len',
  params: params({}),
  nulls: 'propagate',
  fallible: never,
  signature: (input) =>
    input.kind === 'list' || input.kind === 'string'
      ? ok(t.number)
      : err(`len expects a list or string, got ${show(input)}`),
  run: () => (v) => ok(typeof v === 'string' ? Array.from(v).length : (v as readonly Val[]).length),
})

/** Drops repeated elements, keeping the first occurrence. */
export const unique = defineOp({
  name: 'unique',
  params: params({}),
  nulls: 'propagate',
  fallible: never,
  signature: (input) => {
    const element = listIn(input, 'unique')
    return element.ok ? ok(input) : element
  },
  run: () => (list) => {
    const seen = new Set<string>()
    return ok(
      (list as readonly Val[]).filter((e) => {
        const k = canonicalKey(e)
        if (seen.has(k)) return false
        seen.add(k)
        return true
      }),
    )
  },
})

/** Null elements are skipped; an empty list gives null. */
export const sum = defineOp({
  name: 'sum',
  params: params({}),
  nulls: 'propagate',
  fallible: never,
  signature: (input) => {
    const element = listIn(input, 'sum')
    if (!element.ok) return element
    return stripNull(element.value).kind === 'number'
      ? ok(t.nullable(t.number))
      : err(`sum expects list<number>, got ${show(input)}`)
  },
  // Sorted first, so floating-point results do not depend on element order.
  run: () => (list) => {
    const numbers = (list as readonly Val[])
      .filter((x): x is number => x !== null)
      .sort((a, b) => a - b)
    return ok(numbers.length === 0 ? null : numbers.reduce((a, b) => a + b, 0))
  },
})

const extreme = (name: 'min' | 'max') =>
  defineOp({
    name,
    params: params({}),
    nulls: 'propagate',
    fallible: never,
    signature: (input) => {
      const element = listIn(input, name)
      if (!element.ok) return element
      return orderable(element.value)
        ? ok(t.nullable(stripNull(element.value)))
        : err(`${name} expects a list of numbers, strings or dates, got ${show(input)}`)
    },
    run: () => (list) => {
      let best: Val = null
      for (const x of list as readonly Val[]) {
        if (x === null) continue
        if (best === null || (name === 'min' ? compareVals(x, best) < 0 : compareVals(x, best) > 0))
          best = x
      }
      return ok(best)
    },
  })

export const min = extreme('min')
export const max = extreme('max')

/** Membership of a literal, `{ ref }` or `{ param }` value. Null is never a member. */
export const contains = defineOp({
  name: 'contains',
  params: params({ value: z.unknown().refine((v) => v !== undefined, 'contains needs a value') }),
  nulls: 'propagate',
  fallible: never,
  signature: (input, p, env) => {
    const element = listIn(input, 'contains')
    if (!element.ok) return element
    const operand = compileOperand(p.value, env, stripNull(element.value).kind === 'date')
    if (!operand.ok) return operand
    return comparable(element.value, operand.value.type)
      ? ok(t.boolean)
      : err(`cannot look for ${show(operand.value.type)} in ${show(input)}`)
  },
  run: (p, env, input) => {
    const element = (input as ListType).of
    const { get } = expectOk(compileOperand(p.value, env, stripNull(element).kind === 'date'))
    return (list, ctx) => {
      const v = get(list, ctx.record, ctx)
      return ok(
        v !== null && (list as readonly Val[]).some((x) => x !== null && compareVals(x, v) === 0),
      )
    }
  },
})
