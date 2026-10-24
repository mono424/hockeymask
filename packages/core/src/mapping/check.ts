/**
 * The draft-save gate: everything that must hold before a version may be published, as one
 * list of located issues. `validateStructure` is the subset that needs no host environment,
 * cheap enough to run in the editor on every change.
 */

import { compileVersion, type Plan, structuralIssues } from './compile'
import type { GraphEnv } from './context'
import type { MappingVersion, NodeJson } from './document'
import { type ExampleResult, runExamples } from './examples'
import { nodeRegistry } from './nodes'
import type { CompileIssue } from './result'

export interface CheckResult {
  readonly ok: boolean
  readonly issues: readonly CompileIssue[]
  readonly plan?: Plan
  readonly examples?: readonly ExampleResult[]
}

/** Compile, then run every example; publishable only if `ok`. */
export function checkVersion(version: MappingVersion, env: GraphEnv): CheckResult {
  const compiled = compileVersion(version, env)
  if (!compiled.ok) return { ok: false, issues: compiled.issues }
  const examples = runExamples(compiled.plan)
  const issues: CompileIssue[] = examples.flatMap((e) => {
    const label = `example ${e.name ?? e.index}`
    return [
      ...e.failures.map((f) => ({ code: 'example_failed' as const, message: `${label}: ${f}` })),
      ...e.diffs.map((d) => ({
        code: 'example_failed' as const,
        node: d.node,
        message: `${label}: ${d.node} is missing ${d.missing.length} and has ${d.unexpected.length} unexpected records`,
      })),
    ]
  })
  return { ok: issues.length === 0, issues, plan: compiled.plan, examples }
}

/** Structure and params only: no types, no target schema. */
export function validateStructure(version: MappingVersion): CompileIssue[] {
  const issues = structuralIssues(version)
  for (const node of version.nodes) {
    const def = Object.hasOwn(nodeRegistry, node.op) ? nodeRegistry[node.op] : undefined
    if (!def) continue
    const { id: _id, op: _op, label: _label, ...params } = node as NodeJson
    const parsed = def.params.safeParse(params)
    if (parsed.success) continue
    for (const x of parsed.error.issues) {
      issues.push({
        code: 'invalid_params',
        message: `${x.path.length ? `${x.path.join('.')}: ` : ''}${x.message}`,
        node: node.id,
      })
    }
  }
  return issues
}
