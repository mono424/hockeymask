import { Table2 } from 'lucide-react'
import { useState } from 'react'
import { type EntityRecord, useEditTargetEntity, useTargetEntities } from '../api'
import { usePersistentState } from '../lib/store'
import { ErrorState, ListItem, Loading } from './ui'

const pretty = (value: unknown) => JSON.stringify(value, null, 2)

/** Why `text` can't be saved as JSON, if it can't. */
function jsonError(text: string): string | null {
  try {
    JSON.parse(text)
    return null
  } catch (error) {
    return (error as Error).message
  }
}

/** The target data model, one JSON document per table: edit, save, or reset to default. */
export function SchemaPage() {
  const entities = useTargetEntities()
  const [selected, setSelected] = usePersistentState<string | null>(
    'hockeymask.schema.table.v1',
    () => null,
  )
  // Unsaved text per table, so switching tables keeps an edit in progress.
  const [drafts, setDrafts] = useState<Record<string, string>>({})

  const list = entities.data ?? []
  const open = list.find((e) => e.entity.name === selected) ?? list[0]

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line px-4">
        <h1 className="text-[14px] font-semibold tracking-[-0.01em]">Target schema</h1>
        <p className="truncate text-[13px] text-muted">
          The model mappings write to and are checked against, one JSON document per table.
        </p>
      </header>
      {entities.isPending ? (
        <div className="pt-3">
          <Loading what="Loading schema" />
        </div>
      ) : entities.isError ? (
        <div className="pt-3">
          <ErrorState error={entities.error} />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <nav
            aria-label="Tables"
            className="w-64 shrink-0 overflow-y-auto border-r border-line p-2"
          >
            {list.map(({ entity, edited }) => (
              <ListItem
                key={entity.name}
                icon={<Table2 size={14} strokeWidth={1.5} />}
                label={<span className="truncate font-mono text-[12.5px]">{entity.name}</span>}
                meta={drafts[entity.name] !== undefined ? 'unsaved' : edited ? 'edited' : undefined}
                active={entity.name === open?.entity.name}
                onClick={() => setSelected(entity.name)}
              />
            ))}
          </nav>
          {open && (
            <EntityEditor
              key={open.entity.name}
              record={open}
              draft={drafts[open.entity.name]}
              onDraft={(text) => {
                const { [open.entity.name]: _, ...rest } = drafts
                setDrafts(text === undefined ? rest : { ...rest, [open.entity.name]: text })
              }}
            />
          )}
        </div>
      )}
    </div>
  )
}

function EntityEditor({
  record,
  draft,
  onDraft,
}: {
  record: EntityRecord
  draft: string | undefined
  /** The unsaved text, or `undefined` once it is saved, reset or back to the stored one. */
  onDraft: (text: string | undefined) => void
}) {
  const { entity, edited } = record
  const edit = useEditTargetEntity()
  const stored = pretty(entity)
  const text = draft ?? stored
  const invalid = jsonError(text)

  const save = () =>
    edit.mutate(
      { name: entity.name, entity: JSON.parse(text) },
      { onSuccess: () => onDraft(undefined) },
    )
  const reset = () => {
    if (window.confirm(`Reset “${entity.name}” to the schema derived from its table?`)) {
      edit.mutate({ name: entity.name, entity: null }, { onSuccess: () => onDraft(undefined) })
    }
  }

  return (
    <section className="flex min-w-0 flex-1 flex-col gap-3 p-4">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="font-mono text-[14px]">{entity.name}</h2>
          <p className="mt-0.5 text-[13px] text-muted">
            {entity.description ?? 'No description.'}
            {edited && ' · Edited; mappings are checked against this version.'}
          </p>
        </div>
        {draft !== undefined && (
          <button type="button" className="btn" onClick={() => onDraft(undefined)}>
            Discard
          </button>
        )}
        {edited && (
          <button type="button" className="btn" disabled={edit.isPending} onClick={reset}>
            Reset to default
          </button>
        )}
        <button
          type="button"
          className="btn btn-primary"
          disabled={draft === undefined || invalid !== null || edit.isPending}
          onClick={save}
        >
          Save
        </button>
      </div>
      <textarea
        className="field min-h-0 flex-1 resize-none font-mono text-[12px] leading-relaxed"
        aria-label={`Schema of ${entity.name}`}
        spellCheck={false}
        value={text}
        onChange={(e) => {
          if (edit.isError) edit.reset()
          onDraft(e.target.value === stored ? undefined : e.target.value)
        }}
      />
      {invalid !== null ? (
        <p className="text-[12px] text-down">Invalid JSON: {invalid}</p>
      ) : (
        edit.isError && (
          <p role="alert" className="text-[12px] text-down">
            {(edit.error as Error).message}
          </p>
        )
      )}
    </section>
  )
}
