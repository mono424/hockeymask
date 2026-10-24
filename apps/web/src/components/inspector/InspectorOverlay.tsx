import type { CompileIssue, MappingVersion, NodeJson } from '@hockeymask/core'
import { useState } from 'react'
import { type InspectorMode, NodeInspector } from './NodeInspector'

/**
 * The inspector card floating over the canvas. It animates in when a step is selected and
 * out when the selection clears; the last node stays rendered until the exit finishes.
 */
export function InspectorOverlay({
  version,
  node,
  issues,
  right,
  onChange,
  onClose,
}: {
  version: MappingVersion
  node: NodeJson | null
  issues: readonly CompileIssue[]
  /** Distance from the right edge, past the agent panel when it is open. */
  right: number
  onChange: (version: MappingVersion) => void
  onClose: () => void
}) {
  const [shown, setShown] = useState<NodeJson | null>(node)
  const [closing, setClosing] = useState(false)
  const [mode, setMode] = useState<InspectorMode>('form')

  // Follow the selection during render: a new node shows at once, a cleared one plays out.
  if (node && node !== shown) {
    setShown(node)
    if (closing) setClosing(false)
  } else if (!node && shown && !closing) {
    setClosing(true)
  }

  if (!shown) return null
  return (
    <div className="insp-anchor inset-motion" style={{ right }}>
      <aside
        aria-label="Step settings"
        className={`insp-card ${closing ? 'is-closing' : ''}`}
        inert={closing}
        onAnimationEnd={(e) => {
          if (closing && e.target === e.currentTarget) {
            setShown(null)
            setClosing(false)
          }
        }}
      >
        <NodeInspector
          version={version}
          node={shown}
          issues={issues}
          mode={mode}
          onMode={setMode}
          onChange={onChange}
          onClose={onClose}
        />
      </aside>
    </div>
  )
}
