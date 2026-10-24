import type { CatalogEntry, NodeJson } from '@hockeymask/core'
import { Handle, type NodeProps, Position } from '@xyflow/react'
import { createContext, type ReactNode, useContext } from 'react'
import { type FlowNode, nodeTitle, OUTPUT_HANDLE } from './adapters'

/** Host hooks for what the package can't know: an icon and a one-line summary per node. */
export interface NodeRenderers {
  renderNodeIcon?: (node: NodeJson, entry: CatalogEntry | undefined) => ReactNode
  describeNode?: (node: NodeJson, entry: CatalogEntry | undefined) => ReactNode
}

export const NodeRenderersContext = createContext<NodeRenderers>({})

const TAGS = { source: 'Source', transform: 'Transform', target: 'Target', check: 'Check' } as const

interface Port {
  readonly id: string
  readonly label: string
}

const OUTPUT: readonly Port[] = [{ id: OUTPUT_HANDLE, label: 'Out' }]

function Check() {
  return (
    <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
      <path d="M2.5 6.5 5 9l4.5-6" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}

/**
 * Handles for one side. A single port gets a bare handle centred on the card edge; several
 * ports get one labelled row each, so the user can tell e.g. a join's left from its right.
 */
function Ports({ ports, side }: { ports: readonly Port[]; side: 'in' | 'out' }) {
  const type = side === 'in' ? 'target' : 'source'
  const position = side === 'in' ? Position.Left : Position.Right
  if (ports.length === 1) {
    const [port] = ports as [Port]
    return <Handle id={port.id} type={type} position={position} className="hm-handle" />
  }
  return ports.map((port) => (
    <div key={port.id} className={`hm-port hm-port--${side}`}>
      <Handle id={port.id} type={type} position={position} className="hm-handle" />
      {port.label}
    </div>
  ))
}

/** One node: category tag, icon + label, one summary line, and an issue badge if any. */
export function GraphNodeView({ data, selected }: NodeProps<FlowNode>) {
  const { node, entry, issues } = data
  const { renderNodeIcon, describeNode } = useContext(NodeRenderersContext)
  const category = entry?.category
  const icon = renderNodeIcon?.(node, entry)
  const description = describeNode?.(node, entry)
  const problems = entry ? issues.length : 1
  const classes = [
    'hm-node',
    `hm-node--${category ?? 'unknown'}`,
    selected ? 'hm-node--selected' : '',
    problems > 0 ? 'hm-node--error' : '',
  ]
  return (
    <div className={classes.filter(Boolean).join(' ')}>
      <span className="hm-node__tag">
        {category === 'target' && <Check />}
        {category ? TAGS[category] : 'Unknown'}
      </span>
      <header className="hm-node__header">
        {icon && <span className="hm-node__icon">{icon}</span>}
        <span className="hm-node__label">{nodeTitle(node)}</span>
        {problems > 0 && (
          <span className="hm-node__issues" title={issues.map((i) => i.message).join('\n')}>
            {entry ? `${problems} ${problems === 1 ? 'issue' : 'issues'}` : 'unknown op'}
          </span>
        )}
      </header>
      {description && <p className="hm-node__description">{description}</p>}
      {entry && (
        <>
          <Ports ports={entry.slots} side="in" />
          {entry.output && <Ports ports={OUTPUT} side="out" />}
        </>
      )}
    </div>
  )
}
