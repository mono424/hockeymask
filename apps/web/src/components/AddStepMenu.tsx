import { nodeCatalog } from '@hockeymask/core'
import type { NodeTemplate } from '@hockeymask/react'
import { Plus, Search } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { useTables, useTargetSchema } from '../api'
import { formatCount, shortTableName } from '../format'
import { NodeIcon } from './icons'

interface Item {
  key: string
  label: string
  meta?: ReactNode
  template: NodeTemplate
}

/** "+ Add step": one searchable menu for sources, transforms and target entities. */
export function AddStepMenu({
  source,
  onPick,
}: {
  source: string
  onPick: (template: NodeTemplate) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const root = useRef<HTMLDivElement>(null)
  const tables = useTables(open ? source : undefined)
  const schema = useTargetSchema()

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  const groups: { title: string; items: Item[] }[] = [
    {
      title: 'From source',
      items: (tables.data ?? []).map((t) => ({
        key: `table:${t.name}`,
        label: shortTableName(t.name),
        meta: formatCount(t.rowCount),
        template: {
          op: 'source',
          params: { system: source, entity: t.name },
          label: shortTableName(t.name),
        },
      })),
    },
    {
      title: 'Transform',
      items: nodeCatalog
        .filter((entry) => entry.category === 'transform')
        .map((entry) => ({ key: entry.op, label: entry.label, template: { op: entry.op } })),
    },
    {
      title: 'To target',
      items: (schema.data?.entities ?? []).map((e) => ({
        key: `entity:${e.name}`,
        label: e.name,
        template: { op: 'sink', params: { target: e.name }, label: e.name },
      })),
    },
  ]
  const term = query.trim().toLowerCase()
  const visible = groups
    .map((g) => ({ ...g, items: g.items.filter((i) => i.label.toLowerCase().includes(term)) }))
    .filter((g) => g.items.length > 0)

  const pick = (template: NodeTemplate) => {
    onPick(template)
    setOpen(false)
    setQuery('')
  }

  return (
    <div ref={root} className="relative" onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 rounded-full border border-line bg-panel px-3.5 py-1.5 text-[13px] font-medium shadow-lg shadow-black/30 hover:bg-raised"
      >
        <Plus size={15} strokeWidth={1.5} /> Add step
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-2 w-72 overflow-hidden rounded-2xl border border-line bg-panel shadow-2xl shadow-black/50">
          <label className="flex items-center gap-2 border-b border-line px-3 py-2.5 text-muted">
            <Search size={14} strokeWidth={1.5} />
            <input
              autoFocus
              className="w-full bg-transparent text-[13px] text-fg outline-none placeholder:text-faint"
              placeholder="Search tables, steps, entities"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <div className="max-h-96 overflow-y-auto p-1.5">
            {visible.map((group) => (
              <section key={group.title} className="mb-1">
                <h3 className="px-2 pt-1.5 pb-1 text-[11px] font-medium text-faint">
                  {group.title}
                </h3>
                {group.items.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => pick(item.template)}
                    className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[13px] hover:bg-raised"
                  >
                    <span className="text-muted">
                      <NodeIcon op={item.template.op} />
                    </span>
                    <span className="truncate">{item.label}</span>
                    {item.meta && (
                      <span className="ml-auto font-mono text-[11px] text-faint">{item.meta}</span>
                    )}
                  </button>
                ))}
              </section>
            ))}
            {visible.length === 0 && (
              <p className="px-2 py-3 text-[12px] text-faint">Nothing matches.</p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
