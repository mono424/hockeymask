/**
 * The mapping document (arch.md, "The mapping document"): one version of a mapping, stored as
 * JSON. It carries the graph (`nodes`), the assumptions about each source (`expectedSchema`,
 * which is also the type environment), expectations about what nodes produce (`expect`),
 * named constants (`params`), lookup tables (`tables`) and fixtures (`examples`).
 *
 * Nodes are flat objects, `{ id, op, ...params }`, and reference their inputs by id; there is
 * no edge list. Node params are validated by the node's definition when the version compiles,
 * so a draft with a half-edited node still parses. `layout` is editor state only.
 */

import { z } from 'zod'
import { json } from './ops/def'

export const OnError = z.enum(['null', 'skip_field', 'skip_record', 'fail_sync'])
export type OnError = z.infer<typeof OnError>

export const Action = z.union([
  z.enum(['alert', 'drop_rows', 'skip_downstream', 'stop']),
  z.strictObject({ set_null: z.array(z.string().min(1)).min(1) }),
  z.strictObject({ set_default: z.record(z.string(), json) }),
])
export type Action = z.infer<typeof Action>

export const CLAUSES = ['count', 'unique', 'keyed', 'rows'] as const
export type Clause = (typeof CLAUSES)[number]

/** One action for every clause, or one per clause with a fallback. */
export const ActionSpec = z.union([
  Action,
  z.strictObject({
    default: Action.optional(),
    count: Action.optional(),
    unique: Action.optional(),
    keyed: Action.optional(),
    rows: Action.optional(),
  }),
])
export type ActionSpec = z.infer<typeof ActionSpec>

export const Bound = z.strictObject({ min: z.number().optional(), max: z.number().optional() })
export type Bound = z.infer<typeof Bound>

export const NodeExpectation = z.strictObject({
  /** Absolute bounds, and drift relative to a baseline the host passes per run. */
  count: Bound.extend({ shiftRatio: Bound.optional() }).optional(),
  /** Fields whose combination must be unique in the node's output. */
  unique: z.array(z.string().min(1)).min(1).optional(),
  /** Bounds on individual rows of a small keyed relation, typically counters. */
  keyed: z
    .strictObject({
      by: z.string().min(1),
      value: z.string().min(1),
      bounds: z.record(z.string(), Bound.extend({ onFail: Action.optional() })),
    })
    .optional(),
  /** A predicate every row must satisfy. */
  rows: z.strictObject({ cond: z.unknown() }).optional(),
  onFail: ActionSpec.optional(),
  note: z.string().optional(),
})
export type NodeExpectation = z.infer<typeof NodeExpectation>

const Rows = z.array(z.record(z.string(), json))

/** A fixture: relations in, keyed by source node id; relations out, keyed by any node id. */
export const Example = z.strictObject({
  name: z.string().optional(),
  sources: z.record(z.string(), Rows).default({}),
  expect: z.record(z.string(), Rows).default({}),
  /** Frozen clock for the fixture run (ISO instant); required if the graph reads the clock. */
  now: z.string().optional(),
  tz: z.string().optional(),
})
export type Example = z.infer<typeof Example>

export const NodeJson = z.looseObject({
  id: z.string().min(1),
  op: z.string().min(1),
  label: z.string().optional(),
})
export type NodeJson = z.infer<typeof NodeJson>

export const Position = z.object({ x: z.number(), y: z.number() })
export type Position = z.infer<typeof Position>

/** One JSON Schema document per source node, describing one record of that source. */
export const JsonSchema = z.record(z.string(), z.unknown())
export type JsonSchema = Readonly<Record<string, unknown>>

export const MappingVersion = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  version: z.number().int().min(1).default(1),
  status: z.enum(['draft', 'published']).default('draft'),
  /** Default `on_error` of `map` nodes; a node's own `on_error` overrides it. */
  onError: OnError.optional(),
  unknownFields: z.enum(['ignore', 'notify']).optional(),
  params: z.record(z.string(), json).default({}),
  tables: z.record(z.string(), z.record(z.string(), json)).default({}),
  expectedSchema: z.record(z.string(), JsonSchema).default({}),
  nodes: z.array(NodeJson).default([]),
  expect: z.record(z.string(), NodeExpectation).default({}),
  examples: z.array(Example).default([]),
  layout: z.record(z.string(), Position).optional(),
})
export type MappingVersion = z.infer<typeof MappingVersion>
/** A version as authored, before defaults are filled in. */
export type MappingVersionInput = z.input<typeof MappingVersion>

/** Parse untrusted JSON into a version; throws a zod error with paths on failure. */
export function parseVersion(input: unknown): MappingVersion {
  return MappingVersion.parse(input)
}

export function emptyVersion(id: string, name?: string): MappingVersion {
  return parseVersion(name === undefined ? { id } : { id, name })
}

/** JSON Schema of the mapping document, for tools and models that produce mappings. */
export function versionJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(MappingVersion, { io: 'input' }) as Record<string, unknown>
}
