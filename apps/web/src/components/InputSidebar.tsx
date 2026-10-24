import type { Table } from '@hockeymask/core'
import { writeNodeTemplate } from '@hockeymask/react'
import { useQueries } from '@tanstack/react-query'
import { Database, Pencil, Plus, Table2, Trash2, Workflow } from 'lucide-react'
import { useState } from 'react'
import { api, useSources, useTable, useTables } from '../api'
import { formatCount, shortTableName } from '../format'
import { type GraphRef, graphId, type Integration, KINDS } from '../lib/integrations'
import { deleteMapping, useRename } from '../lib/mappings'
import { addGraph, removeIntegration, select } from '../lib/store'
import { ModelSection } from './ModelSection'
import { Select } from './Select'
import {
  ErrorState,
  FieldName,
  ListItem,
  Loading,
  NameInput,
  Panel,
  SearchField,
  Section,
  TypeLabel,
} from './ui'

const matches = (text: string, term: string) => text.toLowerCase().includes(term)

/** Source tables (draggable onto the canvas), filtered by table or column name. */
function Tables({ source, term }: { source: string; term: string }) {
  const tables = useTables(source)
  // While searching, describe every table so column names can match too.
  const described = useQueries({
    queries: (term ? (tables.data ?? []) : []).map((t) => ({
      queryKey: ['table', source, t.name],
      queryFn: () => api.table(source, t.name),
    })),
  })
  if (tables.isPending) return <Loading what="Discovering tables" />
  if (tables.isError) return <ErrorState error={tables.error} />

  const columnsOf = (name: string): Table | undefined =>
    described.find((q) => q.data?.name === name)?.data
  return (
    <div className="flex flex-col gap-px">
      {tables.data.map((t) => {
        const byName = !term || matches(t.name, term)
        const columnHits = term
          ? (columnsOf(t.name)?.columns.filter((c) => matches(c.name, term)) ?? [])
          : []
        if (!byName && columnHits.length === 0) return null
        return (
          <ListItem
            key={t.name}
            icon={<Table2 size={14} strokeWidth={1.5} />}
            label={<FieldName name={shortTableName(t.name)} />}
            meta={formatCount(t.rowCount)}
            forceOpen={columnHits.length > 0 && !byName}
            onDragStart={(event) =>
              writeNodeTemplate(event.dataTransfer, {
                op: 'source',
                params: { system: source, entity: t.name },
                label: shortTableName(t.name),
              })
            }
          >
            <Columns source={source} table={t.name} only={byName ? undefined : term} />
          </ListItem>
        )
      })}
    </div>
  )
}

function Columns({ source, table, only }: { source: string; table: string; only?: string }) {
  const described = useTable(source, table)
  if (described.isPending) return <Loading what="Describing" />
  if (described.isError) return <ErrorState error={described.error} />
  const columns = described.data.columns.filter((c) => !only || matches(c.name, only))
  return (
    <ul className="my-0.5 ml-[15px] border-l border-line">
      {columns.map((c) => (
        <li
          key={c.name}
          title={[c.name, c.label, c.sourceType, c.description].filter(Boolean).join(' · ')}
          className="flex h-7 items-center gap-2 pr-2 pl-3 text-[12px]"
        >
          <FieldName name={c.name} custom={c.isCustom} />
          <TypeLabel type={c.logicalType} />
        </li>
      ))}
    </ul>
  )
}

const ROW_BUTTON =
  'grid size-6 place-items-center rounded text-faint transition-colors hover:bg-line-strong'

/** One mapping in the list; on hover, a pencil turns the row into a name field and a bin deletes. */
export function GraphItem({
  integrationId,
  graph,
  active,
}: {
  integrationId: string
  graph: GraphRef
  active: boolean
}) {
  const rename = useRename(graph)
  const [deleteFailed, setDeleteFailed] = useState<string | null>(null)
  if (rename.editing) {
    return (
      <div className="py-px">
        <NameInput value={graph.name} label="Mapping name" className="h-8" onDone={rename.finish} />
      </div>
    )
  }
  const failed = rename.failed
    ? `Rename failed: ${rename.failed}`
    : deleteFailed && `Delete failed: ${deleteFailed}`
  const remove = () => {
    if (!window.confirm(`Delete mapping “${graph.name}” and its saved document?`)) return
    setDeleteFailed(null)
    deleteMapping(graph.id).catch((error: Error) => setDeleteFailed(error.message))
  }
  return (
    <ListItem
      icon={<Workflow size={14} strokeWidth={1.5} />}
      label={
        <span className={`truncate ${failed ? 'text-down' : ''}`} title={failed || undefined}>
          {graph.name}
        </span>
      }
      active={active}
      onClick={() => select({ integrationId, graphId: graph.id })}
      actions={
        <>
          <button
            type="button"
            aria-label={`Rename ${graph.name}`}
            title="Rename"
            className={`${ROW_BUTTON} hover:text-fg`}
            onClick={rename.start}
          >
            <Pencil size={13} strokeWidth={1.5} />
          </button>
          <button
            type="button"
            aria-label={`Delete ${graph.name}`}
            title="Delete"
            className={`${ROW_BUTTON} hover:text-down`}
            onClick={remove}
          >
            <Trash2 size={13} strokeWidth={1.5} />
          </button>
        </>
      }
    />
  )
}

function Graphs({
  integration,
  graphId: selected,
}: {
  integration: Integration
  graphId?: string
}) {
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const submit = () => {
    if (name.trim()) {
      addGraph(integration.id, {
        id: graphId(integration.id, name, integration.graphs),
        name: name.trim(),
      })
    }
    setName('')
    setAdding(false)
  }
  return (
    <Section title="Mappings" meta={integration.graphs.length}>
      <div className="flex flex-col gap-px">
        {integration.graphs.map((g) => (
          <GraphItem
            key={g.id}
            integrationId={integration.id}
            graph={g}
            active={g.id === selected}
          />
        ))}
        {adding ? (
          <form
            className="pt-1"
            onSubmit={(e) => {
              e.preventDefault()
              submit()
            }}
          >
            <input
              autoFocus
              className="field text-[13px]"
              placeholder="Mapping name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={submit}
            />
          </form>
        ) : (
          <ListItem
            icon={<Plus size={14} strokeWidth={1.5} />}
            label={<span className="text-muted">New mapping</span>}
            onClick={() => setAdding(true)}
          />
        )}
      </div>
    </Section>
  )
}

/** Left: the input. Integration, its mappings, and (on demand) its source tables. */
/**
 * The left panel: integration (as the header), its mappings, and on demand their source tables
 * and the target model, so mapping reads left (source data) to right (target).
 */
export function InputSidebar({
  integrations,
  integration,
  graphId: selectedGraph,
  onClose,
}: {
  integrations: Integration[]
  integration: Integration | null
  graphId?: string
  onClose: () => void
}) {
  const [search, setSearch] = useState('')
  const sources = useSources()
  const status = sources.data?.find((s) => s.key === integration?.kind)?.status
  const term = search.trim().toLowerCase()
  const header = integration && (
    <Select
      aria-label="Integration"
      value={integration.id}
      onChange={(value) => {
        const next = integrations.find((i) => i.id === value)
        select({ integrationId: next?.id ?? null, graphId: next?.graphs[0]?.id ?? null })
      }}
      options={integrations.map((i) => ({
        value: i.id,
        label: i.name,
        hint: KINDS[i.kind].label.replace(' (demo)', ''),
      }))}
    />
  )
  const remove = integration && (
    <button
      type="button"
      className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-[12.5px] text-muted transition-colors hover:bg-raised hover:text-down"
      onClick={() => {
        if (window.confirm(`Delete “${integration.name}” and its mappings?`)) {
          removeIntegration(integration.id)
        }
      }}
    >
      <Trash2 size={14} strokeWidth={1.5} />
      Delete integration
    </button>
  )
  return (
    <Panel title="Input" header={header} footer={remove} onClose={onClose}>
      {integration ? (
        <>
          <Graphs integration={integration} graphId={selectedGraph} />
          <Section
            defaultOpen={false}
            title={
              <>
                <Database
                  size={13}
                  strokeWidth={1.5}
                  className={`shrink-0 ${status === 'unreachable' ? 'text-down' : ''}`}
                />
                Source tables
              </>
            }
          >
            {status === 'unreachable' ? (
              <p className="px-2 py-1 text-[12px] text-faint">Source not reachable.</p>
            ) : (
              <>
                <SearchField
                  value={search}
                  onChange={setSearch}
                  placeholder="Search tables and columns"
                />
                <Tables source={integration.kind} term={term} />
              </>
            )}
          </Section>
          <ModelSection />
        </>
      ) : (
        <p className="px-2 text-[13px] text-muted">
          No integrations yet. Add one from the rail on the left.
        </p>
      )}
    </Panel>
  )
}
