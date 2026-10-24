/** Shared fixtures for mapping tests: a frozen run context and terse pipeline runners. */

import type { FnDef, RecordEnv, RunContext } from '../../src/mapping/context'
import { recordEnv } from '../../src/mapping/context'
import { type CompiledPipeline, compileSteps } from '../../src/mapping/pipeline'
import { compileVersion } from '../../src/mapping/compile'
import { parseVersion } from '../../src/mapping/document'
import { execute } from '../../src/mapping/execute'
import { Instant } from '../../src/mapping/time'
import { type MType, show, t } from '../../src/mapping/types'
import type { Json, Rec } from '../../src/mapping/values'

export const NOW = Instant.parse('2026-10-04T12:00:00Z') as Instant

export function runContext(over: Partial<RunContext> = {}): RunContext {
  return {
    now: NOW,
    tz: 'UTC',
    locale: 'en',
    snapshot: {},
    params: {},
    tables: {},
    run: { syncRunId: 'run-1', mappingVersionId: 'version-1' },
    ...over,
  }
}

export interface PipeOptions {
  /** Field types of the current record. */
  fields?: Readonly<Record<string, MType>>
  params?: Readonly<Record<string, Json>>
  tables?: Readonly<Record<string, Readonly<Record<string, Json>>>>
  functions?: Readonly<Record<string, FnDef>>
  /** Input type for the first step; defaults to `t.unit` (a top-level pipeline). */
  input?: MType
  depth?: number
}

export function env(options: PipeOptions = {}): RecordEnv {
  return recordEnv(t.record(options.fields ?? {}), {
    params: options.params,
    tables: options.tables,
    functions: options.functions,
    depth: options.depth,
  })
}

/** Compile a pipeline, returning the compiled form or throwing the compile issue. */
export function compile(steps: readonly unknown[], options: PipeOptions = {}): CompiledPipeline {
  const result = compileSteps(steps, env(options), options.input)
  if (!result.ok) throw new Error(`step ${result.error.step}: ${result.error.message}`)
  return result.value
}

/** Compile and return the issue message, or throw if it compiles. */
export function compileError(steps: readonly unknown[], options: PipeOptions = {}): string {
  const result = compileSteps(steps, env(options), options.input)
  if (result.ok) throw new Error('expected a compile error')
  return result.error.message
}

/** Run a compiled pipeline on one record (and an optional piped input). */
export function run(
  compiled: CompiledPipeline,
  record: Rec = {},
  input: import('../../src/mapping/values').Val = null,
  ctx: Partial<RunContext> = {},
) {
  return compiled.run(input, { ...runContext(ctx), record })
}

/** Compile and run; returns the value or throws with the runtime error. */
export function evaluate(
  steps: readonly unknown[],
  record: Rec = {},
  options: PipeOptions & {
    ctx?: Partial<RunContext>
    value?: import('../../src/mapping/values').Val
  } = {},
) {
  const r = run(compile(steps, options), record, options.value ?? null, options.ctx)
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.detail}`)
  return r.value
}

/** `show` of the compiled pipeline's output type. */
export function typeOf(steps: readonly unknown[], options: PipeOptions = {}): string {
  return show(compile(steps, options).type)
}

/** Compile and run, expecting a runtime error; returns it or throws if the run succeeds. */
export function evaluateError(
  steps: readonly unknown[],
  record: Rec = {},
  options: PipeOptions & {
    ctx?: Partial<RunContext>
    value?: import('../../src/mapping/values').Val
  } = {},
) {
  const r = run(compile(steps, options), record, options.value ?? null, options.ctx)
  if (r.ok) throw new Error(`expected a runtime error, got ${JSON.stringify(r.value)}`)
  return r.error
}

// --- graph-level helpers ------------------------------------------------------------------

type FieldSpec =
  | 'string'
  | 'number'
  | 'boolean'
  | 'string?'
  | 'number?'
  | 'boolean?'
  | 'list<string>'

/** A source `expectedSchema` from a compact field map; `?` marks nullable (optional) fields. */
export function schemaOf(fields: Readonly<Record<string, FieldSpec>>): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const [name, spec] of Object.entries(fields)) {
    if (spec === 'list<string>') properties[name] = { type: 'array', items: { type: 'string' } }
    else properties[name] = { type: spec.replace('?', '') }
    if (!spec.endsWith('?')) required.push(name)
  }
  return { type: 'object', required, properties }
}

/** A target model from a compact map: entity -> field -> logical type (`?` = nullable). */
export function targetsOf(
  entities: Readonly<Record<string, Readonly<Record<string, string>>>> = {},
): import('../../src/schema').TargetSchema {
  return {
    name: 'test',
    entities: Object.entries(entities).map(([name, fields]) => ({
      name,
      description: null,
      identity: [],
      fields: Object.entries(fields).map(([field, type]) => ({
        name: field,
        logicalType: type.replace('?', '') as import('../../src/schema').LogicalType,
        nullable: type.endsWith('?'),
        description: null,
        unit: null,
        references: null,
      })),
    })),
  }
}

export function versionOf(
  input: Partial<import('../../src/mapping/document').MappingVersionInput>,
): import('../../src/mapping/document').MappingVersion {
  return parseVersion({ id: 'test', ...input })
}

/** Compile or throw with the issues. */
export function planOf(
  version: import('../../src/mapping/document').MappingVersion,
  env: Partial<import('../../src/mapping/context').GraphEnv> = {},
): import('../../src/mapping/compile').Plan {
  const compiled = compileVersion(version, { targets: targetsOf(), ...env })
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.issues, null, 2))
  return compiled.plan
}

/** Compile and return the issues (empty if it compiles). */
export function issuesOf(
  version: import('../../src/mapping/document').MappingVersion,
  env: Partial<import('../../src/mapping/context').GraphEnv> = {},
): readonly import('../../src/mapping/result').CompileIssue[] {
  return compileVersion(version, { targets: targetsOf(), ...env }).issues
}

/** Execute with a fixed clock; `retain` on so node outputs can be inspected. */
export function runOf(
  plan: import('../../src/mapping/compile').Plan,
  snapshot: import('../../src/mapping/execute').Snapshot,
  options: import('../../src/mapping/execute').ExecuteOptions & { tz?: string } = {},
): import('../../src/mapping/execute').RunResult {
  return execute(
    plan,
    snapshot,
    { now: NOW, tz: options.tz ?? 'UTC' },
    { retain: true, clock: () => 0, ...options },
  )
}
