import {
  assignable,
  fromLogicalType,
  type MType,
  nullableIf,
  type RecordType,
  refType,
  resolveTarget,
  show,
  t,
  type TargetEntity,
} from '@hockeymask/core'
import { Check, TriangleAlert } from 'lucide-react'
import { Select } from '../../Select'
import { record as asRecord, str, strings, useInputType, useInspector, useParams } from '../context'
import { Field, FieldChips, Group, Note, TypeChip } from '../controls'

/** The fields of an entity as a record type, for picking the fields a reference is keyed by. */
const entityRecord = (entity: TargetEntity): RecordType =>
  t.record(
    Object.fromEntries(
      entity.fields.map((f) => [f.name, nullableIf(fromLogicalType(f.logicalType), f.nullable)]),
    ),
  )

const POLICIES = [
  { value: 'overwrite', label: 'Overwrite' },
  { value: 'fill_if_null', label: 'If empty' },
  { value: 'never', label: 'Never' },
]

const MODES = [
  { value: 'upsert', label: 'Keep' },
  { value: 'replace', label: 'Remove' },
]

/** Upsert into a target entity: pick the entity, the key, and where each field lands. */
export function SinkForm() {
  const { targets } = useInspector()
  const { params, set } = useParams()
  const record = useInputType()
  const target = str(params.target)
  const columns = asRecord(params.columns) as Record<string, string>
  const write = asRecord(params.write) as Record<string, string>
  const refs = asRecord(params.refs) as Record<string, { by?: unknown }>
  const entities = targets?.entities ?? []
  const own = entities.find((e) => e.name === target)
  const others = entities.filter((e) => e.name !== target)
  const paths = [own, ...others].flatMap((e) =>
    e
      ? e.fields.map((f) => ({
          value: `${e.name}.${f.name}`,
          label: `${e.name}.${f.name}`,
          hint: f.logicalType,
        }))
      : [],
  )
  const fields = Object.entries(record.fields)

  const setColumn = (field: string, path: string) => {
    const next = { ...columns }
    if (path === field) delete next[field]
    else next[field] = path
    set({ columns: Object.keys(next).length ? next : undefined })
  }
  const setPolicy = (field: string, policy: string) => {
    const next = { ...write }
    if (policy === 'overwrite') delete next[field]
    else next[field] = policy
    set({ write: Object.keys(next).length ? next : undefined })
  }
  const setRef = (field: string, by: string[]) => {
    const { [field]: _dropped, ...rest } = refs
    const next = by.length ? { ...rest, [field]: { by } } : rest
    set({ refs: Object.keys(next).length ? next : undefined })
  }

  return (
    <>
      <Group title="Destination">
        <Field label="Target entity">
          <Select
            aria-label="Target entity"
            mono
            value={target}
            onChange={(value) => set({ target: value })}
            options={entities.map((e) => ({ value: e.name, label: e.name, hint: e.fields.length }))}
          />
        </Field>
        <Field
          label="Match existing records on"
          hint="A re-import updates the record with the same key instead of adding one."
        >
          <FieldChips
            record={record}
            values={strings(params.key)}
            onChange={(key) => set({ key })}
            placeholder="Add a key field"
          />
        </Field>
        <Field
          label="Records no longer produced"
          hint="Remove makes each run the full set and deletes the rest. The input needs a count expectation with a minimum that stops the run."
        >
          <Select
            aria-label="Records no longer produced"
            value={params.mode === 'replace' ? 'replace' : 'upsert'}
            onChange={(value) => set({ mode: value === 'replace' ? 'replace' : undefined })}
            options={MODES}
          />
        </Field>
      </Group>
      <Group title="Columns" aside={fields.length || undefined}>
        {fields.length === 0 && <Note>Connect the step whose fields this writes.</Note>}
        <ul className="space-y-1.5">
          {fields.map(([field, type]) => {
            const path = columns[field] ?? field
            const resolved = targets && target ? resolveTarget(targets, target, path) : undefined
            const by = strings(refs[field]?.by)
            const referenced = resolved?.ok
              ? entities.find((e) => e.name === resolved.value.field.references)
              : undefined
            // A reference written as a natural key is typed by the fields it is keyed by.
            const ref =
              targets && resolved?.ok && by.length
                ? refType(targets, resolved.value.field, by)
                : undefined
            const expected = ref
              ? ref.ok
                ? ref.value.type
                : undefined
              : resolved?.ok
                ? resolved.value.type
                : undefined
            const fits = expected !== undefined && assignable(type as MType, expected)
            const why = !resolved
              ? undefined
              : !resolved.ok
                ? resolved.error
                : ref && !ref.ok
                  ? ref.error
                  : `${fits ? 'Writes' : `${resolved.value.entity.name}.${resolved.value.field.name} expects`} ${show(expected as MType)}`
            const options = paths.some((o) => o.value === path || o.value === `${target}.${path}`)
              ? paths
              : [{ value: path, label: path, hint: 'unknown' }, ...paths]
            return (
              <li key={field} className="insp-column">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className={fits ? 'text-ok' : 'text-down'} title={why}>
                    {fits ? (
                      <Check size={12} strokeWidth={2} />
                    ) : (
                      <TriangleAlert size={12} strokeWidth={1.75} />
                    )}
                  </span>
                  <span className="truncate font-mono text-[12.5px]">{field}</span>
                  <span className="ml-auto">
                    <TypeChip type={type as MType} />
                  </span>
                </div>
                <div className="mt-1.5 grid grid-cols-[1fr_112px] gap-1.5">
                  <Select
                    mono
                    aria-label={`Target of ${field}`}
                    value={path.includes('.') ? path : `${target}.${path}`}
                    onChange={(v) => setColumn(field, v)}
                    options={options}
                  />
                  <Select
                    aria-label={`Write policy of ${field}`}
                    value={write[field] ?? 'overwrite'}
                    onChange={(v) => setPolicy(field, v)}
                    options={POLICIES}
                  />
                </div>
                {referenced && (
                  <div className="mt-1.5">
                    <FieldChips
                      record={entityRecord(referenced)}
                      values={by}
                      onChange={(next) => setRef(field, next)}
                      placeholder={`Find the ${referenced.name} by…`}
                    />
                  </div>
                )}
                {!fits && why && <p className="mt-1 text-[11.5px] leading-snug text-down">{why}</p>}
              </li>
            )
          })}
        </ul>
      </Group>
    </>
  )
}
