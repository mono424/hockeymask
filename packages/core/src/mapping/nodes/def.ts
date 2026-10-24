/**
 * Collection node definitions.
 *
 * A node definition compiles itself: from its params and the types of its inputs it returns
 * its output type and a closure, in one step, so type checking and compilation stay the same
 * pass. Nodes reference their inputs by id; `slots` say which params hold those ids, which is
 * all the graph utilities and the editor need to know about edges.
 */

import { z } from 'zod'
import type { GraphEnv, RecordEnv, RunContext } from '../context'
import type { Action, JsonSchema, MappingVersion, NodeExpectation } from '../document'
import type { CompileCode, Result } from '../result'
import type { MType, RecordType } from '../types'
import type { Json, Relation } from '../values'

/** Where a field's value was produced, so a sink can blame the right `map` field. */
export interface Origin {
  readonly node: string
  readonly field: string
  /** The field may be absent from a record (`omit_if_null`, `on_error: skip_field`). */
  readonly omittable: boolean
  /** Type of the value when present; set exactly for omittable fields. */
  readonly present?: MType
}

/**
 * Compile-time output of a node: its record type plus per-field provenance. Invariants: every
 * field has an origin, and an omittable field is typed nullable (an absent field reads null).
 */
export interface NodeOutput {
  readonly type: RecordType
  readonly origins: Readonly<Record<string, Origin>>
  /** Can drop records on a failed field. */
  readonly canSkip?: boolean
}

/** An input slot: the param path that holds an upstream node id. */
export interface Slot {
  readonly id: string
  readonly label: string
  readonly path: readonly string[]
  /** Holds a list of ids (`union.inputs`). */
  readonly multiple?: boolean
  readonly optional?: boolean
}

export type NodeCategory = 'source' | 'transform' | 'target' | 'check'

/** What a node definition sees while compiling. */
export interface NodeEnv {
  readonly id: string
  readonly graph: GraphEnv
  readonly version: Pick<
    MappingVersion,
    'params' | 'tables' | 'expectedSchema' | 'onError' | 'expect'
  >
  /** This node's entry in the version's `expect` block. */
  readonly expect?: NodeExpectation
  readonly clock: { used: boolean }
  /** Output of an upstream node; the compiler only calls `compile` once all inputs exist. */
  input(id: string): NodeOutput
  recordEnv(record: RecordType): RecordEnv
}

export interface NodeIssue {
  readonly message: string
  readonly code?: CompileCode
  /** Blame another node, e.g. the `map` that produced a field a sink rejects. */
  readonly node?: string
  readonly field?: string
  readonly step?: number
}

/** A problem found while running, reported on the run rather than failing it. */
export interface RunIssue {
  readonly node: string
  readonly code: string
  readonly message: string
  readonly field?: string
  readonly clause?: string
  readonly action?: Action
  readonly count?: number
  readonly rowsAffected?: number
  readonly samples?: readonly Json[]
}

export interface SinkWrite {
  readonly sink: string
  readonly target: string
  /** Target paths of the upsert key. */
  readonly key: readonly string[]
  /** Rows by target path, sorted by key. Dates are `YYYY-MM-DD`, timestamps ISO. */
  readonly rows: readonly Readonly<Record<string, Json>>[]
  readonly write?: Readonly<Record<string, WritePolicy>>
  /**
   * Reference fields written as natural keys, by target path. The host resolves each value
   * (one field of `by`, or a list in `by` order) to the id of the `entity` row it names.
   */
  readonly refs?: Readonly<Record<string, SinkRef>>
  /**
   * The rows are the complete set of the target for the company (and source system, where
   * the identity has one): the host calls `synchronize_all(rows, scope)`, deleting rows not
   * written. Writes of one run go in one transaction, inserts parent-first and deletes
   * child-first (join-table rows before the entities they reference). A sink that does not write
   * (held, stopped, failed) deletes nothing.
   */
  readonly mode?: 'replace'
}

export type WritePolicy = 'overwrite' | 'fill_if_null' | 'never'

export interface SinkRef {
  readonly entity: string
  readonly by: readonly string[]
}

export interface Metric {
  readonly node: string
  readonly name: string
  readonly rows: readonly Readonly<Record<string, Json>>[]
}

export interface NodeRun {
  readonly rows: Relation
  /** Records a `map` dropped under `skip_record`. */
  readonly skipped?: number
  /** Rows dropped or repaired by an action. */
  readonly changed?: number
  readonly issues?: readonly RunIssue[]
  readonly stop?: boolean
  readonly skipDownstream?: boolean
  readonly write?: SinkWrite
  readonly metric?: Metric
}

export interface NodeFailure {
  readonly code: string
  readonly message: string
  /** Halts the run (`on_error: fail_sync`). */
  readonly stop?: boolean
  readonly issues?: readonly RunIssue[]
  readonly samples?: readonly Json[]
}

export type Inputs = (id: string) => Relation

export interface RunOptions {
  /** Previous output count of this node, for `count.shiftRatio`. */
  readonly baseline?: number
  /** Fixture runs are sample-sized, so production `count` envelopes are skipped. */
  readonly skipCount?: boolean
}

export interface CompiledNode {
  /** Null for a node without an output relation (`sink`); `metrics` types what it reports. */
  readonly output: NodeOutput | null
  /** Target entities a sink writes (one sink per entity, structural rule 4). */
  readonly writes?: readonly string[]
  readonly run: (
    inputs: Inputs,
    ctx: RunContext,
    options?: RunOptions,
  ) => Result<NodeRun, NodeFailure>
}

export interface NodeDef<P = unknown> {
  readonly op: string
  readonly label: string
  readonly category: NodeCategory
  readonly description: string
  readonly slots: readonly Slot[]
  /** Has an output edge. */
  readonly output: boolean
  /** Has an effect: a write, a metric, or a check. Every node must reach one. */
  readonly effect?: 'sink' | 'metrics' | 'check'
  /** Params a new node starts with in the editor. */
  readonly defaults: () => Record<string, unknown>
  /** Parses the node object without `id`, `op` and `label`. */
  readonly params: z.ZodType<P>
  /** Accepts `tolerate_skips` (arch.md, "Failure policy and partial results"). */
  readonly toleratesSkips?: (params: P) => boolean
  readonly compile: (params: P, env: NodeEnv) => Result<CompiledNode, readonly NodeIssue[]>
}

export function defineNode<P>(def: NodeDef<P>): NodeDef<P> {
  return def
}

export const nodeId = z.string().min(1)

/** Origins for fields a node produces itself. */
export function ownOrigins(node: string, type: RecordType): Record<string, Origin> {
  return Object.fromEntries(
    Object.keys(type.fields).map((field) => [field, { node, field, omittable: false }]),
  )
}

/** Shorthand for a single issue result. */
export function fail(message: string, extra: Omit<NodeIssue, 'message'> = {}) {
  return { ok: false as const, error: [{ message, ...extra }] as readonly NodeIssue[] }
}

export type { JsonSchema }
