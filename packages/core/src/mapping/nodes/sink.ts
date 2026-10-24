/**
 * `sink`: upserts its input on `key` into the internal model. Every input field is written to
 * the target path it names (`product.sku`, or a bare `sku` on the sink's own `target`), or
 * to the path `columns` renames it to. Types are enforced here against the host's
 * `TargetSchema`: an unknown path, a wrong type, or a nullable value for a required field
 * fails at save, blamed on the `map` field that produced it.
 *
 * A reference field listed in `refs` is written as a natural key of the entity it references
 * (`product_id` as a SKU, a join-table row as its two keys) and typed by those fields, so a
 * key of the wrong shape fails at save; the host resolves it to an id when it writes. Key
 * fields must be non-null, except a nullable identity field of an entity whose identity
 * matches NULLs as equal (a transfer with no origin, `from_warehouse_id = NULL`).
 *
 * `mode: 'replace'` makes the rows the complete set of the target for the company: the host
 * reconciles with `synchronize_all`, deleting rows this run no longer produces. That is what a
 * presence-only entity needs (a join-table row *is* the link). Because a short source read
 * would then delete real rows, `in` must carry a `count` expectation with a lower bound
 * (`min` or `shiftRatio.min`) whose action is `stop` or `skip_downstream`.
 *
 * The library performs no write: a run returns the rows, sorted by key, for the host.
 */

import { z } from 'zod'
import type { TargetEntity, TargetField, TargetSchema } from '../../schema'
import { resolveAction } from '../expect'
import { err, ok, type Result } from '../result'
import { type Instant, toDateString } from '../time'
import {
  assignable,
  fromLogicalType,
  type MType,
  mayBeNull,
  nullableIf,
  show,
  stripNull,
  t,
} from '../types'
import { compareVals, type Json, keyOf, type Rec, toJson, type Val } from '../values'
import {
  defineNode,
  nodeId,
  type NodeIssue,
  type Origin,
  type SinkRef,
  type WritePolicy,
} from './def'

const params = z.strictObject({
  in: nodeId,
  target: z.string().min(1),
  key: z.array(z.string().min(1)).min(1),
  columns: z.record(z.string(), z.string().min(1)).optional(),
  write: z.record(z.string(), z.enum(['overwrite', 'fill_if_null', 'never'])).optional(),
  refs: z.record(z.string(), z.strictObject({ by: z.array(z.string().min(1)).min(1) })).optional(),
  mode: z.enum(['upsert', 'replace']).optional(),
})

interface Resolved {
  readonly entity: TargetEntity
  readonly field: TargetField
  readonly type: MType
}

/** `entity.field` names any entity; a bare name is a field of the sink's own target. */
export function resolveTarget(
  targets: TargetSchema,
  target: string,
  path: string,
): Result<Resolved, string> {
  const dot = path.indexOf('.')
  const [entityName, fieldName] =
    dot < 0 ? [target, path] : [path.slice(0, dot), path.slice(dot + 1)]
  const entity = targets.entities.find((e) => e.name === entityName)
  if (!entity) return err(`target has no entity '${entityName}'`)
  const field = entity.fields.find((f) => f.name === fieldName)
  if (!field) return err(`${entityName} has no field '${fieldName}'`)
  return ok({ entity, field, type: nullableIf(fromLogicalType(field.logicalType), field.nullable) })
}

/**
 * The type of a reference field written as a natural key: the type of its one `by` field of
 * the referenced entity, or a tuple of them in `by` order (each with its own nullability).
 */
export function refType(
  targets: TargetSchema,
  field: TargetField,
  by: readonly string[],
): Result<{ entity: string; type: MType }, string> {
  if (!field.references) return err(`${field.name} is not a reference`)
  const entity = targets.entities.find((e) => e.name === field.references)
  if (!entity) return err(`target has no entity '${field.references}'`)
  const parts: MType[] = []
  for (const name of by) {
    const part = entity.fields.find((f) => f.name === name)
    if (!part) return err(`${entity.name} has no field '${name}'`)
    parts.push(nullableIf(fromLogicalType(part.logicalType), part.nullable))
  }
  const value = parts.length === 1 ? stripNull(parts[0] as MType) : t.tuple(parts)
  return ok({ entity: entity.name, type: nullableIf(value, field.nullable) })
}

/** A nullable key field is allowed where the target identity matches NULLs as equal. */
const nullsEqual = ({ entity, field }: Resolved) =>
  field.nullable && entity.nullsNotDistinct === true && entity.identity.includes(field.name)

export const sinkNode = defineNode({
  op: 'sink',
  label: 'Write to target',
  category: 'target',
  description: 'Writes rows into a target entity, updating records with the same key.',
  slots: [{ id: 'in', label: 'In', path: ['in'] }],
  output: false,
  effect: 'sink',
  defaults: () => ({ in: '', target: '', key: [] }),
  params,
  compile: (p, env) => {
    const input = env.input(p.in)
    const issues: NodeIssue[] = []
    const targets = env.graph.targets
    if (!targets.entities.some((e) => e.name === p.target)) {
      return { ok: false, error: [{ message: `target has no entity '${p.target}'` }] }
    }
    const fieldNames = Object.keys(input.type.fields)
    for (const name of [
      ...Object.keys(p.columns ?? {}),
      ...Object.keys(p.write ?? {}),
      ...Object.keys(p.refs ?? {}),
    ]) {
      if (!fieldNames.includes(name))
        issues.push({ message: `'${name}' is not a field of ${p.in}` })
    }

    const paths: Record<string, string> = {}
    const logical: Record<string, TargetField['logicalType']> = {}
    const resolvedOf: Record<string, Resolved> = {}
    const refs: Record<string, SinkRef> = {}
    const entities = new Set([p.target])
    for (const name of fieldNames) {
      const path = p.columns?.[name] ?? name
      const origin = input.origins[name] as Origin
      const blame = { node: origin.node, field: origin.field }
      const resolved = resolveTarget(targets, p.target, path)
      if (!resolved.ok) {
        issues.push({ message: resolved.error, ...blame })
        continue
      }
      let expected = resolved.value.type
      const ref = p.refs?.[name]
      if (ref) {
        const typed = refType(targets, resolved.value.field, ref.by)
        if (!typed.ok) {
          issues.push({ message: `refs.${name}: ${typed.error}` })
          continue
        }
        expected = typed.value.type
        refs[path] = { entity: typed.value.entity, by: ref.by }
      }
      const type = input.type.fields[name] as MType
      const present = origin.present ?? type
      if (!assignable(present, expected)) {
        issues.push({
          message: `${path} expects ${show(expected)}, got ${show(present)}`,
          ...blame,
        })
      }
      paths[name] = path
      logical[name] = resolved.value.field.logicalType
      resolvedOf[name] = resolved.value
      entities.add(resolved.value.entity.name)
    }
    for (const k of p.key) {
      const type = input.type.fields[k]
      const resolved = resolvedOf[k]
      if (!type) issues.push({ message: `key '${k}' is not a field of ${p.in}` })
      else if (
        mayBeNull(type) &&
        ((input.origins[k] as Origin).omittable || !resolved || !nullsEqual(resolved))
      ) {
        issues.push({ message: `key '${k}' must be non-null, got ${show(type)}` })
      }
    }
    if (p.mode === 'replace') {
      const exp = env.version.expect[p.in]
      const lower = exp?.count?.min !== undefined || exp?.count?.shiftRatio?.min !== undefined
      const action = resolveAction(exp?.onFail, 'count')
      if (!lower || (action !== 'stop' && action !== 'skip_downstream')) {
        issues.push({
          message: `mode 'replace' deletes rows this run does not produce; give ${p.in} a count expectation with a lower bound and onFail stop or skip_downstream`,
        })
      }
    }
    if (issues.length) return { ok: false, error: issues }

    const keyPaths = p.key.map((k) => paths[k] as string)
    const write = p.write
      ? Object.fromEntries(
          Object.entries(p.write).map(([f, w]) => [paths[f] as string, w as WritePolicy]),
        )
      : undefined

    return ok({
      output: null,
      writes: [...entities].sort(),
      run: (inputs, ctx) => {
        // Key fields are never omittable, so every row has them (null only where allowed).
        const rows = [...inputs(p.in)].sort((a, b) => {
          for (const k of p.key) {
            const c = compareVals(a[k] as Val, b[k] as Val)
            if (c !== 0) return c
          }
          return 0
        })
        for (let i = 1; i < rows.length; i++) {
          if (keyOf(rows[i] as Rec, p.key) === keyOf(rows[i - 1] as Rec, p.key)) {
            const sample = p.key.map((k) => toJson((rows[i] as Rec)[k] as Val))
            return err({
              code: 'duplicate_key',
              message: `${p.key.join(', ')} ${JSON.stringify(sample)} is written twice`,
              samples: [sample],
            })
          }
        }
        const out = rows.map((row) => {
          const target: Record<string, Json> = {}
          for (const name of fieldNames) {
            if (!Object.hasOwn(row, name)) continue
            const v = row[name] ?? null
            const kind = logical[name]
            target[paths[name] as string] =
              v !== null && kind === 'date' ? toDateString(v as Instant, ctx.tz) : toJson(v)
          }
          return target
        })
        return ok({
          rows: out,
          write: {
            sink: env.id,
            target: p.target,
            key: keyPaths,
            rows: out,
            ...(write ? { write } : {}),
            ...(Object.keys(refs).length ? { refs } : {}),
            ...(p.mode === 'replace' ? { mode: 'replace' as const } : {}),
          },
        })
      },
    })
  },
})
