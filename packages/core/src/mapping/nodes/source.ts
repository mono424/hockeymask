/**
 * `source`: one entity of an external or internal system, read once per run into the
 * snapshot. Its record type comes from the version's `expectedSchema` entry for this node.
 * Loading checks every value against that type; a violation fails the node, so nothing
 * downstream runs on data the version never claimed to handle.
 */

import { z } from 'zod'
import { conformRows, type FieldViolation, sourceRecordType } from '../jsonschema'
import { compilePredicate, nonNullPaths, type Test } from '../predicate'
import { err, ok, type Result } from '../result'
import { type MType, type RecordType, stripNull, t } from '../types'
import type { Rec, Relation } from '../values'
import {
  defineNode,
  fail,
  type NodeFailure,
  type NodeIssue,
  type NodeOutput,
  type Origin,
  ownOrigins,
  type RunIssue,
} from './def'

const params = z.strictObject({
  system: z.string().min(1),
  entity: z.string().min(1),
  filter: z.unknown().optional(),
})

/**
 * Narrow the fields a passing filter guarantees are non-null (and so present). The condition
 * has compiled against `output`, so every path it names exists.
 */
export function narrow(output: NodeOutput, cond: unknown): NodeOutput {
  const fields = { ...output.type.fields }
  const origins = { ...output.origins }
  for (const path of nonNullPaths(cond)) {
    fields[path] = stripNull(fields[path] as MType)
    const origin = origins[path] as Origin
    origins[path] = { node: origin.node, field: origin.field, omittable: false }
  }
  return { ...output, type: t.record(fields), origins }
}

/** Shared by `source` and `transform`: conform rows, or fail with one issue per field. */
export function loadRows(
  node: string,
  rows: readonly Readonly<Record<string, unknown>>[],
  type: RecordType,
): Result<Rec[], NodeFailure> {
  const loaded = conformRows(rows, type)
  if (loaded.violations.length === 0) return ok(loaded.rows)
  const issues: RunIssue[] = loaded.violations.map((v: FieldViolation) => ({
    node,
    code: 'schema_violation',
    field: v.field,
    message: `${v.field}: ${v.count} values are not ${v.expected}`,
    count: v.count,
    samples: v.samples,
  }))
  return err({
    code: 'schema_violation',
    message: `${loaded.violations.length} fields do not match the declared schema`,
    issues,
  })
}

export const sourceNode = defineNode({
  op: 'source',
  label: 'Source',
  category: 'source',
  description: 'Reads one entity of a source system into the run snapshot.',
  slots: [],
  output: true,
  defaults: () => ({ system: '', entity: '' }),
  params,
  compile: (p, env) => {
    const schema = env.version.expectedSchema[env.id]
    if (!schema) {
      return fail(`no expectedSchema for source '${env.id}'`, { code: 'missing_schema' })
    }
    const declared = sourceRecordType(schema)
    if (!declared.ok) return fail(declared.error, { code: 'missing_schema' })
    const type = declared.value

    let test: Test | undefined
    if (p.filter !== undefined) {
      const compiled = compilePredicate(p.filter, env.recordEnv(type))
      if (!compiled.ok)
        return { ok: false, error: [{ message: `filter: ${compiled.error}` }] as NodeIssue[] }
      test = compiled.value
    }
    const declaredOutput: NodeOutput = { type, origins: ownOrigins(env.id, type) }
    const output = test ? narrow(declaredOutput, p.filter) : declaredOutput

    return ok({
      output,
      run: (_inputs, ctx) => {
        const loaded = loadRows(env.id, ctx.snapshot[env.id] ?? [], type)
        if (!loaded.ok) return loaded
        const rows: Relation = test
          ? loaded.value.filter((r) => (test as Test)(null, r, ctx))
          : loaded.value
        return ok({ rows })
      },
    })
  },
})
