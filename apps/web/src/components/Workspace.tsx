import {
  addNode,
  type CatalogEntry,
  checkVersion,
  emptyVersion,
  type MappingVersion,
  type NodeJson,
  validateStructure,
} from '@hockeymask/core'
import { freePosition, GraphBuilder, type NodeTemplate } from '@hockeymask/react'
import { useAssistantContext } from '@assistant-ui/react'
import { Check } from 'lucide-react'
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react'
import {
  ApiError,
  cached,
  useGraph,
  useHealth,
  useSaveGraph,
  useTables,
  useTargetSchema,
} from '../api'
import { formatCount, shortTableName } from '../format'
import { type GraphRef, type Integration, type IntegrationKind, KINDS } from '../lib/integrations'
import { describeMapping } from '../lib/agent/context'
import { getDraft, setDraft, useDraft } from '../lib/drafts'
import { useRename } from '../lib/mappings'
import { missingSourceSchemas } from '../lib/schemas'
import { getBench } from '../lib/testbench'
import { AddStepMenu } from './AddStepMenu'
import { NodeIcon } from './icons'
import { PanelToggle, type Panels, type View, ViewSwitch } from './IconRail'
import { InspectorOverlay } from './inspector/InspectorOverlay'
import { PromptBar } from './PromptBar'
import { Testbench } from './Testbench'
import { AGENT_WIDTH, Loading, NameInput, PanelSlot } from './ui'

const text = (value: unknown) => (typeof value === 'string' ? value : '')
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** Nothing while all is well; one small red pill when the API or the database is down. */
function OfflinePill() {
  const health = useHealth()
  const problem = health.isError
    ? 'The demo API is not reachable.'
    : health.data?.database === 'error'
      ? 'The database is not reachable.'
      : null
  if (!problem) return null
  return (
    <span
      title={problem}
      className="rounded-full bg-down/15 px-2.5 py-0.5 text-[12px] font-medium text-down"
    >
      Offline
    </span>
  )
}

/** The one-line summary under each node's label. */
function useDescribeNode(kind: IntegrationKind) {
  const tables = useTables(kind)
  const schema = useTargetSchema()
  return useCallback(
    (node: NodeJson, entry: CatalogEntry | undefined): ReactNode => {
      switch (node.op) {
        case 'source': {
          const entity = text(node.entity)
          if (!entity) return 'No table chosen'
          const source = KINDS[text(node.system) as IntegrationKind]?.label.replace(' (demo)', '')
          const rows =
            text(node.system) === kind
              ? tables.data?.find((t) => t.name === entity)?.rowCount
              : null
          return [
            source ?? text(node.system),
            shortTableName(entity),
            rows != null && `${formatCount(rows)} rows`,
          ]
            .filter(Boolean)
            .join(' · ')
        }
        case 'map': {
          const fields = Array.isArray(node.fields) ? node.fields.length : 0
          return fields === 0 ? 'No fields yet' : plural(fields, 'field')
        }
        case 'join':
          return `${text(node.type) || 'inner'} join · ${plural(Array.isArray(node.on) ? node.on.length : 0, 'key')}`
        case 'sink': {
          const target = text(node.target)
          const fields = schema.data?.entities.find((e) => e.name === target)?.fields.length
          return target
            ? `Writes ${target}${fields ? ` · ${plural(fields, 'field')}` : ''}`
            : 'No entity chosen'
        }
        default:
          return entry?.description ?? null
      }
    },
    [kind, tables.data, schema.data],
  )
}

/** Source nodes need an `expectedSchema`; derive it from the table whenever one is missing. */
function useSourceSchemas(graphId: string, version: MappingVersion) {
  useEffect(() => {
    let cancelled = false
    missingSourceSchemas(version, cached.table)
      .then((schemas) => {
        if (cancelled || Object.keys(schemas).length === 0) return
        // Merge into the latest draft: the engineer or the agent may have edited meanwhile.
        const base = getDraft(graphId) ?? version
        setDraft(graphId, { ...base, expectedSchema: { ...base.expectedSchema, ...schemas } })
      })
      // A table that can't be described stays a `missing_schema` issue on its node.
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [graphId, version])
}

const renderNodeIcon = (node: NodeJson) => <NodeIcon op={node.op} size={13} />

/** Where content starts when a 264px panel is overlaid at 8px from the edge, plus an 8px gap. */
export const PANEL_INSET = 280
export const EDGE = 8
/** The same for the wider agent panel. */
export const AGENT_INSET = AGENT_WIDTH + 2 * EDGE
/** The step inspector card's width (`.insp-card`); the prompt bar stays clear of it. */
const INSPECTOR_WIDTH = 392

/**
 * "✓ Saved", or the Save button while there are unsaved changes. A fixed-width slot, so the
 * header never shifts between the two.
 */
function SaveSlot({
  dirty,
  saved,
  pending,
  failed,
  disabled,
  title,
  onSave,
}: {
  dirty: boolean
  saved: boolean
  pending: boolean
  failed: string | null
  disabled: boolean
  title?: string
  onSave: () => void
}) {
  return (
    <div className="flex h-8 w-[84px] shrink-0 items-center justify-end">
      {dirty || pending ? (
        <button
          type="button"
          className="btn btn-primary"
          title={failed ?? undefined}
          disabled={disabled || pending}
          onClick={onSave}
        >
          {pending ? 'Saving…' : failed ? 'Retry' : 'Save'}
        </button>
      ) : saved ? (
        <span title={title} className="flex items-center gap-1.5 text-[12.5px] text-muted">
          <Check size={14} strokeWidth={2} />
          Saved
        </span>
      ) : (
        <span className="text-[12.5px] text-faint">Not saved</span>
      )}
    </div>
  )
}

/** The open mapping's name in the top bar; click to rename, Enter keeps, Escape cancels. */
function MappingName({ graphRef }: { graphRef: GraphRef }) {
  const rename = useRename(graphRef)
  if (rename.editing) {
    return (
      <NameInput
        value={graphRef.name}
        label="Mapping name"
        className="h-7 w-56"
        onDone={rename.finish}
      />
    )
  }
  return (
    <button
      type="button"
      title={rename.failed ? `Rename failed: ${rename.failed}` : 'Rename mapping'}
      className={`truncate rounded px-1 transition-colors hover:bg-raised ${rename.failed ? 'text-down' : 'text-fg'}`}
      onClick={rename.start}
    >
      {graphRef.name}
    </button>
  )
}

/**
 * The main card: top bar, then the builder or testbench, with the input and agent panels
 * overlaid below the header and the content pushed inward past them.
 */
export function Workspace({
  integration,
  graphRef,
  view,
  onView,
  panels,
  onTogglePanel,
  left,
  right,
}: {
  integration: Integration
  graphRef: GraphRef
  view: View
  onView: (view: View) => void
  panels: Panels
  onTogglePanel: (panel: keyof Panels) => void
  left: ReactNode
  right: ReactNode
}) {
  const loaded = useGraph(graphRef.id)
  const save = useSaveGraph(graphRef.id)
  // Shared with the agent's tools, so their edits show up here as they happen.
  const draft = useDraft(graphRef.id)
  const edit = useCallback((next: MappingVersion) => setDraft(graphRef.id, next), [graphRef.id])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const starter = useMemo(() => emptyVersion(graphRef.id, graphRef.name), [graphRef])
  const describeNode = useDescribeNode(integration.kind)
  const targets = useTargetSchema()

  const missing = loaded.error instanceof ApiError && loaded.error.status === 404
  const offline = loaded.isError && !missing
  const version = draft ?? loaded.data?.graph ?? starter
  useSourceSchemas(graphRef.id, version)
  // The server's checks, run here on every edit; plus anything only the server knows
  // (e.g. a document stored in an outdated format) until the first edit.
  const issues = useMemo(() => {
    const local = targets.data
      ? checkVersion(version, { targets: targets.data }).issues
      : validateStructure(version)
    if (draft || !loaded.data) return local
    const seen = new Set(local.map((i) => i.message))
    return [...local, ...loaded.data.issues.filter((i) => !seen.has(i.message))]
  }, [version, targets.data, draft, loaded.data])
  const selected = version.nodes.find((n) => n.id === selectedId) ?? null
  useAssistantContext({
    getContext: () =>
      describeMapping({
        graph: graphRef,
        version,
        unsaved: Boolean(draft),
        view,
        selectedId: selected?.id ?? null,
        issues,
        bench: getBench(graphRef.id),
      }),
  })

  const savedAt = loaded.data && new Date(loaded.data.updatedAt).toLocaleString()
  const insetLeft = panels.input ? PANEL_INSET : EDGE
  const insetRight = panels.agent ? AGENT_INSET : EDGE
  const openAgent = () => {
    if (!panels.agent) onTogglePanel('agent')
  }

  const addStep = (template: NodeTemplate) => {
    const { version: next, node } = addNode(version, template.op, {
      position: freePosition(version, template.op),
      params: template.params,
      label: template.label,
    })
    edit(next)
    setSelectedId(node.id)
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-2">
        <PanelToggle side="input" open={panels.input} onToggle={() => onTogglePanel('input')} />
        <ViewSwitch view={view} onView={onView} />
        <div className="ml-auto flex min-w-0 items-center gap-3 text-[13px]">
          <span className="flex min-w-0 items-center gap-1 text-muted">
            <span className="truncate">{integration.name}</span>
            <span className="text-faint">/</span>
            <MappingName key={graphRef.id} graphRef={graphRef} />
          </span>
          <OfflinePill />
          <SaveSlot
            dirty={Boolean(draft)}
            saved={Boolean(loaded.data)}
            pending={save.isPending}
            failed={save.isError ? save.error.message : null}
            disabled={offline}
            title={savedAt ? `Saved ${savedAt}` : undefined}
            onSave={() =>
              save.mutate(version, {
                onSuccess: () => {
                  // Keep anything edited while the save was in flight.
                  if (getDraft(graphRef.id) === version) setDraft(graphRef.id, null)
                },
              })
            }
          />
        </div>
        <PanelToggle side="agent" open={panels.agent} onToggle={() => onTogglePanel('agent')} />
      </header>

      {/* Panels float over the canvas; everything else is pushed inward past them. */}
      <div className="relative min-h-0 flex-1 bg-canvas">
        <main
          className="absolute inset-0"
          style={
            {
              '--inset-l': `${insetLeft}px`,
              '--inset-r': `${insetRight}px`,
            } as CSSProperties
          }
        >
          {loaded.isPending ? (
            <div style={{ paddingLeft: insetLeft, paddingTop: EDGE }}>
              <Loading what="Loading mapping" />
            </div>
          ) : view === 'testbench' ? (
            <div
              className="inset-motion absolute inset-y-0"
              style={{ left: insetLeft - EDGE, right: insetRight - EDGE }}
            >
              <Testbench graphId={graphRef.id} version={version} onOpenAgent={openAgent} />
            </div>
          ) : (
            <>
              <GraphBuilder
                // Re-fit when a panel opens or closes, so nodes never sit under a panel.
                key={`${insetLeft}:${insetRight}`}
                className="absolute inset-0"
                fitViewPadding={{
                  top: '72px',
                  // Room for the prompt bar, which is away while the agent panel is open.
                  bottom: panels.agent ? '32px' : '152px',
                  left: `${insetLeft + 24}px`,
                  right: `${insetRight + 24}px`,
                }}
                value={version}
                onChange={edit}
                issues={issues}
                selectedNodeId={selectedId}
                onSelectNode={setSelectedId}
                renderNodeIcon={renderNodeIcon}
                describeNode={describeNode}
                emptyMessage="Add a step to start this mapping."
              />
              <div className="inset-motion absolute top-2 z-10" style={{ left: insetLeft }}>
                <AddStepMenu source={integration.kind} onPick={addStep} />
              </div>
              <PromptBar
                hidden={panels.agent}
                style={{
                  left: insetLeft,
                  right: selected ? insetRight + INSPECTOR_WIDTH : insetRight,
                }}
                onOpenAgent={openAgent}
              />
              <InspectorOverlay
                version={version}
                node={selected}
                issues={issues}
                right={insetRight}
                onChange={edit}
                onClose={() => setSelectedId(null)}
              />
            </>
          )}
        </main>
        <PanelSlot side="left" open={panels.input}>
          {left}
        </PanelSlot>
        <PanelSlot side="right" open={panels.agent}>
          {right}
        </PanelSlot>
      </div>
    </div>
  )
}
