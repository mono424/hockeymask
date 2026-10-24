import type { LogicalType } from '@hockeymask/core'
import { ChevronDown, ChevronLeft, Search, X } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { ApiError } from '../api'

/** Green / red / grey (not known yet) dot. */
export function StatusDot({ ok, title }: { ok: boolean | undefined; title?: string }) {
  const tone = ok === undefined ? 'bg-faint' : ok ? 'bg-ok' : 'bg-down'
  return <span title={title} className={`inline-block size-1.5 shrink-0 rounded-full ${tone}`} />
}

/** A field or column name; customer-defined ones get the highlighter tint. */
export function FieldName({ name, custom = false }: { name: string; custom?: boolean }) {
  return <span className={`truncate font-mono ${custom ? 'marker' : ''}`}>{name}</span>
}

export function TypeLabel({ type, unit }: { type: LogicalType; unit?: string | null }) {
  return (
    <span className="ml-auto shrink-0 font-mono text-[11px] text-faint">
      {type}
      {unit ? ` · ${unit}` : ''}
    </span>
  )
}

export function ErrorState({ error }: { error: unknown }) {
  const unreachable = error instanceof ApiError && error.unreachable
  return (
    <p className="px-4 py-1 text-[12px] text-down">
      {error instanceof Error ? error.message : String(error)}
      {unreachable && <span className="text-muted"> Start the demo with `pnpm dev`.</span>}
    </p>
  )
}

export function Loading({ what = 'Loading' }: { what?: string }) {
  return <p className="px-4 py-1 text-[12px] text-faint">{what}…</p>
}

/** Where a side panel floats over the main card; slides in and out from its edge. */
export function PanelSlot({
  side,
  open,
  children,
}: {
  side: 'left' | 'right'
  open: boolean
  children: ReactNode
}) {
  return (
    <div className={`panel-slot panel-slot--${side} ${open ? 'is-open' : ''}`} inert={!open}>
      {children}
    </div>
  )
}

/** A side panel card: title row with a close button, optional search, scrolling body. */
/** A small search box (panel sections, lists). */
export function SearchField({
  value,
  onChange,
  placeholder,
}: {
  value: string
  onChange: (value: string) => void
  placeholder: string
}) {
  return (
    <label className="mb-1 flex h-8 shrink-0 items-center gap-2 rounded-md border border-line bg-canvas px-2.5 text-faint transition-colors focus-within:border-line-strong">
      <Search size={13} strokeWidth={1.5} />
      <input
        className="w-full bg-transparent text-[12.5px] text-fg outline-none placeholder:text-faint"
        placeholder={placeholder}
        aria-label={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  )
}

/** Side panel widths; the agent's chat gets more room than the input panel. */
export const PANEL_WIDTH = 264
export const AGENT_WIDTH = 360

/**
 * The side panel card: a header row (a title, or custom content such as a select) with a close
 * button, then a scrolling body.
 */
export function Panel({
  title,
  header,
  footer,
  onClose,
  fill = false,
  width = PANEL_WIDTH,
  children,
}: {
  title: string
  /** Replaces the title in the header row; `title` still labels the close button. */
  header?: ReactNode
  /** Pinned below the scrolling body. */
  footer?: ReactNode
  onClose: () => void
  /** The body lays out and scrolls its own content (e.g. a chat with a pinned composer). */
  fill?: boolean
  width?: number
  children: ReactNode
}) {
  return (
    <aside
      className="card flex shrink-0 flex-col overflow-hidden"
      style={{ width }}
      aria-label={title}
    >
      <header className={`flex h-12 shrink-0 items-center gap-1 pr-2 ${header ? 'pl-2' : 'pl-4'}`}>
        {header ? (
          <div className="min-w-0 flex-1">{header}</div>
        ) : (
          <h2 className="flex-1 text-[13px] font-semibold tracking-[-0.01em]">{title}</h2>
        )}
        <button
          type="button"
          aria-label={`Close ${title}`}
          className="grid size-7 shrink-0 place-items-center rounded-md text-faint transition-colors hover:bg-raised hover:text-fg"
          onClick={onClose}
        >
          <X size={15} strokeWidth={1.5} />
        </button>
      </header>
      <div className={`min-h-0 flex-1 ${fill ? 'flex flex-col' : 'overflow-y-auto px-2 pb-3'}`}>
        {children}
      </div>
      {footer && <footer className="shrink-0 border-t border-line p-2">{footer}</footer>}
    </aside>
  )
}

/** A collapsible group inside a panel, chevron on the right like the reference. */
export function Section({
  title,
  meta,
  defaultOpen = true,
  children,
}: {
  title: ReactNode
  meta?: ReactNode
  defaultOpen?: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  const Chevron = open ? ChevronDown : ChevronLeft
  return (
    <section className="mt-3 first:mt-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="group flex h-7 w-full items-center gap-2 rounded-md px-2 text-[12px] font-medium text-muted transition-colors hover:text-fg"
      >
        <span className="flex min-w-0 items-center gap-2">{title}</span>
        {meta !== undefined && (
          <span className="ml-auto text-[11.5px] text-faint tabular-nums">{meta}</span>
        )}
        <Chevron
          size={13}
          strokeWidth={1.5}
          className={`text-faint transition-colors group-hover:text-muted ${meta === undefined ? 'ml-auto' : ''}`}
        />
      </button>
      {open && <div className="mt-0.5 flex flex-col gap-px">{children}</div>}
    </section>
  )
}

/**
 * A list item with an icon tile. With `children` it expands (rendered only while open, so
 * nested queries stay lazy); with `onDragStart` it can be dragged onto the canvas.
 */
/** Inline name editor: Enter or leaving the field finishes, Escape restores the old name. */
export function NameInput({
  value,
  label,
  className = '',
  onDone,
}: {
  value: string
  label: string
  className?: string
  onDone: (name: string) => void
}) {
  return (
    <input
      autoFocus
      aria-label={label}
      className={`field text-[13px] ${className}`}
      defaultValue={value}
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') e.currentTarget.value = value
        if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur()
      }}
      onBlur={(e) => onDone(e.currentTarget.value.trim())}
    />
  )
}

export function ListItem({
  icon,
  label,
  meta,
  actions,
  active = false,
  forceOpen = false,
  onClick,
  onDragStart,
  children,
}: {
  icon: ReactNode
  label: ReactNode
  meta?: ReactNode
  /** Up to two small buttons, shown at the right end while the row is hovered or focused. */
  actions?: ReactNode
  active?: boolean
  forceOpen?: boolean
  onClick?: () => void
  onDragStart?: (event: React.DragEvent) => void
  children?: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const expanded = forceOpen || open
  const Chevron = expanded ? ChevronDown : ChevronLeft
  return (
    <div className="group/row relative">
      <button
        type="button"
        draggable={Boolean(onDragStart)}
        onDragStart={onDragStart}
        aria-expanded={children ? expanded : undefined}
        onClick={() => (children ? setOpen(!open) : onClick?.())}
        className={`group flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-left text-[13px] transition-colors ${actions ? 'pr-14' : ''} ${active ? 'bg-selected text-fg' : 'text-fg/90 hover:bg-raised'} ${onDragStart ? 'cursor-grab active:cursor-grabbing' : ''}`}
      >
        <span
          className={`grid size-4 shrink-0 place-items-center transition-colors ${active ? 'text-fg' : 'text-faint group-hover:text-muted'}`}
        >
          {icon}
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-1.5">{label}</span>
        {meta !== undefined && (
          <span className="shrink-0 text-[11.5px] text-faint tabular-nums">{meta}</span>
        )}
        {children && <Chevron size={13} strokeWidth={1.5} className="shrink-0 text-faint" />}
      </button>
      {actions && (
        <div className="absolute top-1 right-1 flex gap-0.5 opacity-0 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100">
          {actions}
        </div>
      )}
      {expanded && children}
    </div>
  )
}
