/**
 * `aggregate`: one record per group of `group_by` (one record overall for `group_by: []`,
 * even on empty input). Every aggregation takes an optional `where`, making it a filtered
 * aggregate. Results never depend on input order: `sum` adds in sorted order, `collect_set`
 * is sorted, and `collect_list`, `first`, `last` require `order_by`.
 */

import { z } from 'zod'
import type { RunContext } from '../context'
import { compilePredicate, type Test } from '../predicate'
import { ok } from '../result'
import { type MType, orderable, type RecordType, show, stripNull, t } from '../types'
import {
  canonicalKey,
  compareVals,
  keyOf,
  type Rec,
  type Relation,
  sortRecords,
  type Val,
} from '../values'
import { defineNode, type NodeEnv, nodeId, type NodeIssue, type Origin, ownOrigins } from './def'

const orderBy = z
  .array(
    z.union([
      z.string().min(1),
      z.strictObject({ path: z.string().min(1), desc: z.boolean().optional() }),
    ]),
  )
  .min(1)

const agg = z.strictObject({
  agg: z.enum([
    'count',
    'count_distinct',
    'sum',
    'min',
    'max',
    'collect_set',
    'collect_list',
    'first',
    'last',
    'any',
    'all',
  ]),
  path: z.string().min(1).optional(),
  where: z.unknown().optional(),
  order_by: orderBy.optional(),
  cond: z.unknown().optional(),
})
type Agg = z.infer<typeof agg>

const params = z.strictObject({
  in: nodeId,
  group_by: z.array(z.string().min(1)),
  fields: z
    .record(z.string().min(1), agg)
    .refine((f) => Object.keys(f).length > 0, 'needs at least one field'),
  tolerate_skips: z.boolean().optional(),
})

const NEEDS_PATH = new Set([
  'count_distinct',
  'sum',
  'min',
  'max',
  'collect_set',
  'collect_list',
  'first',
  'last',
])
const NEEDS_ORDER = new Set(['collect_list', 'first', 'last'])
const NEEDS_COND = new Set(['any', 'all'])

type Compute = (rows: Relation, ctx: RunContext) => Val

function compileAgg(
  name: string,
  spec: Agg,
  input: RecordType,
  env: NodeEnv,
): { type: MType; compute: Compute } | NodeIssue {
  const issue = (message: string): NodeIssue => ({ message, field: name })
  const renv = env.recordEnv(input)
  if (NEEDS_PATH.has(spec.agg) !== (spec.path !== undefined)) {
    return issue(
      NEEDS_PATH.has(spec.agg) ? `${spec.agg} needs a path` : `${spec.agg} takes no path`,
    )
  }
  if (NEEDS_ORDER.has(spec.agg) !== (spec.order_by !== undefined)) {
    return issue(
      NEEDS_ORDER.has(spec.agg) ? `${spec.agg} needs order_by` : `${spec.agg} takes no order_by`,
    )
  }
  if (NEEDS_COND.has(spec.agg) !== (spec.cond !== undefined)) {
    return issue(
      NEEDS_COND.has(spec.agg) ? `${spec.agg} needs a cond` : `${spec.agg} takes no cond`,
    )
  }
  const path = spec.path
  const fieldType = path === undefined ? undefined : input.fields[path]
  if (path !== undefined && !fieldType) return issue(`unknown field '${path}'`)
  const order = (spec.order_by ?? []).map((o) =>
    typeof o === 'string' ? { path: o, desc: false } : { desc: false, ...o },
  )
  const unknownOrder = order.filter((o) => !Object.hasOwn(input.fields, o.path))
  if (unknownOrder.length)
    return issue(`order_by: unknown field '${(unknownOrder[0] as { path: string }).path}'`)

  let where: Test | undefined
  if (spec.where !== undefined) {
    const w = compilePredicate(spec.where, renv)
    if (!w.ok) return issue(`where: ${w.error}`)
    where = w.value
  }
  let cond: Test | undefined
  if (spec.cond !== undefined) {
    const c = compilePredicate(spec.cond, renv)
    if (!c.ok) return issue(`cond: ${c.error}`)
    cond = c.value
  }

  const values = (rows: Relation) => rows.map((r) => r[path as string] ?? null)
  const nonNull = (rows: Relation) => values(rows).filter((v) => v !== null)
  const sorted = (rows: Relation) =>
    [...rows].sort((a, b) => {
      for (const o of order) {
        const c = compareVals(a[o.path] ?? null, b[o.path] ?? null)
        if (c !== 0) return o.desc ? -c : c
      }
      return compareVals(canonicalKey(a), canonicalKey(b))
    })
  const base = fieldType ? stripNull(fieldType) : t.unknown

  let type: MType
  let compute: Compute
  switch (spec.agg) {
    case 'count':
      type = t.number
      compute = (rows) => rows.length
      break
    case 'count_distinct':
      type = t.number
      compute = (rows) => new Set(nonNull(rows).map(canonicalKey)).size
      break
    case 'sum':
      if (base.kind !== 'number')
        return issue(`sum needs a number field, ${path} is ${show(fieldType as MType)}`)
      type = t.nullable(t.number)
      compute = (rows) => {
        const xs = (nonNull(rows) as number[]).sort((a, b) => a - b)
        return xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0)
      }
      break
    case 'min':
    case 'max': {
      if (!orderable(base))
        return issue(
          `${spec.agg} needs a number, string or date field, ${path} is ${show(fieldType as MType)}`,
        )
      type = t.nullable(base)
      const sign = spec.agg === 'min' ? 1 : -1
      compute = (rows) => nonNull(rows).sort((a, b) => sign * compareVals(a, b))[0] ?? null
      break
    }
    case 'collect_set':
      type = t.list(base)
      compute = (rows) => {
        const seen = new Map<string, Val>()
        for (const v of nonNull(rows)) seen.set(canonicalKey(v), v)
        return [...seen.values()].sort(compareVals)
      }
      break
    case 'collect_list':
      type = t.list(fieldType as MType)
      compute = (rows) => sorted(rows).map((r) => r[path as string] ?? null)
      break
    case 'first':
    case 'last': {
      type = t.nullable(fieldType as MType)
      const pick = spec.agg === 'first' ? 0 : -1
      compute = (rows) => sorted(rows).at(pick)?.[path as string] ?? null
      break
    }
    default: {
      type = t.boolean
      const test = cond as Test
      compute =
        spec.agg === 'any'
          ? (rows, ctx) => rows.some((r) => test(null, r, ctx))
          : (rows, ctx) => rows.every((r) => test(null, r, ctx))
    }
  }
  if (where) {
    const w = where
    const inner = compute
    compute = (rows, ctx) =>
      inner(
        rows.filter((r) => w(null, r, ctx)),
        ctx,
      )
  }
  return { type, compute }
}

export const aggregateNode = defineNode({
  op: 'aggregate',
  label: 'Aggregate',
  category: 'transform',
  description: 'One record per group, with counts, sums, sets and other aggregates.',
  slots: [{ id: 'in', label: 'In', path: ['in'] }],
  output: true,
  defaults: () => ({ in: '', group_by: [], fields: {} }),
  params,
  toleratesSkips: (p) => p.tolerate_skips === true,
  compile: (p, env) => {
    const input = env.input(p.in)
    const issues: NodeIssue[] = []
    const fields: Record<string, MType> = {}
    for (const g of p.group_by) {
      const type = input.type.fields[g]
      if (type) fields[g] = type
      else issues.push({ message: `group_by: unknown field '${g}'` })
    }
    const aggs: { name: string; compute: Compute }[] = []
    for (const [name, spec] of Object.entries(p.fields)) {
      if (p.group_by.includes(name)) {
        issues.push({ message: `'${name}' is both a group key and an aggregate`, field: name })
        continue
      }
      const compiled = compileAgg(name, spec, input.type, env)
      if ('message' in compiled) issues.push(compiled)
      else {
        fields[name] = compiled.type
        aggs.push({ name, compute: compiled.compute })
      }
    }
    if (issues.length) return { ok: false, error: issues }

    const type = t.record(fields)
    return ok({
      output: {
        type,
        origins: {
          ...ownOrigins(env.id, type),
          ...Object.fromEntries(p.group_by.map((g) => [g, input.origins[g] as Origin])),
        },
      },
      run: (inputs, ctx) => {
        const groups = new Map<string, Rec[]>()
        // `group_by: []` yields one record even for empty input.
        if (p.group_by.length === 0) groups.set(keyOf({}, []), [])
        for (const row of inputs(p.in)) {
          const k = keyOf(row, p.group_by)
          const g = groups.get(k)
          if (g) g.push(row)
          else groups.set(k, [row])
        }
        const rows: Rec[] = []
        for (const members of groups.values()) {
          const out: Record<string, Val> = {}
          const sample = members[0]
          for (const g of p.group_by) out[g] = (sample as Rec)[g] ?? null
          for (const a of aggs) out[a.name] = a.compute(members, ctx)
          rows.push(out)
        }
        return ok({ rows: sortRecords(rows, p.group_by) })
      },
    })
  },
})
