/**
 * What the engineer has on screen, as plain text for the agent. The page registers these
 * with assistant-ui, which sends them as `system` with every message, so the agent always
 * knows what "this mapping" or "the selected step" means.
 */

import { type CompileIssue, type MappingVersion, inputIds } from '@hockeymask/core'
import { type GraphRef, type Integration, KINDS } from '../integrations'
import { type Bench, feedStatus, sourcesOf } from '../testbench'

/** Issues listed in the context; the agent reads the rest with get_mapping. */
const ISSUE_LIMIT = 15
/** The selected step's JSON is cut beyond this. */
const NODE_CHARS = 3_000

const quote = (text: string) => `“${text}”`
const param = (value: unknown) => (typeof value === 'string' && value ? value : '?')

export function describeIntegrations(
  integrations: readonly Integration[],
  open: { integration: Integration | null; graph: GraphRef | null },
): string {
  if (integrations.length === 0) {
    return 'The engineer has no integrations yet. They add one with the + on the left rail; you cannot.'
  }
  const lines = integrations.map((i) => {
    const mappings = i.graphs.length
      ? i.graphs
          .map((g) => `${quote(g.name)} (\`${g.id}\`${g.id === open.graph?.id ? ', open' : ''})`)
          .join(', ')
      : 'none'
    const kind = KINDS[i.kind].label.replace(' (demo)', '')
    const current = i.id === open.integration?.id ? ', open' : ''
    return `- ${quote(i.name)} (\`${i.id}\`, ${kind}, source \`${i.kind}\`${current}): mappings ${mappings}`
  })
  return ['Integrations:', ...lines].join('\n')
}

export function describeMapping({
  graph,
  version,
  unsaved,
  view,
  selectedId,
  issues,
  bench,
}: {
  graph: GraphRef
  version: MappingVersion
  unsaved: boolean
  view: 'builder' | 'testbench'
  selectedId: string | null
  issues: readonly CompileIssue[]
  bench: Bench
}): string {
  const lines = [
    `Open mapping: ${quote(graph.name)} (\`${graph.id}\`), in the ${view === 'builder' ? 'builder' : 'testbench'} view, ${unsaved ? 'with unsaved changes' : 'saved'}.`,
  ]

  if (version.nodes.length === 0) {
    lines.push('It has no steps yet.')
  } else {
    lines.push('Steps:')
    for (const node of version.nodes) {
      const inputs = inputIds(node)
      const what =
        node.op === 'source'
          ? `${param(node.system)} ${param(node.entity)}`
          : node.op === 'sink'
            ? `writes ${param(node.target)}`
            : node.op === 'map' && Array.isArray(node.fields)
              ? `${node.fields.length} fields`
              : null
      lines.push(
        `- \`${node.id}\` ${node.op}${node.label ? ` ${quote(node.label)}` : ''}${inputs.length ? ` <- ${inputs.join(', ')}` : ''}${what ? `: ${what}` : ''}`,
      )
    }
  }

  const selected = version.nodes.find((n) => n.id === selectedId)
  if (selected) {
    const json = JSON.stringify(selected)
    lines.push(
      `The engineer has step \`${selected.id}\` selected, open in the inspector:`,
      json.length > NODE_CHARS ? `${json.slice(0, NODE_CHARS)}…` : json,
    )
  }

  if (issues.length === 0) {
    lines.push('No issues.')
  } else {
    lines.push(`Issues (${issues.length}):`)
    for (const issue of issues.slice(0, ISSUE_LIMIT)) {
      const where = [issue.node, issue.field].filter(Boolean).join(' · ')
      lines.push(`- ${where ? `${where}: ` : ''}${issue.message}`)
    }
    if (issues.length > ISSUE_LIMIT) lines.push(`- … ${issues.length - ISSUE_LIMIT} more`)
  }

  const { feeds, run } = bench
  if (view === 'testbench' || run) {
    const fed = sourcesOf(version).map((n) => {
      const status = feedStatus(feeds[n.id])
      if ('error' in status) return `\`${n.id}\` invalid JSON`
      return `\`${n.id}\` ${status.rows} row${status.rows === 1 ? '' : 's'}`
    })
    lines.push(`Testbench rows: ${fed.length ? fed.join(', ') : 'no sources'}.`)
    if (run?.errors.length) lines.push(`Last run failed: ${run.errors.join(' ')}`)
    else if (run?.result) {
      const sinks = run.result.sinks
        .map((s) => `${s.sink} ${s.status}${s.write ? ` ${s.write.rows.length} rows` : ''}`)
        .join(', ')
      lines.push(
        `Last run: ${run.result.status}${sinks ? `; ${sinks}` : ''}; ${run.result.issues.length} run issues.`,
      )
    }
  }
  return lines.join('\n')
}
