/**
 * `join`: equi-join on key pairs plus an optional residual `where`, part of the match (as in
 * SQL `ON`). `left` makes every right field nullable; `semi` / `anti` keep left records with
 * at least one / no match and return the left schema.
 *
 * `select` picks and renames right fields; without it every right field is kept, a join key
 * with the same name on both sides merges, and any other collision is a save error. Null keys
 * never match.
 *
 * `cardinality` is declared and enforced while the hash table is built:
 * `n:1` right keys unique, `1:n` left keys unique, `1:1` both, `n:m` unrestricted but needs a
 * `count` expectation on this node.
 */

import { z } from 'zod'
import { compilePredicate, type Test } from '../predicate'
import { err, ok } from '../result'
import { comparable, type MType, show, t } from '../types'
import { type Json, keyOf, type Rec, type Relation, toJson, type Val } from '../values'
import { defineNode, nodeId, type NodeIssue, type Origin } from './def'

const params = z.strictObject({
  left: nodeId,
  right: nodeId,
  on: z.array(z.tuple([z.string().min(1), z.string().min(1)])).min(1),
  type: z.enum(['inner', 'left', 'semi', 'anti']).optional(),
  cardinality: z.enum(['1:1', 'n:1', '1:n', 'n:m']),
  select: z.record(z.string().min(1), z.string().min(1)).optional(),
  where: z.unknown().optional(),
  tolerate_skips: z.boolean().optional(),
})

/** Index of rows by key, skipping null keys; reports the first duplicate when `unique`. */
function index(rows: Relation, keys: readonly string[], unique: boolean) {
  const byKey = new Map<string, Rec[]>()
  for (const row of rows) {
    if (keys.some((k) => (row[k] ?? null) === null)) continue
    const k = keyOf(row, keys)
    const bucket = byKey.get(k)
    if (!bucket) byKey.set(k, [row])
    else if (unique) return { duplicate: keys.map((f) => toJson(row[f] as Val)) }
    else bucket.push(row)
  }
  return { byKey }
}

export const joinNode = defineNode({
  op: 'join',
  label: 'Join',
  category: 'transform',
  description: 'Combines two inputs on matching keys, with a declared cardinality.',
  slots: [
    { id: 'left', label: 'Left', path: ['left'] },
    { id: 'right', label: 'Right', path: ['right'] },
  ],
  output: true,
  defaults: () => ({ left: '', right: '', on: [], type: 'inner', cardinality: 'n:1' }),
  params,
  toleratesSkips: (p) => p.tolerate_skips === true,
  compile: (p, env) => {
    const left = env.input(p.left)
    const right = env.input(p.right)
    const kind = p.type ?? 'inner'
    const issues: NodeIssue[] = []

    for (const [lk, rk] of p.on) {
      const lt = left.type.fields[lk]
      const rt = right.type.fields[rk]
      if (!lt) issues.push({ message: `left has no field '${lk}'` })
      if (!rt) issues.push({ message: `right has no field '${rk}'` })
      if (lt && rt && !comparable(lt, rt)) {
        issues.push({ message: `join key ${lk}: ${show(lt)} vs ${rk}: ${show(rt)}` })
      }
    }
    if (p.cardinality === 'n:m' && env.expect?.count === undefined) {
      issues.push({
        message: "an n:m join needs a count expectation in the version's expect block",
        code: 'missing_expectation',
      })
    }

    // Right fields carried into the output: `select`ed and renamed, or all but merged keys.
    const carried: [string, string][] = []
    if (p.select) {
      for (const [from, to] of Object.entries(p.select)) {
        if (Object.hasOwn(right.type.fields, from)) carried.push([from, to])
        else issues.push({ message: `select: right has no field '${from}'` })
      }
    } else {
      const merged = new Set(p.on.filter(([l, r]) => l === r).map(([l]) => l))
      for (const name of Object.keys(right.type.fields))
        if (!merged.has(name)) carried.push([name, name])
    }
    const needsMerge = kind === 'inner' || kind === 'left' || p.where !== undefined
    const fields: Record<string, MType> = { ...left.type.fields }
    const origins: Record<string, Origin> = { ...left.origins }
    if (needsMerge) {
      for (const [from, to] of carried) {
        if (Object.hasOwn(fields, to)) {
          issues.push({ message: `field '${to}' exists on both sides; rename it with select` })
          continue
        }
        const type = right.type.fields[from] as MType
        fields[to] = kind === 'left' ? t.nullable(type) : type
        origins[to] =
          kind === 'left'
            ? { node: env.id, field: to, omittable: false }
            : (right.origins[from] as Origin)
      }
    }
    let where: Test | undefined
    if (p.where !== undefined && issues.length === 0) {
      const compiled = compilePredicate(p.where, env.recordEnv(t.record(fields)))
      if (compiled.ok) where = compiled.value
      else issues.push({ message: `where: ${compiled.error}` })
    }
    if (issues.length) return { ok: false, error: issues }

    const leftKeys = p.on.map(([l]) => l)
    const rightKeys = p.on.map(([, r]) => r)
    const leftUnique = p.cardinality === '1:1' || p.cardinality === '1:n'
    const rightUnique = p.cardinality === '1:1' || p.cardinality === 'n:1'
    const nullRight = Object.fromEntries(carried.map(([, to]) => [to, null]))
    const project = (r: Rec): Rec => {
      const out: Record<string, Val> = {}
      for (const [from, to] of carried) out[to] = r[from] ?? null
      return out
    }
    const violated = (side: 'left' | 'right', key: readonly Json[]) =>
      err({
        code: 'cardinality_violated',
        message: `${p.cardinality} join: ${side} key ${JSON.stringify(key)} is not unique`,
        samples: [key],
      })

    return ok({
      output: kind === 'inner' || kind === 'left' ? { type: t.record(fields), origins } : left,
      run: (inputs, ctx) => {
        const lrows = inputs(p.left)
        const built = index(inputs(p.right), rightKeys, rightUnique)
        if (built.duplicate) return violated('right', built.duplicate)
        if (leftUnique) {
          const checked = index(lrows, leftKeys, true)
          if (checked.duplicate) return violated('left', checked.duplicate)
        }
        const byKey = built.byKey as Map<string, Rec[]>
        const rows: Rec[] = []
        for (const l of lrows) {
          const nullKey = leftKeys.some((k) => (l[k] ?? null) === null)
          const candidates = nullKey ? [] : (byKey.get(keyOf(l, leftKeys)) ?? [])
          const matches: Rec[] = []
          for (const r of candidates) {
            const merged = { ...l, ...project(r) }
            if (!where || where(null, merged, ctx)) matches.push(merged)
          }
          if (kind === 'semi') {
            if (matches.length > 0) rows.push(l)
          } else if (kind === 'anti') {
            if (matches.length === 0) rows.push(l)
          } else if (matches.length > 0) rows.push(...matches)
          else if (kind === 'left') rows.push({ ...l, ...nullRight })
        }
        return ok({ rows })
      },
    })
  },
})
