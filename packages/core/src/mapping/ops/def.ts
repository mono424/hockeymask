/**
 * Record op definitions.
 *
 * An op is a params schema, a type function and a curried implementation. `signature` is
 * the validator's half; `run` binds params once per compiled version and returns the
 * per-record step. With `nulls: 'propagate'` the pipeline compiler handles a null input, so
 * `run` never sees null and `signature` never sees a nullable type.
 */

import { z } from 'zod'
import type { RecordContext, RecordEnv } from '../context'
import { err, ok, type Result, type StepError } from '../result'
import type { MType } from '../types'
import type { Omitted, Val } from '../values'

export type StepResult = Result<Val | Omitted, StepError>

export type Step = (input: Val, ctx: RecordContext) => StepResult

export interface OpDef<P = unknown> {
  readonly name: string
  /** Parses the step object without its `op` key. Unknown keys are rejected. */
  readonly params: z.ZodType<P>
  /** Who handles a null input: the compiler ('propagate') or this op ('consume'). */
  readonly nulls: 'propagate' | 'consume'
  /**
   * What the op reads: 'value' (default) needs a piped value; 'none' starts a pipeline and
   * takes no piped input; 'any' accepts either (`when`).
   */
  readonly input?: 'value' | 'none' | 'any'
  /** Must be the last step (`omit_if_null`). */
  readonly terminal?: boolean
  /** Whether this op can return an error at runtime, given its params. */
  readonly fallible: (params: P, env: RecordEnv, input: MType) => boolean
  /** Output type for an input type; an error message when the input is not accepted. */
  readonly signature: (input: MType, params: P, env: RecordEnv) => Result<MType, string>
  /** Bind params once; `input` is the (null-stripped) input type `signature` accepted. */
  readonly run: (params: P, env: RecordEnv, input: MType) => Step
}

/** Identity function that keeps `P` inferred from the params schema. */
export function defineOp<P>(def: OpDef<P>): OpDef<P> {
  return def
}

export const never = () => false
export const always = () => true

/** Expect an exact non-null kind. */
export function expectKind(
  input: MType,
  kinds: readonly MType['kind'][],
  op: string,
): Result<MType, string> {
  return kinds.includes(input.kind)
    ? ok(input)
    : err(`${op} expects ${kinds.join(' or ')}, got ${showKind(input)}`)
}

function showKind(input: MType): string {
  return input.kind === 'nullable'
    ? `${input.of.kind}?`
    : input.kind === 'unit'
      ? 'no input'
      : input.kind
}

/** JSON literal accepted in params. */
export const json: z.ZodType<import('../values').Json> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(json),
    z.record(z.string(), json),
  ]),
)

/** Strict object schema, so a typo'd param is an error rather than ignored. */
export const params = <S extends z.ZodRawShape>(shape: S) => z.strictObject(shape)
