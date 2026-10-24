/**
 * Sugar, kept for readability and expanded on save.
 *
 * - `{ op: "if_<predicate>", <operand>, then, else? }` expands to a one-case `when`, e.g.
 *   `{ op: "if_lte", value: 0, then: null }` to
 *   `{ op: "when", cases: [{ cond: { lte: 0 }, then: null }] }`.
 * - `{ op: "lookup_entity", entity, by, field, on_miss? }` expands into a `source` for the
 *   internal entity, an `n:1` left `join` on `by`, and an `extract` of `field` (see
 *   `normalizeVersion`).
 */

import { z } from 'zod'
import type { GraphEnv } from './context'
import type { MappingVersion, NodeJson } from './document'
import { entityJsonSchema } from './jsonschema'
import { PREDICATES } from './predicate'
import { type CompileIssue, err, ok, type Result } from './result'

const OPERAND_KEYS = ['value', 'values', 'date', 'pattern'] as const
const SUGAR_PREDICATES = new Set<string>(
  PREDICATES.filter((p) => !['all', 'any', 'not'].includes(p)),
)

export type StepJson = { readonly op: string } & { readonly [key: string]: unknown }

/** Expand one step if it is sugar; other steps pass through unchanged. */
export function expandStep(raw: StepJson): Result<StepJson, string> {
  const m = /^if_(.+)$/.exec(raw.op)
  if (!m) return ok(raw)
  const predicate = m[1] as string
  if (!SUGAR_PREDICATES.has(predicate)) return err(`unknown op '${raw.op}'`)
  const { op: _op, then, else: otherwise, path, ...rest } = raw
  if (!('then' in raw)) return err(`${raw.op} needs "then"`)

  const extra = Object.keys(rest).filter((k) => !(OPERAND_KEYS as readonly string[]).includes(k))
  if (extra.length) return err(`${raw.op} does not take ${extra.join(', ')}`)
  const given = OPERAND_KEYS.filter((k) => k in rest)
  const presence = predicate === 'is_null' || predicate === 'is_blank'
  if (presence ? given.length > 0 : given.length !== 1) {
    return err(
      presence
        ? `${raw.op} takes no comparison value`
        : `${raw.op} takes exactly one of ${OPERAND_KEYS.join(', ')}`,
    )
  }
  const operand = presence ? true : rest[given[0] as string]
  const cond = { ...(path === undefined ? {} : { path }), [predicate]: operand }
  return ok({
    op: 'when',
    cases: [{ cond, then }],
    ...(otherwise === undefined ? {} : { else: otherwise }),
  })
}

const LookupEntity = z.strictObject({
  op: z.literal('lookup_entity'),
  entity: z.string().min(1),
  by: z.string().min(1),
  field: z.string().min(1).default('id'),
  on_miss: z.enum(['null', 'pass', 'error']).optional(),
})

const isStep = (v: unknown): v is StepJson =>
  typeof v === 'object' && v !== null && typeof (v as StepJson).op === 'string'

/** Expand `if_*` steps (also inside `each`); report `lookup_entity` where it cannot go. */
function expandPipeline(
  steps: readonly unknown[],
  nested: boolean,
  issue: (message: string, step: number) => void,
): unknown[] {
  return steps.map((step, i) => {
    if (!isStep(step)) return step
    if (nested && step.op === 'lookup_entity') {
      issue('lookup_entity cannot be used inside each', i)
      return step
    }
    if (step.op === 'each' && Array.isArray(step.pipeline)) {
      return {
        ...step,
        pipeline: expandPipeline(step.pipeline, true, (m) => issue(`each: ${m}`, i)),
      }
    }
    const expanded = expandStep(step)
    if (expanded.ok) return expanded.value
    issue(expanded.error, i)
    return step
  })
}

interface Rewrite {
  readonly generated: NodeJson[]
  readonly node: NodeJson
}

/** Rewrite the `lookup_entity` steps of one map node into generated nodes. */
function rewriteLookups(
  node: NodeJson,
  env: Pick<GraphEnv, 'targets'>,
  sources: Set<string>,
  issues: CompileIssue[],
): Rewrite {
  const generated: NodeJson[] = []
  let input = node.in
  const drop = Array.isArray(node.drop) ? [...(node.drop as string[])] : []
  let n = 0
  const fields = (node.fields as unknown[]).map((raw) => {
    const f = raw as { key?: unknown; pipeline?: unknown }
    if (typeof f !== 'object' || f === null || !Array.isArray(f.pipeline)) return raw
    const key = String(f.key)
    const issue = (message: string, step: number) =>
      issues.push({ code: 'invalid_params', message, node: node.id, field: key, step })
    const pipeline = expandPipeline(f.pipeline, false, issue)
    const at = pipeline.findIndex((s) => isStep(s) && s.op === 'lookup_entity')
    if (at < 0) return { ...f, pipeline }
    if (pipeline.findLastIndex((s) => isStep(s) && s.op === 'lookup_entity') !== at) {
      issue('use one lookup_entity per field; resolve the others in an upstream map', at)
      return { ...f, pipeline }
    }
    const parsed = LookupEntity.safeParse(pipeline[at])
    if (!parsed.success) {
      issue(
        `lookup_entity: ${parsed.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ')}`,
        at,
      )
      return { ...f, pipeline }
    }
    if (at === 0) {
      issue('lookup_entity needs a key; extract it first', at)
      return { ...f, pipeline }
    }
    const { entity, by, field, on_miss: onMiss } = parsed.data
    if (!env.targets.entities.some((e) => e.name === entity)) {
      issue(`lookup_entity: unknown entity '${entity}'`, at)
      return { ...f, pipeline }
    }
    n += 1
    const prefix = pipeline.slice(0, at) as StepJson[]
    const only = prefix[0] as StepJson
    let keyField: string
    if (prefix.length === 1 && only.op === 'extract' && typeof only.path === 'string') {
      keyField = only.path
    } else {
      // A computed key is materialised as a field of a preceding map first.
      keyField = `__${key}__key`
      const helper: NodeJson = {
        id: `${node.id}__key${n}`,
        op: 'map',
        in: input,
        keep: 'all',
        fields: [{ key: keyField, pipeline: prefix }],
        ...(node.on_error === undefined ? {} : { on_error: node.on_error }),
      }
      generated.push(helper)
      input = helper.id
      drop.push(keyField)
    }
    const source = `__internal_${entity}`
    if (!sources.has(source)) {
      sources.add(source)
      generated.push({ id: source, op: 'source', system: 'internal', entity })
    }
    const valueField = `__${key}__lookup`
    const join: NodeJson = {
      id: `${node.id}__lookup${n}`,
      op: 'join',
      left: input,
      right: source,
      on: [[keyField, by]],
      type: 'left',
      cardinality: 'n:1',
      select: { [field]: valueField },
      tolerate_skips: true,
    }
    generated.push(join)
    input = join.id
    drop.push(valueField)
    const head: StepJson[] =
      onMiss === 'pass'
        ? [{ op: 'coalesce', paths: [valueField, keyField] }]
        : onMiss === 'error'
          ? [
              { op: 'extract', path: valueField },
              { op: 'require', message: `no ${entity} with ${by} equal to the key` },
            ]
          : [{ op: 'extract', path: valueField }]
    return { ...f, pipeline: [...head, ...pipeline.slice(at + 1)] }
  })
  if (n === 0) return { generated, node: { ...node, fields } }
  const keepAll = node.keep === 'all'
  return {
    generated,
    node: { ...node, in: input, fields, ...(keepAll ? { drop } : {}) },
  }
}

/**
 * The form a version is stored and compiled in: sugar expanded, `lookup_entity` rewritten
 * into graph nodes, and every internal source's schema pinned from the target model.
 * Idempotent.
 */
export function normalizeVersion(
  version: MappingVersion,
  env: Pick<GraphEnv, 'targets'>,
): { version: MappingVersion; issues: CompileIssue[] } {
  const issues: CompileIssue[] = []
  const sources = new Set(version.nodes.filter((n) => n.op === 'source').map((n) => n.id))
  const nodes: NodeJson[] = []
  for (const node of version.nodes) {
    if (node.op !== 'map' || !Array.isArray(node.fields)) {
      nodes.push(node)
      continue
    }
    const rewrite = rewriteLookups(node, env, sources, issues)
    nodes.push(...rewrite.generated, rewrite.node)
  }
  const expectedSchema = { ...version.expectedSchema }
  for (const node of nodes) {
    if (node.op !== 'source' || node.system !== 'internal' || expectedSchema[node.id]) continue
    const entity = env.targets.entities.find((e) => e.name === node.entity)
    if (entity) expectedSchema[node.id] = entityJsonSchema(entity)
  }
  return { version: { ...version, nodes, expectedSchema }, issues }
}
