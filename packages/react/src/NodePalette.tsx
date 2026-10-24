import {
  addNode,
  type CatalogEntry,
  type MappingVersion,
  type NodeCategory,
  nodeCatalog,
  type NodeJson,
} from '@hockeymask/core'
import type { ReactNode } from 'react'
import { freePosition, writeNodeTemplate } from './adapters'

const TITLES: Record<NodeCategory, string> = {
  source: 'Sources',
  transform: 'Transforms',
  target: 'Targets',
  check: 'Checks',
}

export interface NodePaletteProps {
  value: MappingVersion
  onChange: (version: MappingVersion) => void
  /** Called with the node a click added, e.g. to select it. */
  onAdded?: (node: NodeJson) => void
  /** Which categories to offer; all by default. */
  categories?: readonly NodeCategory[]
  /** Optional icon per node op, rendered before its label. */
  renderIcon?: (entry: CatalogEntry) => ReactNode
  /** 'horizontal' renders one compact row, e.g. a toolbar over the canvas. */
  orientation?: 'vertical' | 'horizontal'
  className?: string
}

/** Core's node ops by category. Click to add, or drag onto a GraphBuilder. */
export function NodePalette({
  value,
  onChange,
  onAdded,
  categories = ['source', 'transform', 'check', 'target'],
  orientation = 'vertical',
  renderIcon,
  className,
}: NodePaletteProps) {
  const add = (op: string) => {
    const { version, node } = addNode(value, op, { position: freePosition(value, op) })
    onChange(version)
    onAdded?.(node)
  }
  const classes = ['hm-palette', `hm-palette--${orientation}`, className]
  return (
    <nav className={classes.filter(Boolean).join(' ')} aria-label="Node types">
      {categories.map((category) => {
        const entries = nodeCatalog.filter((entry) => entry.category === category)
        if (entries.length === 0) return null
        return (
          <section key={category} className="hm-palette__group">
            <h3 className="hm-palette__title">{TITLES[category]}</h3>
            {entries.map((entry) => (
              <button
                key={entry.op}
                type="button"
                draggable
                className={`hm-palette__item hm-palette__item--${category}`}
                title={entry.description}
                onClick={() => add(entry.op)}
                onDragStart={(event) => writeNodeTemplate(event.dataTransfer, { op: entry.op })}
              >
                {renderIcon && <span className="hm-palette__icon">{renderIcon(entry)}</span>}
                <span className="hm-palette__label">{entry.label}</span>
                <span className="hm-palette__type">{entry.op}</span>
              </button>
            ))}
          </section>
        )
      })}
    </nav>
  )
}
