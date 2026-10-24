/**
 * Failure as a value. Steps, nodes and the compiler return `Result` instead of throwing, so
 * the executor can apply each node's failure policy (arch.md,
 * "Failure policy and partial results").
 */

export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E }

export function ok<T>(value: T): { readonly ok: true; readonly value: T } {
  return { ok: true, value }
}

/** The value of a result the caller has already checked, e.g. by `signature` before `run`. */
export function expectOk<T>(result: Result<T, unknown>): T {
  if (!result.ok) throw new Error(`unexpected failure: ${JSON.stringify(result.error)}`)
  return result.value
}

export function err<E>(error: E): { readonly ok: false; readonly error: E } {
  return { ok: false, error }
}

/** What a failing record op reports. The pipeline adds the op and step, the map the node. */
export type ErrorCode =
  | 'type_mismatch'
  | 'parse_failed'
  | 'unknown_unit'
  | 'lookup_miss'
  | 'required_null'
  | 'domain_error'
  | 'fn_failed'

export interface StepError {
  readonly code: ErrorCode
  readonly detail: string
}

/** A runtime failure located in the graph. */
export interface MappingError extends StepError {
  readonly node: string
  readonly op: string
  readonly step?: number
  readonly key?: string
}

export function stepError(code: ErrorCode, detail: string): { ok: false; error: StepError } {
  return err({ code, detail })
}

/** A problem found while checking a version, located as precisely as possible. */
export interface CompileIssue {
  readonly code: CompileCode
  readonly message: string
  readonly node?: string
  /** The `map` field key, aggregate field name, or expectation clause. */
  readonly field?: string
  /** Index of the step inside the field pipeline. */
  readonly step?: number
}

export type CompileCode =
  | 'invalid_params'
  | 'unknown_op'
  | 'type_error'
  | 'duplicate_id'
  | 'dangling_ref'
  | 'missing_input'
  | 'cycle'
  | 'dead_node'
  | 'missing_schema'
  | 'duplicate_sink'
  | 'skip_tolerance'
  | 'missing_expectation'
  | 'invalid_expectation'
  | 'unknown_reference'
  | 'example_failed'
