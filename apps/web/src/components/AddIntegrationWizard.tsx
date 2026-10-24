import { Plus, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import { api } from '../api'
import {
  defaultSettings,
  type GraphRef,
  graphId,
  type Integration,
  type IntegrationKind,
  KINDS,
  newIntegrationId,
} from '../lib/integrations'
import { missingSourceSchemas } from '../lib/schemas'
import { addIntegration } from '../lib/store'
import { template, templatesFor } from '../lib/templates'
import { Select } from './Select'
import { StatusDot } from './ui'

interface GraphRow {
  key: number
  name: string
  template: string
}

const STEPS = ['Source', 'Settings', 'Mappings'] as const

/** A new integration starts with every starter of its kind, else one empty mapping. */
function starterRows(kind: IntegrationKind): GraphRow[] {
  const starters = templatesFor(kind).filter((t) => t.key !== 'empty')
  return (starters.length > 0 ? starters : [template('empty')]).map((t, key) => ({
    key,
    name: t.label,
    template: t.key,
  }))
}

/** Uses the demo API's view of the source; the form's settings are stored, not used, for now. */
function ConnectionCheck({ kind }: { kind: IntegrationKind }) {
  const [state, setState] = useState<{ ok?: boolean; text: string } | null>(null)
  const check = async () => {
    setState({ text: 'Checking…' })
    try {
      const source = (await api.sources()).find((s) => s.key === kind)
      if (source?.status !== 'ok') return setState({ ok: false, text: 'Unreachable' })
      const tables = await api.tables(kind)
      setState({ ok: true, text: `Connected · ${tables.length} tables` })
    } catch (error) {
      setState({ ok: false, text: (error as Error).message })
    }
  }
  return (
    <div className="flex items-center gap-3">
      <button type="button" className="btn" onClick={check}>
        Check connection
      </button>
      {state && (
        <span className="flex items-center gap-1.5 text-[12px] text-muted">
          <StatusDot ok={state.ok} /> {state.text}
        </span>
      )}
    </div>
  )
}

function SettingInput({
  label,
  value,
  onChange,
}: {
  label: string
  value: string | undefined
  onChange: (value: string) => void
}) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      <input
        className="field font-mono text-[12px]"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  )
}

/** Add an integration in three steps: pick the source, confirm settings, name its mappings. */
export function AddIntegrationWizard({
  onClose,
  onCreated,
}: {
  onClose: () => void
  /** The integration was added; open it. */
  onCreated: (integration: Integration) => void
}) {
  const [step, setStep] = useState(0)
  const [kind, setKind] = useState<IntegrationKind>('netsuite')
  const [name, setName] = useState(KINDS.netsuite.defaultName)
  const [settings, setSettings] = useState(() => defaultSettings('netsuite'))
  const [rows, setRows] = useState<GraphRow[]>(() => starterRows('netsuite'))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const choose = (next: IntegrationKind) => {
    setKind(next)
    setName(KINDS[next].defaultName)
    setSettings(defaultSettings(next))
    setRows(starterRows(next))
  }
  const updateRow = (key: number, patch: Partial<GraphRow>) =>
    setRows(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)))
  const canFinish = name.trim() !== '' && rows.length > 0 && rows.every((r) => r.name.trim() !== '')

  const create = async () => {
    setBusy(true)
    setError(null)
    const id = newIntegrationId(name)
    const graphs: GraphRef[] = []
    for (const row of rows)
      graphs.push({ id: graphId(id, row.name, graphs), name: row.name.trim() })
    try {
      // Templates are saved as mapping documents; empty ones start from scratch on open.
      await Promise.all(
        rows.flatMap((row, i) => {
          const starter = template(row.template)
          const mappingId = graphs[i]?.id ?? ''
          if (starter.key === 'empty') return []
          // Describe the source tables first so the mapping starts with their schemas.
          return [
            (async () => {
              const version = starter.build(mappingId, row.name.trim())
              const schemas = await missingSourceSchemas(version, api.table)
              await api.saveGraph(mappingId, {
                ...version,
                expectedSchema: { ...version.expectedSchema, ...schemas },
              })
            })(),
          ]
        }),
      )
      const integration: Integration = {
        id,
        name: name.trim(),
        kind,
        settings,
        graphs,
        createdAt: new Date().toISOString(),
      }
      addIntegration(integration)
      onCreated(integration)
      onClose()
    } catch (failure) {
      setError(`Could not save the mappings: ${(failure as Error).message}`)
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="wizard-title"
        className="flex max-h-full w-[40rem] flex-col rounded-[20px] border border-line bg-panel shadow-2xl shadow-black/60"
      >
        <header className="flex items-center gap-4 border-b border-line px-5 py-3">
          <h2 id="wizard-title" className="font-semibold">
            Add integration
          </h2>
          <ol className="flex gap-3 text-[12px]">
            {STEPS.map((label, i) => (
              <li key={label} className={i === step ? 'font-medium text-fg' : 'text-faint'}>
                {i + 1}. {label}
              </li>
            ))}
          </ol>
          <button
            type="button"
            aria-label="Close"
            className="ml-auto rounded-lg p-1 text-muted hover:bg-raised hover:text-fg"
            onClick={onClose}
          >
            <X size={16} strokeWidth={1.5} />
          </button>
        </header>

        <div className="min-h-0 space-y-4 overflow-y-auto px-5 py-4">
          {step === 0 && (
            <div className="grid grid-cols-2 gap-3">
              {(Object.keys(KINDS) as IntegrationKind[]).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => choose(k)}
                  className={`rounded-2xl border p-4 text-left ${kind === k ? 'border-line-strong bg-raised' : 'border-line bg-frame hover:bg-raised'}`}
                >
                  <p className="font-semibold">{KINDS[k].label}</p>
                  <p className="mt-1 text-[12px] text-muted">{KINDS[k].description}</p>
                </button>
              ))}
            </div>
          )}

          {step === 1 && (
            <>
              <label className="block">
                <span className="label">Integration name</span>
                <input className="field" value={name} onChange={(e) => setName(e.target.value)} />
              </label>
              {KINDS[kind].settings
                .filter((field) => field.key === 'baseUrl')
                .map((field) => (
                  <SettingInput
                    key={field.key}
                    label={field.label}
                    value={settings[field.key]}
                    onChange={(value) => setSettings({ ...settings, [field.key]: value })}
                  />
                ))}
              <details className="group">
                <summary className="cursor-pointer text-[12px] text-muted hover:text-fg">
                  Advanced settings
                </summary>
                <div className="mt-3 grid grid-cols-2 gap-3">
                  {KINDS[kind].settings
                    .filter((field) => field.key !== 'baseUrl')
                    .map((field) => (
                      <SettingInput
                        key={field.key}
                        label={field.label}
                        value={settings[field.key]}
                        onChange={(value) => setSettings({ ...settings, [field.key]: value })}
                      />
                    ))}
                </div>
              </details>
              <ConnectionCheck kind={kind} />
            </>
          )}

          {step === 2 && (
            <>
              <p className="text-[12px] text-muted">
                What this integration should map, e.g. one mapping per target entity.
              </p>
              <ul className="space-y-2">
                {rows.map((row) => (
                  <li key={row.key} className="flex items-center gap-2">
                    <input
                      className="field"
                      aria-label="Mapping name"
                      value={row.name}
                      onChange={(e) => updateRow(row.key, { name: e.target.value })}
                    />
                    <div className="w-48 shrink-0">
                      <Select
                        aria-label="Starter"
                        value={row.template}
                        onChange={(value) => updateRow(row.key, { template: value })}
                        options={templatesFor(kind).map((t) => ({ value: t.key, label: t.label }))}
                      />
                    </div>
                    <button
                      type="button"
                      aria-label="Remove mapping"
                      className="text-faint hover:text-down disabled:opacity-30"
                      disabled={rows.length === 1}
                      onClick={() => setRows(rows.filter((r) => r.key !== row.key))}
                    >
                      <Trash2 size={14} strokeWidth={1.5} />
                    </button>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                className="btn"
                onClick={() =>
                  setRows([
                    ...rows,
                    { key: Math.max(...rows.map((r) => r.key)) + 1, name: '', template: 'empty' },
                  ])
                }
              >
                <Plus size={14} strokeWidth={1.5} /> Add mapping
              </button>
            </>
          )}
          {error && <p className="text-[12px] text-down">{error}</p>}
        </div>

        <footer className="flex justify-between border-t border-line px-5 py-3">
          <button
            type="button"
            className="btn"
            onClick={() => (step === 0 ? onClose() : setStep(step - 1))}
          >
            {step === 0 ? 'Cancel' : 'Back'}
          </button>
          {step < 2 ? (
            <button
              type="button"
              className="btn btn-primary"
              disabled={step === 1 && name.trim() === ''}
              onClick={() => setStep(step + 1)}
            >
              Next
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary"
              disabled={!canFinish || busy}
              onClick={create}
            >
              {busy ? 'Creating…' : 'Create integration'}
            </button>
          )}
        </footer>
      </div>
    </div>
  )
}
