/**
 * `filter`: keeps records where the predicate holds. A `{ path, is_null: false }` condition
 * (alone or inside `all`) narrows that field to non-null in the output type.
 */

import { z } from 'zod'
import { compilePredicate } from '../predicate'
import { ok } from '../result'
import { defineNode, fail, nodeId } from './def'
import { narrow } from './source'

const params = z.strictObject({ in: nodeId, cond: z.unknown() })

export const filterNode = defineNode({
  op: 'filter',
  label: 'Filter',
  category: 'transform',
  description: 'Keeps the records where a condition holds.',
  slots: [{ id: 'in', label: 'In', path: ['in'] }],
  output: true,
  defaults: () => ({ in: '', cond: {} }),
  params,
  compile: (p, env) => {
    const input = env.input(p.in)
    const test = compilePredicate(p.cond, env.recordEnv(input.type))
    if (!test.ok) return fail(`cond: ${test.error}`)
    const cond = test.value
    return ok({
      output: narrow(input, p.cond),
      run: (inputs, ctx) => ok({ rows: inputs(p.in).filter((r) => cond(null, r, ctx)) }),
    })
  },
})
