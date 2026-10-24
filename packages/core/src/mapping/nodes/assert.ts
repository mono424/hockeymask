/**
 * `assert`: a named built-in check on its `in` relation, which it passes through (repaired, if
 * the chosen action repairs rows), so it can guard a flow or end a branch. `on_fail` is one
 * of the expectation actions, `alert` by default.
 *
 * - `count`: `min` / `max` rows.
 * - `unique`: `keys` unique.
 * - `rows`: every row satisfies `cond`.
 * - `acyclic`: the edges `edge.from -> edge.to` of `in` contain no cycle. With `edge.key` the
 *   edges belong to groups (each product's own supply graph) and each group is checked on its
 *   own; with `per`, every distinct `per.key` of `per.in` is checked against all edges. Either
 *   way a group's rows of `remove.in` are taken out first. Cycle detection is iterative, so
 *   it is engine code rather than a composition of DAG nodes.
 */

import { z } from 'zod'
import type { RunContext } from '../context'
import { Action } from '../document'
import {
  applyViolations,
  checkAction,
  countViolation,
  rowsViolation,
  uniqueViolation,
  type Violation,
} from '../expect'
import { compilePredicate, type Test } from '../predicate'
import { ok } from '../result'
import { comparable, type MType, show } from '../types'
import { canonicalKey, compareVals, type Json, type Relation, toJson, type Val } from '../values'
import { defineNode, type NodeEnv, nodeId, type NodeIssue, type NodeOutput } from './def'

const common = { in: nodeId, on_fail: Action.optional() }

const params = z.discriminatedUnion('check', [
  z.strictObject({
    ...common,
    check: z.literal('count'),
    min: z.number().optional(),
    max: z.number().optional(),
  }),
  z.strictObject({
    ...common,
    check: z.literal('unique'),
    keys: z.array(z.string().min(1)).min(1),
  }),
  z.strictObject({ ...common, check: z.literal('rows'), cond: z.unknown() }),
  z.strictObject({
    ...common,
    check: z.literal('acyclic'),
    edge: z.strictObject({
      from: z.string().min(1),
      to: z.string().min(1),
      key: z.string().min(1).optional(),
    }),
    per: z.strictObject({ in: nodeId, key: z.string().min(1) }).optional(),
    remove: z
      .strictObject({
        in: nodeId,
        key: z.string().min(1),
        from: z.string().min(1),
        to: z.string().min(1),
        where: z.unknown().optional(),
      })
      .optional(),
  }),
])
type Params = z.infer<typeof params>
type Acyclic = Extract<Params, { check: 'acyclic' }>

/** One cycle as a path (first node repeated at the end), or undefined. */
export function findCycle(edges: readonly (readonly [string, string])[]): string[] | undefined {
  const next = new Map<string, string[]>()
  for (const [from, to] of edges) next.set(from, [...(next.get(from) ?? []), to])
  const state = new Map<string, 'open' | 'done'>()
  const path: string[] = []
  const visit = (node: string): string[] | undefined => {
    state.set(node, 'open')
    path.push(node)
    for (const to of next.get(node) ?? []) {
      if (state.get(to) === 'open') return [...path.slice(path.indexOf(to)), to]
      if (!state.has(to)) {
        const cycle = visit(to)
        if (cycle) return cycle
      }
    }
    path.pop()
    state.set(node, 'done')
    return undefined
  }
  for (const node of [...next.keys()].sort()) {
    if (state.has(node)) continue
    const cycle = visit(node)
    if (cycle) return cycle
  }
  return undefined
}

function fieldIssues(output: NodeOutput, fields: readonly string[], where: string): NodeIssue[] {
  return fields
    .filter((f) => !Object.hasOwn(output.type.fields, f))
    .map((f) => ({ message: `${where}: unknown field '${f}'` }))
}

function compileAcyclic(p: Acyclic, input: NodeOutput, env: NodeEnv) {
  const issues = fieldIssues(
    input,
    [p.edge.from, p.edge.to, ...(p.edge.key ? [p.edge.key] : [])],
    'edge',
  )
  const edgeType = input.type.fields[p.edge.from]
  let removeWhere: Test | undefined
  if (p.per) issues.push(...fieldIssues(env.input(p.per.in), [p.per.key], 'per'))
  // A group without edges cannot have a cycle, so per adds nothing to grouped edges.
  if (p.edge.key && p.per) issues.push({ message: 'edge.key groups the edges itself; drop per' })
  const groupType = p.edge.key
    ? input.type.fields[p.edge.key]
    : p.per && env.input(p.per.in).type.fields[p.per.key]
  if (p.remove) {
    if (!p.per && !p.edge.key) issues.push({ message: 'remove needs per or edge.key' })
    const removal = env.input(p.remove.in)
    issues.push(...fieldIssues(removal, [p.remove.key, p.remove.from, p.remove.to], 'remove'))
    const checks: [string, MType | undefined, MType | undefined][] = [
      [`remove.from`, removal.type.fields[p.remove.from], edgeType],
      [`remove.to`, removal.type.fields[p.remove.to], edgeType],
      [`remove.key`, removal.type.fields[p.remove.key], groupType],
    ]
    for (const [name, a, b] of checks) {
      if (a && b && !comparable(a, b)) issues.push({ message: `${name}: ${show(a)} vs ${show(b)}` })
    }
    if (p.remove.where !== undefined) {
      const w = compilePredicate(p.remove.where, env.recordEnv(removal.type))
      if (w.ok) removeWhere = w.value
      else issues.push({ message: `remove.where: ${w.error}` })
    }
  }
  const toType = input.type.fields[p.edge.to]
  if (edgeType && toType && !comparable(edgeType, toType)) {
    issues.push({ message: `edge: ${show(edgeType)} vs ${show(toType)}` })
  }
  return { issues, removeWhere }
}

const str = (v: Val) => (typeof v === 'string' ? v : canonicalKey(v))

type Edge = readonly [string, string]

function acyclicViolation(
  p: Acyclic,
  inputs: (id: string) => Relation,
  ctx: RunContext,
  removeWhere: Test | undefined,
  action: Action,
): Violation | undefined {
  const keyed = p.edge.key
  const grouped = keyed !== undefined || p.per !== undefined
  // Edges by canonical group key: by `edge.key`, or one set every group shares under null.
  const edgesOf = new Map<string, Map<string, Edge>>()
  const keys = new Map<string, Val>()
  for (const row of inputs(p.in)) {
    const from = row[p.edge.from] ?? null
    const to = row[p.edge.to] ?? null
    const k = keyed ? (row[keyed] ?? null) : null
    if (from === null || to === null || (keyed && k === null)) continue
    const g = canonicalKey(k)
    keys.set(g, k)
    const edges = edgesOf.get(g) ?? new Map<string, Edge>()
    edges.set(canonicalKey([from, to]), [str(from), str(to)])
    edgesOf.set(g, edges)
  }
  let groups: Val[] = [null]
  if (keyed) groups = [...keys.values()].sort(compareVals)
  else if (p.per) {
    const seen = new Map<string, Val>()
    for (const row of inputs(p.per.in)) {
      const k = row[p.per.key] ?? null
      if (k !== null) seen.set(canonicalKey(k), k)
    }
    groups = [...seen.values()].sort(compareVals)
  }
  const removals = new Map<string, Set<string>>()
  if (p.remove) {
    for (const row of inputs(p.remove.in)) {
      if (removeWhere && !removeWhere(null, row, ctx)) continue
      const g = canonicalKey(row[p.remove.key] ?? null)
      const set = removals.get(g) ?? new Set<string>()
      set.add(canonicalKey([row[p.remove.from] ?? null, row[p.remove.to] ?? null]))
      removals.set(g, set)
    }
  }
  // With shared edges most groups remove the same ones (often none), so cycles are cached
  // by removal set; a group with edges of its own is small and checked directly.
  const cache = new Map<string, string[] | undefined>()
  const failing: Json[] = []
  let count = 0
  for (const g of groups) {
    const removed = removals.get(canonicalKey(g)) ?? new Set<string>()
    const edges = edgesOf.get(canonicalKey(keyed ? g : null)) ?? new Map<string, Edge>()
    const kept = () => [...edges].filter(([k]) => !removed.has(k)).map(([, e]) => e)
    let cycle: string[] | undefined
    if (keyed) cycle = findCycle(kept())
    else {
      const signature = [...removed].sort().join('|')
      if (!cache.has(signature)) cache.set(signature, findCycle(kept()))
      cycle = cache.get(signature)
    }
    if (cycle) {
      count += 1
      if (failing.length < 5) failing.push({ group: toJson(g), cycle })
    }
  }
  if (count === 0) return undefined
  const first = failing[0] as { group: Json; cycle: string[] }
  return {
    clause: 'acyclic',
    action,
    message: `${count} ${grouped ? 'groups have' : 'graph has'} a cycle, e.g. ${grouped ? `${typeof first.group === 'string' ? first.group : JSON.stringify(first.group)}: ` : ''}${first.cycle.join(' -> ')}`,
    count,
    samples: failing,
  }
}

export const assertNode = defineNode({
  op: 'assert',
  label: 'Assert',
  category: 'check',
  description: 'A built-in check (count, unique, rows, acyclic) that passes its input through.',
  slots: [
    { id: 'in', label: 'In', path: ['in'] },
    { id: 'per', label: 'Per', path: ['per', 'in'], optional: true },
    { id: 'remove', label: 'Remove', path: ['remove', 'in'], optional: true },
  ],
  output: true,
  effect: 'check',
  defaults: () => ({ in: '', check: 'count' }),
  params,
  compile: (p: Params, env) => {
    const input = env.input(p.in)
    const action = p.on_fail ?? 'alert'
    const checked = checkAction(action, p.check, input)
    const issues: NodeIssue[] = checked.ok ? [] : [{ message: `on_fail: ${checked.error}` }]
    let test: Test | undefined
    let removeWhere: Test | undefined
    switch (p.check) {
      case 'unique':
        issues.push(...fieldIssues(input, p.keys, 'keys'))
        break
      case 'rows': {
        const compiled = compilePredicate(p.cond, env.recordEnv(input.type))
        if (compiled.ok) test = compiled.value
        else issues.push({ message: `cond: ${compiled.error}` })
        break
      }
      case 'acyclic': {
        const compiled = compileAcyclic(p, input, env)
        issues.push(...compiled.issues)
        removeWhere = compiled.removeWhere
        break
      }
    }
    if (!checked.ok || issues.length > 0) return { ok: false, error: issues }

    return ok({
      output: checked.value,
      run: (inputs, ctx, options = {}) => {
        const rows = inputs(p.in)
        let violation: Violation | undefined
        switch (p.check) {
          case 'count':
            violation = options.skipCount
              ? undefined
              : countViolation(rows.length, p, action, undefined)
            break
          case 'unique':
            violation = uniqueViolation(rows, p.keys, action)
            break
          case 'rows':
            violation = rowsViolation(rows, test as Test, ctx, action)
            break
          default:
            violation = acyclicViolation(p, inputs, ctx, removeWhere, action)
        }
        return ok(applyViolations(env.id, 'assert', rows, violation ? [violation] : []))
      },
    })
  },
})
