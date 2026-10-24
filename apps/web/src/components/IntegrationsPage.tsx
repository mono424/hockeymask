import { Plus, Workflow } from 'lucide-react'
import { type ServiceStatus, useSources } from '../api'
import { type Integration, KINDS } from '../lib/integrations'
import { StatusDot } from './ui'

/** Mapping names a card lists before "+ n more". */
const SHOWN = 4

const STATUS: Record<ServiceStatus, string> = { ok: 'Connected', unreachable: 'Unreachable' }

function IntegrationCard({
  integration,
  status,
  onOpen,
}: {
  integration: Integration
  status: ServiceStatus | undefined
  onOpen: () => void
}) {
  const { graphs } = integration
  const more = graphs.length - SHOWN
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex h-full w-full flex-col gap-3 rounded-2xl border border-line bg-frame p-4 text-left transition-colors hover:border-line-strong hover:bg-raised"
    >
      <span className="flex w-full items-start gap-3">
        <span className="min-w-0">
          <span className="block truncate font-semibold">{integration.name}</span>
          <span className="block truncate text-[12px] text-muted">
            {KINDS[integration.kind].label.replace(' (demo)', '')}
            {integration.settings.baseUrl && (
              <span className="font-mono text-faint"> · {integration.settings.baseUrl}</span>
            )}
          </span>
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[12px] text-muted">
          <StatusDot ok={status && status === 'ok'} />
          {status ? STATUS[status] : 'Checking'}
        </span>
      </span>
      <span className="block w-full border-t border-line pt-3">
        <span className="label">
          {graphs.length} mapping{graphs.length === 1 ? '' : 's'}
        </span>
        {graphs.length === 0 && (
          <span className="block text-[12.5px] text-faint">None yet; add one in the editor.</span>
        )}
        {graphs.slice(0, SHOWN).map((g) => (
          <span key={g.id} className="flex h-6 items-center gap-2 text-[12.5px]">
            <Workflow size={13} strokeWidth={1.5} className="shrink-0 text-faint" />
            <span className="truncate">{g.name}</span>
          </span>
        ))}
        {more > 0 && <span className="block text-[12px] text-faint">+{more} more</span>}
      </span>
    </button>
  )
}

/** Every integration as a card; opening one shows its mappings in the editor. */
export function IntegrationsPage({
  integrations,
  onOpen,
  onAdd,
}: {
  integrations: Integration[]
  onOpen: (integration: Integration) => void
  onAdd: () => void
}) {
  const sources = useSources()
  const statusOf = (integration: Integration) =>
    sources.data?.find((s) => s.key === integration.kind)?.status

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line px-4">
        <h1 className="text-[14px] font-semibold tracking-[-0.01em]">Integrations</h1>
        <p className="truncate text-[13px] text-muted">
          Each connects one of their systems; its mappings carry the data into your model.
        </p>
      </header>
      {integrations.length === 0 ? (
        <main className="grid flex-1 place-items-center bg-canvas">
          <div className="max-w-sm px-6 text-center">
            <p className="text-[15px] font-semibold tracking-[-0.01em]">
              Connect a source to start mapping
            </p>
            <p className="mt-1.5 leading-relaxed text-muted">
              An integration connects one of their systems; its mappings carry the data into your
              model.
            </p>
            <button type="button" className="btn btn-primary mt-5" onClick={onAdd}>
              <Plus size={16} strokeWidth={1.5} /> Add your first integration
            </button>
          </div>
        </main>
      ) : (
        <main className="min-h-0 flex-1 overflow-y-auto bg-canvas p-4">
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(18rem,1fr))] gap-3">
            {integrations.map((integration) => (
              <li key={integration.id}>
                <IntegrationCard
                  integration={integration}
                  status={statusOf(integration)}
                  onOpen={() => onOpen(integration)}
                />
              </li>
            ))}
            <li>
              <button
                type="button"
                onClick={onAdd}
                className="flex h-full min-h-32 w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-line text-muted transition-colors hover:border-line-strong hover:bg-raised hover:text-fg"
              >
                <Plus size={16} strokeWidth={1.5} /> Add integration
              </button>
            </li>
          </ul>
        </main>
      )}
    </div>
  )
}
