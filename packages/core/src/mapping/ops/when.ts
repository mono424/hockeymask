/**
 * `when`: the one general conditional. First matching case wins;
 * `then` and `else` are a literal, `null`, or `{ "pass": true }` to forward the input. `else`
 * defaults to pass-through. As a pipeline's first step there is no input: every case must
 * test a `path`, and `else` is required.
 */

import { z } from 'zod'
import { compilePredicate } from '../predicate'
import { err, expectOk, ok, type Result } from '../result'
import { type MType, show, typeOfJson, unifyAll } from '../types'
import type { Json, Val } from '../values'
import { defineOp, json, never, params } from './def'

const pass = z.strictObject({ pass: z.literal(true) })
const scalar = z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(json)])
const branch = z.union([pass, scalar])

type Branch = z.infer<typeof branch>

const isPass = (b: Branch): b is { pass: true } =>
  typeof b === 'object' && b !== null && !Array.isArray(b)

export const when = defineOp({
  name: 'when',
  params: params({
    cases: z.array(z.strictObject({ cond: z.unknown(), then: branch })).min(1),
    else: branch.optional(),
  }),
  nulls: 'consume',
  input: 'any',
  fallible: never,
  signature: (input, p, env): Result<MType, string> => {
    const first = input.kind === 'unit'
    const branches = [...p.cases.map((c) => c.then), ...(p.else === undefined ? [] : [p.else])]
    if (first && p.else === undefined) return err('when as the first step needs an "else"')
    if (first && branches.some(isPass)) return err('when as the first step has no input to pass')
    for (const [i, c] of p.cases.entries()) {
      const test = compilePredicate(c.cond, env, input)
      if (!test.ok) return err(`case ${i}: ${test.error}`)
    }
    const types = branches.map((b) => (isPass(b) ? input : typeOfJson(b)))
    if (p.else === undefined) types.push(input)
    const out = unifyAll(types)
    return out.ok ? out : err(`when branches disagree: ${types.map(show).join(', ')}`)
  },
  run: (p, env, input) => {
    const cases = p.cases.map((c) => ({
      test: expectOk(compilePredicate(c.cond, env, input)),
      then: c.then,
    }))
    const otherwise = p.else ?? { pass: true as const }
    const resolve = (b: Branch, v: Val): Val => (isPass(b) ? v : (b as Json as Val))
    return (v, ctx) => {
      for (const c of cases) if (c.test(v, ctx.record, ctx)) return ok(resolve(c.then, v))
      return ok(resolve(otherwise, v))
    }
  },
})
