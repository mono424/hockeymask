import { type MappingVersion, type RunResult, type SinkResult, toJson } from '@hockeymask/core'
import { nodeTitle } from '@hockeymask/react'
import { ThreadPrimitive } from '@assistant-ui/react'
import { Diff, Download, Gauge, Play, Sparkles } from 'lucide-react'
import { useState } from 'react'
import { api, useTargetSchema } from '../api'
import { shortTableName } from '../format'
import { type Delta, type DeltaRow, diffRows, type RowChange } from '../lib/delta'
import { usePersistentState } from '../lib/store'
import {
  type DataRow,
  feedStatus,
  rowsJson,
  runFeeds,
  setBench,
  setFeeds,
  sourcesOf,
  useBench,
} from '../lib/testbench'

function Cell({ value }: { value: unknown }) {
  if (value === null || value === undefined) {
    return <span className="text-faint italic">null</span>
  }
  if (value === '')
    return <span className="rounded border border-dashed border-faint px-1">''</span>
  if (typeof value === 'object') return <span>{JSON.stringify(value)}</span>
  return (
    <span className={typeof value === 'number' ? 'text-num' : ''}>
      {String(value as string | number | boolean)}
    </span>
  )
}

const MARKS: Record<RowChange, { sign: string; row: string; tone: string }> = {
  added: { sign: '+', row: 'bg-ok/10', tone: 'text-ok' },
  removed: { sign: '−', row: 'bg-down/10 text-faint line-through', tone: 'text-down' },
  changed: { sign: '~', row: '', tone: 'text-marker' },
  same: { sign: '', row: '', tone: '' },
}

/** Rows as a table; with a delta, each row marked by its change and changed cells by their old value. */
function RowsTable({ rows, delta }: { rows: readonly DataRow[]; delta?: Delta | undefined }) {
  const all: DeltaRow[] = delta?.rows ?? rows.map((row) => ({ row, change: 'same' }))
  const shown = all.slice(0, 100)
  const columns = [...new Set(shown.flatMap((r) => Object.keys(r.row)))]
  if (all.length === 0) return <p className="text-[12px] text-faint">No rows.</p>
  return (
    <div className="max-h-80 overflow-auto rounded-xl border border-line bg-panel">
      <table className="w-full font-mono text-[12px]">
        <thead className="sticky top-0 bg-raised text-left text-muted">
          <tr>
            {delta && <th className="w-6 border-b border-line" aria-label="Change" />}
            {columns.map((c) => (
              <th
                key={c}
                className="border-b border-line px-3 py-1.5 font-medium whitespace-nowrap"
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map(({ row, change, before, fields }, i) => (
            <tr key={i} className={`border-b border-line ${MARKS[change].row}`}>
              {delta && (
                <td className={`px-2 text-center ${MARKS[change].tone}`} title={change}>
                  {MARKS[change].sign}
                </td>
              )}
              {columns.map((c) => {
                const was = fields?.includes(c)
                return (
                  <td
                    key={c}
                    className={`px-3 py-1 whitespace-nowrap ${was ? 'bg-marker/15' : ''}`}
                  >
                    <Cell value={row[c]} />
                    {was && (
                      <span
                        className="ml-2 text-faint line-through"
                        title="Value in the run before"
                      >
                        <Cell value={before?.[c]} />
                      </span>
                    )}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {all.length > shown.length && (
        <p className="px-3 py-1 text-[11px] text-faint">Showing 100 of {all.length} rows.</p>
      )}
    </div>
  )
}

const text = (value: unknown) => (typeof value === 'string' ? value : '')

/** A sink's rows: what it would write, else what reached it (held back or failed). */
const rowsOf = (sink: SinkResult, result: RunResult): DataRow[] =>
  sink.write?.rows.map((r) => ({ ...r })) ??
  (result.outputs?.[sink.sink] ?? []).map((r) =>
    Object.fromEntries(Object.entries(r).map(([k, v]) => [k, toJson(v)])),
  )

function DeltaSummary({ delta }: { delta: Delta }) {
  if (delta.added + delta.changed + delta.removed === 0) {
    return <span className="text-[12px] font-normal text-faint">no changes</span>
  }
  return (
    <span className="flex gap-2 font-mono text-[12px] font-normal">
      {delta.added > 0 && <span className="text-ok">+{delta.added} added</span>}
      {delta.changed > 0 && <span className="text-marker">~{delta.changed} changed</span>}
      {delta.removed > 0 && <span className="text-down">−{delta.removed} removed</span>}
    </span>
  )
}

/**
 * Rows loaded per source by "Load sample rows": enough that joins across sources line up.
 * The demo tables come in key order, so the first rows of each cover the same records.
 */
const SAMPLE_SIZE = 2000

function FeedBadge({ json }: { json: string | undefined }) {
  const status = feedStatus(json)
  if ('error' in status) return <span className="text-down">invalid JSON</span>
  if (status.rows === 0) return <span className="text-faint">empty</span>
  return (
    <span className="text-muted">
      {status.rows} row{status.rows === 1 ? '' : 's'}
    </span>
  )
}

/** Feed rows into the mapping's sources and run the mapping engine on them. */
export function Testbench({
  graphId,
  version,
  onOpenAgent,
}: {
  graphId: string
  version: MappingVersion
  /** Shows the agent panel, so "Fix with AI" lands where the engineer can watch it. */
  onOpenAgent?: () => void
}) {
  const targets = useTargetSchema()
  const sources = sourcesOf(version)
  // Shared with the agent's run_testbench tool: either one's rows and last run show here.
  const { feeds, run, previous } = useBench(graphId)
  // Off by default; when on, every run is compared with the run before it.
  const [showDelta, setShowDelta] = usePersistentState('hockeymask.testbench.delta.v1', () => false)
  const [openId, setOpenId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadErrors, setLoadErrors] = useState<string[]>([])

  const open = sources.find((n) => n.id === openId) ?? sources[0] ?? null
  const openStatus = open ? feedStatus(feeds[open.id]) : null
  const labelOf = (id: string) => {
    const node = version.nodes.find((n) => n.id === id)
    return node ? nodeTitle(node) : id
  }

  /** Fill every source with sample rows of its table, each as soon as it arrives. */
  const loadSamples = async () => {
    setLoading(true)
    setLoadErrors([])
    const settled = await Promise.allSettled(
      sources.map(async (node) => {
        const system = text(node.system)
        const entity = text(node.entity)
        if (!system || !entity) throw new Error('choose its table first')
        const sample = await api.sample(system, entity, SAMPLE_SIZE)
        setFeeds(graphId, { [node.id]: rowsJson(sample.rows) })
      }),
    )
    setLoadErrors(
      settled.flatMap((r, i) =>
        r.status === 'rejected'
          ? [`${sources[i]?.label ?? sources[i]?.id}: ${(r.reason as Error).message}`]
          : [],
      ),
    )
    setLoading(false)
  }

  const runMapping = () => setBench(graphId, { run: runFeeds(version, feeds, targets.data) })

  const baseline = showDelta ? previous?.result : undefined
  /** A sink's rows against the baseline's, matched by its upsert key; a new sink's are all added. */
  const deltaOf = (sink: SinkResult, rows: DataRow[], before: RunResult): Delta => {
    const node = version.nodes.find((n) => n.id === sink.sink)
    const key =
      sink.write?.key ??
      (Array.isArray(node?.key) ? node.key.filter((k) => typeof k === 'string') : [])
    const old = before.sinks.find((s) => s.sink === sink.sink)
    return diffRows(old ? rowsOf(old, before) : [], rows, key)
  }

  const problems = run
    ? [
        ...run.errors,
        ...(run.result?.issues ?? []).map(
          (i) =>
            `${labelOf(i.node)} (\`${i.node}\`)${i.field ? ` · ${i.field}` : ''}: ${i.message}`,
        ),
      ]
    : []
  const fixPrompt = [
    'The testbench run of this mapping reported these problems:',
    ...problems.map((p) => `- ${p}`),
    'Find the cause, fix the mapping, then run the testbench again to confirm.',
  ].join('\n')

  return (
    <div className="grid h-full min-h-0 grid-cols-[22rem_minmax(0,1fr)]">
      <section className="flex min-h-0 flex-col gap-3 border-r border-line bg-panel p-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-[13px] font-medium">Source rows</h3>
          <button
            type="button"
            className="btn text-[12px]"
            disabled={loading || sources.length === 0}
            onClick={loadSamples}
          >
            <Download size={13} strokeWidth={1.5} />
            {loading ? 'Loading…' : 'Load sample rows'}
          </button>
        </div>

        {sources.length === 0 ? (
          <p className="text-[12px] text-muted">Add a source step to this mapping first.</p>
        ) : (
          <>
            <div
              role="tablist"
              aria-label="Sources"
              className="overflow-hidden rounded-lg border border-line bg-canvas"
            >
              {sources.map((node) => {
                const entity = text(node.entity)
                const selected = node.id === open?.id
                return (
                  <button
                    key={node.id}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    onClick={() => setOpenId(node.id)}
                    className={`flex w-full items-center gap-2 border-b border-line px-2.5 py-1.5 text-left text-[12.5px] transition-colors last:border-b-0 ${selected ? 'bg-selected text-fg' : 'text-muted hover:bg-raised hover:text-fg'}`}
                  >
                    <span className="truncate font-medium">{node.label ?? node.id}</span>
                    {entity && (
                      <span className="truncate font-mono text-[11px] text-faint">
                        {shortTableName(entity)}
                      </span>
                    )}
                    <span className="ml-auto shrink-0 text-[11.5px]">
                      <FeedBadge json={feeds[node.id]} />
                    </span>
                  </button>
                )
              })}
            </div>

            {open && (
              <textarea
                key={open.id}
                className="field min-h-40 flex-1 font-mono text-[12px]"
                aria-label={`Rows for ${open.label ?? open.id}`}
                placeholder={
                  'Paste rows as JSON: an object or an array of objects.\nOr load sample rows from the source table.'
                }
                spellCheck={false}
                wrap="off"
                value={feeds[open.id] ?? ''}
                onChange={(e) => setFeeds(graphId, { [open.id]: e.target.value })}
              />
            )}
            {openStatus && 'error' in openStatus && (
              <p className="text-[12px] text-down">Invalid JSON: {openStatus.error}</p>
            )}
          </>
        )}

        {loadErrors.length > 0 && (
          <ul className="space-y-0.5 text-[12px] text-down">
            {loadErrors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}
      </section>

      <section className="min-h-0 space-y-5 overflow-y-auto p-4">
        <div className="flex items-center gap-3">
          <button type="button" className="btn btn-primary" onClick={runMapping}>
            <Play size={14} strokeWidth={1.5} /> Run
          </button>
          <button
            type="button"
            className={`btn text-[12px] ${showDelta ? 'border-line-strong bg-selected' : 'text-muted'}`}
            aria-pressed={showDelta}
            title="Compare each run with the run before it, matching rows by their key"
            onClick={() => setShowDelta(!showDelta)}
          >
            <Diff size={13} strokeWidth={1.5} /> Changes
          </button>
          <p className="text-[12px] text-faint">
            Runs the mapping engine on these rows. Nothing is written to the target.
          </p>
        </div>

        {!run && <p className="text-muted">Run the mapping to see what would reach the target.</p>}

        {run && (
          <>
            {problems.length > 0 && (
              <div className="flex items-center gap-3">
                <p className="text-[12px] text-down">
                  {problems.length} problem{problems.length === 1 ? '' : 's'} in the last run
                </p>
                <ThreadPrimitive.Suggestion
                  prompt={fixPrompt}
                  send
                  onClick={onOpenAgent}
                  className="btn ml-auto text-[12px]"
                >
                  <Sparkles size={13} strokeWidth={1.5} /> Fix with AI
                </ThreadPrimitive.Suggestion>
              </div>
            )}
            {run.errors.length > 0 && (
              <ul className="space-y-1 rounded-xl border border-down/30 bg-down/10 px-3 py-2 text-[12px] text-down">
                {run.errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            )}
            {run.result && (
              <>
                {run.result.issues.length > 0 && (
                  <ul className="space-y-1 rounded-xl border border-line bg-raised px-3 py-2 text-[12px] text-muted">
                    {run.result.issues.map((issue, i) => (
                      <li key={`${issue.node}-${issue.code}-${i}`}>
                        <span className="text-fg">{labelOf(issue.node)}</span>
                        {issue.field && <span className="font-mono"> · {issue.field}</span>}:{' '}
                        {issue.message}
                      </li>
                    ))}
                  </ul>
                )}
                {showDelta && !baseline && (
                  <p className="text-[12px] text-faint">
                    Run again to see what changes against this run.
                  </p>
                )}
                {run.result.sinks.map((sink) => {
                  const rows = rowsOf(sink, run.result as RunResult)
                  const delta = baseline && deltaOf(sink, rows, baseline)
                  return (
                    <section key={sink.sink}>
                      <h3 className="mb-1.5 flex items-center gap-2 font-semibold">
                        {labelOf(sink.sink)}
                        <span className="text-[12px] font-normal text-muted">
                          {rows.length} rows
                        </span>
                        {sink.status !== 'write' && (
                          <span className="rounded-full bg-down/15 px-2 text-[11px] font-medium text-down">
                            {sink.status.replace('_', ' ')}
                          </span>
                        )}
                        {delta && <DeltaSummary delta={delta} />}
                      </h3>
                      <RowsTable rows={rows} delta={delta || undefined} />
                    </section>
                  )
                })}
                {run.result.sinks.length === 0 && (
                  <p className="text-muted">This mapping has no target yet.</p>
                )}
                {/* Counters on the run, never written to the target. */}
                {run.result.metrics.map((metric) => (
                  <section key={metric.node}>
                    <h3 className="mb-1.5 flex items-center gap-2 font-semibold">
                      <Gauge size={14} strokeWidth={1.5} className="text-muted" />
                      {labelOf(metric.node)}
                      <span className="font-mono text-[12px] font-normal text-faint">
                        {metric.name}
                      </span>
                    </h3>
                    <RowsTable rows={metric.rows} />
                  </section>
                ))}
                <details className="text-[12px]">
                  <summary className="cursor-pointer text-muted hover:text-fg">Details</summary>
                  <table className="mt-2 w-full">
                    <thead className="text-left text-muted">
                      <tr>
                        <th className="py-1 font-medium">Step</th>
                        <th className="py-1 font-medium">Op</th>
                        <th className="py-1 font-medium">Status</th>
                        <th className="py-1 text-right font-medium">In</th>
                        <th className="py-1 text-right font-medium">Out</th>
                        <th className="py-1 text-right font-medium">Skipped</th>
                      </tr>
                    </thead>
                    <tbody>
                      {run.result.stats.map((s) => (
                        <tr key={s.node} className="border-t border-line">
                          <td className="py-1">{labelOf(s.node)}</td>
                          <td className="py-1 font-mono text-faint">{s.op}</td>
                          <td className={`py-1 ${s.status === 'ok' ? 'text-muted' : 'text-down'}`}>
                            {s.status.replace('_', ' ')}
                          </td>
                          <td className="py-1 text-right font-mono">{s.rowsIn}</td>
                          <td className="py-1 text-right font-mono">{s.rowsOut}</td>
                          <td className="py-1 text-right font-mono">{s.skipped}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              </>
            )}
          </>
        )}
      </section>
    </div>
  )
}
