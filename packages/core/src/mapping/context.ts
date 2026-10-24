/**
 * Contexts: the only channel through which a node or step learns anything not in its input.
 * They hold frozen data, never clocks, clients or handles.
 *
 * `RunContext` / `RecordContext` exist at sync time. `GraphEnv` (from the host) and
 * `RecordEnv` (built by the compiler) exist at compile time.
 */

import type { TargetSchema } from '../schema'
import type { Result, StepError } from './result'
import type { Instant } from './time'
import type { MType, RecordType } from './types'
import type { Json, Rec, Relation, Val } from './values'

export interface RunContext {
  /** Clock frozen at the start of the run. The only source of "now". */
  readonly now: Instant
  readonly tz: string
  readonly locale: string
  /** Every source, read once at run start and frozen, keyed by `source` node id. */
  readonly snapshot: Readonly<Record<string, Relation>>
  /** Named constants of the version. */
  readonly params: Readonly<Record<string, Json>>
  /** Static lookup tables of the version, for the `lookup` op. */
  readonly tables: Readonly<Record<string, Readonly<Record<string, Json>>>>
  readonly run: { readonly syncRunId: string; readonly mappingVersionId: string }
}

export interface RecordContext extends RunContext {
  /** The record under mapping inside a `map` node. */
  readonly record: Rec
}

/** A reviewed, version-pinned record function for the `fn` op (escape hatch). */
export interface FnDef {
  /** Accepted input type; omitted means any. */
  readonly input?: MType
  readonly output: MType
  /** Whether it can return an error. Defaults to true. */
  readonly fallible?: boolean
  readonly run: (value: Val, ctx: RecordContext) => Result<Val, StepError>
}

/** A reviewed, version-pinned collection function for the `transform` node (escape hatch). */
export interface TransformDef {
  readonly run: (inputs: readonly Relation[], ctx: RunContext) => Result<Relation, string>
}

/** What the host supplies to compile a version. */
export interface GraphEnv {
  /** The internal model sinks write to; also the schema of `system: "internal"` sources. */
  readonly targets: TargetSchema
  readonly functions?: Readonly<Record<string, FnDef>>
  readonly transforms?: Readonly<Record<string, TransformDef>>
}

/** Compile-time view of a record scope: field pipelines, predicates. */
export interface RecordEnv {
  /** Type of the current record, against which `extract` and `path` are checked. */
  readonly record: RecordType
  readonly params: Readonly<Record<string, Json>>
  readonly tables: Readonly<Record<string, Readonly<Record<string, Json>>>>
  readonly functions: Readonly<Record<string, FnDef>>
  /** `each` nesting depth; capped at 1. */
  readonly depth: number
  /** Set when anything resolves against the run clock (`today`, `now`). */
  readonly clock: { used: boolean }
}

/** Type of a record field, or an error naming the missing field. */
export function fieldType(record: RecordType, path: string): Result<MType, string> {
  const type = Object.hasOwn(record.fields, path) ? record.fields[path] : undefined
  return type
    ? { ok: true, value: type }
    : {
        ok: false,
        error: `unknown field '${path}' (record has ${Object.keys(record.fields).join(', ') || 'no fields'})`,
      }
}

export function recordEnv(
  record: RecordType,
  from: Partial<Omit<RecordEnv, 'record'>> = {},
): RecordEnv {
  return {
    record,
    params: from.params ?? {},
    tables: from.tables ?? {},
    functions: from.functions ?? {},
    depth: from.depth ?? 0,
    clock: from.clock ?? { used: false },
  }
}
