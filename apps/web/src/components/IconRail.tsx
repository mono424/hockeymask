import { Database, LayoutGrid, PanelLeft, PanelRight, Plus } from 'lucide-react'
import { type ReactNode, useState } from 'react'

export type View = 'builder' | 'testbench'

/** The app's pages: the integrations, one's mapping editor, and the schema they map into. */
export type Page = 'integrations' | 'mappings' | 'schema'

function RailButton({
  label,
  active = false,
  highlight = false,
  disabled = false,
  onClick,
  children,
}: {
  label: string
  active?: boolean
  highlight?: boolean
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}) {
  const tone = highlight
    ? 'bg-white/[0.08] text-fg hover:bg-white/[0.14]'
    : active
      ? 'bg-white/[0.08] text-fg'
      : 'text-faint hover:bg-white/[0.05] hover:text-fg'
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={highlight ? undefined : active}
      disabled={disabled}
      onClick={onClick}
      className={`group relative grid size-8 place-items-center rounded-full transition-colors disabled:opacity-30 ${tone}`}
    >
      {children}
      <span className="pointer-events-none absolute left-full z-50 ml-2.5 hidden rounded-md border border-line bg-raised px-2 py-1 text-[12px] whitespace-nowrap text-fg shadow-lg shadow-black/40 group-hover:block">
        {label}
      </span>
    </button>
  )
}

/** Far-left rail on the page background: logo, the pages, and add integration. */
export function IconRail({
  page,
  onPage,
  onAddIntegration,
}: {
  page: Page
  onPage: (page: Page) => void
  onAddIntegration: () => void
}) {
  const icon = { size: 16, strokeWidth: 1.75 }
  // A turn always finishes once started, however short the pointer stays.
  const [turning, setTurning] = useState(false)
  return (
    <nav className="flex w-16 shrink-0 flex-col items-center gap-1">
      {/* Same height as the card headers, so the logo lines up with their titles. */}
      <div
        className="mask-logo mb-2 grid h-12 w-full place-items-center"
        onMouseEnter={() => setTurning(true)}
      >
        <span
          className={`mask-logo-spinner size-7${turning ? ' is-turning' : ''}`}
          onAnimationEnd={(e) => e.animationName === 'mask-turn' && setTurning(false)}
        >
          <img src="/favicon.png" alt="hockeymask" className="mask-logo-face mask-logo-front" />
          <img
            src="/hockeymask-rear-interior.png"
            alt=""
            aria-hidden="true"
            className="mask-logo-face mask-logo-back"
          />
        </span>
      </div>
      {/* The editor is reached from the integration cards, so both light this button. */}
      <RailButton
        label="Integrations"
        active={page !== 'schema'}
        onClick={() => onPage('integrations')}
      >
        <LayoutGrid {...icon} />
      </RailButton>
      <RailButton label="Schema" active={page === 'schema'} onClick={() => onPage('schema')}>
        <Database {...icon} />
      </RailButton>
      <RailButton label="Add integration" highlight onClick={onAddIntegration}>
        <Plus {...icon} />
      </RailButton>
    </nav>
  )
}

export type Panels = { input: boolean; agent: boolean }

/** Header buttons that show / hide the overlaid side panels: input left, agent right. */
export function PanelToggle({
  side,
  open,
  onToggle,
}: {
  side: 'input' | 'agent'
  open: boolean
  onToggle: () => void
}) {
  const Icon = side === 'input' ? PanelLeft : PanelRight
  const label = `${open ? 'Hide' : 'Show'} ${side === 'input' ? 'input' : 'agent'}`
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={open}
      title={label}
      onClick={onToggle}
      className={`grid size-8 shrink-0 place-items-center rounded-md transition-colors ${open ? 'text-fg hover:bg-raised' : 'text-faint hover:bg-raised hover:text-fg'}`}
    >
      <Icon size={16} strokeWidth={1.5} />
    </button>
  )
}

/** "Builder | Testbench" as a pill segmented control. */
export function ViewSwitch({
  view,
  onView,
  disabled = false,
}: {
  view: View
  onView: (view: View) => void
  disabled?: boolean
}) {
  return (
    <div
      className="flex h-8 items-center rounded-full border border-line bg-canvas p-[3px]"
      role="group"
      aria-label="View"
    >
      {(['builder', 'testbench'] as const).map((v) => (
        <button
          key={v}
          type="button"
          aria-pressed={view === v}
          disabled={disabled}
          onClick={() => onView(v)}
          className={`h-[24px] rounded-full px-4 text-[13px] font-medium capitalize transition-colors disabled:opacity-40 ${view === v ? 'bg-selected text-fg shadow-[0_1px_2px_rgb(0_0_0/40%)]' : 'text-muted hover:text-fg'}`}
        >
          {v}
        </button>
      ))}
    </div>
  )
}
