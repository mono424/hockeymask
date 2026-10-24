/**
 * The step compiler (arch.md, "Type checking"): a fold over the steps of one field pipeline
 * that threads a value type and a closure. Nullability is lifted here, so an op marked
 * `nulls: 'propagate'` never sees null: a null input skips it and stays null.
 */

import type { RecordContext, RecordEnv } from './context'
import { opRegistry } from './ops'
import type { Step } from './ops/def'
import { err, ok, type Result, type StepError } from './result'
import { expandStep, type StepJson } from './sugar'
import { mayBeNull, type MType, stripNull, t } from './types'
import type { Omitted, Val } from './values'

export interface PipelineError extends StepError {
  readonly step: number
  readonly op: string
}

export interface CompiledPipeline {
  readonly type: MType
  /** Can return an error at runtime. */
  readonly fallible: boolean
  /** Ends in `omit_if_null`: the field may be left out of the record. */
  readonly omittable: boolean
  readonly run: (input: Val, ctx: RecordContext) => Result<Val | Omitted, PipelineError>
}

export interface StepIssue {
  readonly step: number
  readonly message: string
}

const NULL_RESULT = ok(null)

/** Compile a pipeline. Top-level pipelines start from `t.unit`; `each` passes the element type. */
export function compileSteps(
  raw: readonly unknown[],
  env: RecordEnv,
  input: MType = t.unit,
): Result<CompiledPipeline, StepIssue> {
  if (raw.length === 0) return err({ step: 0, message: 'a pipeline needs at least one step' })

  let type = input
  let fallible = false
  let omittable = false
  const steps: Step[] = []
  const names: string[] = []

  for (const [i, value] of raw.entries()) {
    const issue = (message: string) => err({ step: i, message })
    if (typeof value !== 'object' || value === null || typeof (value as StepJson).op !== 'string') {
      return issue('a step is an object with an "op"')
    }
    const expanded = expandStep(value as StepJson)
    if (!expanded.ok) return issue(expanded.error)
    const { op, ...rest } = expanded.value
    const def = Object.hasOwn(opRegistry, op) ? opRegistry[op] : undefined
    if (!def) return issue(`unknown op '${op}'`)
    if (omittable) return issue(`${names.at(-1)} must be the last step`)

    const params = def.params.safeParse(rest)
    if (!params.success) {
      return issue(
        `${op}: ${params.error.issues.map((x) => `${x.path.length ? `${x.path.join('.')}: ` : ''}${x.message}`).join('; ')}`,
      )
    }

    const mode = def.input ?? 'value'
    if (mode === 'none' && type.kind !== 'unit') {
      return issue(`${op} starts a pipeline; it cannot follow another step`)
    }
    if (mode === 'value' && type.kind === 'unit') {
      return issue(`${op} needs an input; start the pipeline with extract, const, coalesce or when`)
    }

    // Nullability is lifted here, so the op only ever sees a non-null input.
    const propagate = def.nulls === 'propagate'
    const lifted = propagate && mayBeNull(type)
    const inner = propagate ? stripNull(type) : type
    if (inner.kind === 'never') return issue(`${op} receives only null; nothing to do`)

    const out = def.signature(inner, params.data, env)
    if (!out.ok) return issue(out.error)

    const bound = def.run(params.data, env, inner)
    steps.push(lifted ? (v, ctx) => (v === null ? NULL_RESULT : bound(v, ctx)) : bound)
    names.push(op)
    type = lifted ? t.nullable(out.value) : out.value
    fallible ||= def.fallible(params.data, env, inner)
    omittable = def.terminal === true
  }

  return ok({
    type,
    fallible,
    omittable,
    run: (input, ctx) => {
      let v: Val | Omitted = input
      for (let i = 0; i < steps.length; i++) {
        const r = (steps[i] as Step)(v as Val, ctx)
        if (!r.ok) return err({ ...r.error, step: i, op: names[i] as string })
        v = r.value
      }
      return ok(v)
    },
  })
}
