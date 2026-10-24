/**
 * `metrics`: writes a small relation, such as counters, onto the sync run rather than into the
 * domain. Never held back by any check: it describes the run, and matters most when a run
 * is stopped.
 *
 * `count_by` reports one row per distinct combination of those fields with its number of
 * `rows`, the usual counter, so it needs no `aggregate` in front. The reported relation is the
 * node's output for `expect` (a `keyed` bound alerts on one counter); nothing reads it.
 */

import { z } from 'zod'
import { ok } from '../result'
import { type MType, t } from '../types'
import { type Json, keyOf, type Rec, sortRecords, toJson } from '../values'
import { defineNode, fail, nodeId, type Origin, ownOrigins } from './def'

const params = z.strictObject({
  in: nodeId,
  name: z.string().min(1),
  count_by: z.array(z.string().min(1)).min(1).optional(),
})

/** The count field `count_by` adds next to the group fields. */
const COUNT = 'rows'

export const metricsNode = defineNode({
  op: 'metrics',
  label: 'Run metrics',
  category: 'target',
  description: 'Reports a small relation (counters) on the run instead of the domain.',
  slots: [{ id: 'in', label: 'In', path: ['in'] }],
  output: false,
  effect: 'metrics',
  defaults: () => ({ in: '', name: '' }),
  params,
  compile: (p, env) => {
    const input = env.input(p.in)
    const by = p.count_by
    if (!by) {
      return ok({
        output: input,
        run: (inputs) => {
          const rows = sortRecords(inputs(p.in), [])
          return ok({ rows, metric: metric(env.id, p.name, rows) })
        },
      })
    }
    const unknown = by.filter((f) => !Object.hasOwn(input.type.fields, f))
    if (unknown.length) return fail(`count_by: unknown fields: ${unknown.join(', ')}`)
    if (by.includes(COUNT)) return fail(`count_by: '${COUNT}' is the count field; rename it first`)
    const fields: Record<string, MType> = Object.fromEntries(
      by.map((f) => [f, input.type.fields[f] as MType]),
    )
    const type = t.record({ ...fields, [COUNT]: t.number })
    return ok({
      output: {
        type,
        origins: {
          ...ownOrigins(env.id, type),
          ...Object.fromEntries(by.map((f) => [f, input.origins[f] as Origin])),
        },
      },
      run: (inputs) => {
        const groups = new Map<string, { first: Rec; n: number }>()
        for (const row of inputs(p.in)) {
          const k = keyOf(row, by)
          const group = groups.get(k)
          if (group) group.n += 1
          else groups.set(k, { first: row, n: 1 })
        }
        const counted = [...groups.values()].map(({ first, n }) => ({
          ...Object.fromEntries(by.map((f) => [f, first[f] ?? null])),
          [COUNT]: n,
        }))
        const rows = sortRecords(counted, by)
        return ok({ rows, metric: metric(env.id, p.name, rows) })
      },
    })
  },
})

function metric(node: string, name: string, rows: readonly Rec[]) {
  return { node, name, rows: rows.map((r) => toJson(r) as Record<string, Json>) }
}
