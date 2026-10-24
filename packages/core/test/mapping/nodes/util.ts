/** Tiny graphs for node tests: `s` (source) -> `n` (the node under test) -> `out` (metrics). */

import type { GraphEnv } from '../../../src/mapping/context'
import type { MappingVersionInput } from '../../../src/mapping/document'
import type { Plan } from '../../../src/mapping/compile'
import type { Snapshot } from '../../../src/mapping/execute'
import type { NodeOutput } from '../../../src/mapping/nodes'
import { issuesOf, planOf, runOf, schemaOf, versionOf } from '../helpers'

export type Fields = Parameters<typeof schemaOf>[0]

/** A version with source `s` of `fields`, the node `n`, and a metrics node reading `n`. */
export function single(
  node: Record<string, unknown>,
  fields: Fields,
  extra: Partial<MappingVersionInput> = {},
): ReturnType<typeof versionOf> {
  const { expectedSchema, nodes, ...rest } = extra
  return versionOf({
    expectedSchema: { s: schemaOf(fields), ...expectedSchema },
    nodes: [
      { id: 's', op: 'source', system: 'x', entity: 'y' },
      { ...('inputs' in node || 'left' in node ? {} : { in: 's' }), ...node, id: 'n' } as {
        id: string
        op: string
      },
      { id: 'out', op: 'metrics', in: 'n', name: 'm' },
      ...(nodes ?? []),
    ],
    ...rest,
  })
}

/** Output of `n` for the given source rows. */
export function outputOf(
  node: Record<string, unknown>,
  fields: Fields,
  rows: Snapshot[string],
  extra: Partial<MappingVersionInput> = {},
  env: Partial<GraphEnv> = {},
) {
  const run = runOf(planOf(single(node, fields, extra), env), { s: rows })
  return run.outputs?.n
}

/** Compile issues of `n` (messages only). */
export function messagesOf(
  node: Record<string, unknown>,
  fields: Fields,
  extra: Partial<MappingVersionInput> = {},
  env: Partial<GraphEnv> = {},
): string[] {
  return issuesOf(single(node, fields, extra), env).map((i) => i.message)
}

/** Compile-time output of node `id` in a plan. */
export function outputAt(plan: Plan, id = 'n'): NodeOutput {
  const output = plan.nodes.find((n) => n.id === id)?.output
  if (!output) throw new Error(`node ${id} has no output`)
  return output
}
