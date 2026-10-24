import { compileSteps, recordEnv, type RecordType } from '@hockeymask/core'
import { ChevronDown, ChevronRight, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Select } from '../../Select'
import { useInputType, useInspector, useParams } from '../context'
import { AddRow, Group, IconButton, Switch, TextInput, TypeChip } from '../controls'
import { asSteps, PipelineEditor, type Step, stepSummary } from '../PipelineEditor'

interface FieldDef {
  key: string
  pipeline: Step[]
}

const asFields = (v: unknown): FieldDef[] =>
  Array.isArray(v)
    ? v.map((f) => {
        const o = (typeof f === 'object' && f !== null ? f : {}) as {
          key?: unknown
          pipeline?: unknown
        }
        return { key: typeof o.key === 'string' ? o.key : '', pipeline: asSteps(o.pipeline) }
      })
    : []

const ON_ERROR = [
  { value: 'default', label: 'Mapping default', hint: 'skip record' },
  { value: 'skip_record', label: 'Skip the record' },
  { value: 'skip_field', label: 'Leave the field out' },
  { value: 'null', label: 'Write empty' },
  { value: 'fail_sync', label: 'Stop the sync' },
]

function FieldCard({
  field,
  record,
  open,
  onToggle,
  onChange,
  onRemove,
  duplicate,
}: {
  field: FieldDef
  record: RecordType
  open: boolean
  onToggle: () => void
  onChange: (field: FieldDef) => void
  onRemove: () => void
  duplicate: boolean
}) {
  const { version } = useInspector()
  const ready = Object.keys(record.fields).length > 0
  const result = useMemo(
    () =>
      !ready || field.pipeline.some((s) => s.op === 'lookup_entity')
        ? undefined
        : compileSteps(
            field.pipeline,
            recordEnv(record, { params: version.params, tables: version.tables }),
          ),
    [ready, field.pipeline, record, version.params, version.tables],
  )
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <div
      className={`insp-fieldcard ${open ? 'is-open' : ''} ${result && !result.ok ? 'has-error' : ''}`}
    >
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-label={open ? 'Collapse' : 'Expand'}
          aria-expanded={open}
          className="insp-disclosure"
          onClick={onToggle}
        >
          <Chevron size={13} strokeWidth={1.75} />
        </button>
        <div className="min-w-0 flex-1">
          <TextInput
            mono
            aria-label="Output field"
            value={field.key}
            invalid={!field.key || duplicate}
            placeholder="product.sku"
            onChange={(key) => onChange({ ...field, key })}
          />
        </div>
        <TypeChip type={result?.ok ? result.value.type : undefined} />
        <IconButton label={`Remove ${field.key || 'field'}`} tone="danger" onClick={onRemove}>
          <X size={13} strokeWidth={1.75} />
        </IconButton>
      </div>
      {!open && (
        <button type="button" className="insp-summary" onClick={onToggle}>
          {field.pipeline.length
            ? field.pipeline.map((step, i) => {
                const { label, detail } = stepSummary(step)
                return (
                  <span key={i}>
                    {i > 0 && <span className="insp-summary-arrow">→</span>}
                    {label}
                    {detail && <span className="insp-summary-detail"> {detail}</span>}
                  </span>
                )
              })
            : 'No steps yet'}
        </button>
      )}
      {open && (
        <div className="mt-3">
          <PipelineEditor
            steps={field.pipeline}
            record={record}
            onChange={(pipeline) => onChange({ ...field, pipeline })}
          />
        </div>
      )}
      {duplicate && (
        <p className="mt-1.5 text-[11.5px] text-down">Another field already has this name.</p>
      )}
    </div>
  )
}

/** One output field per pipeline; open a field to edit its steps. */
export function MapForm() {
  const { params, set } = useParams()
  const record = useInputType()
  const fields = asFields(params.fields)
  const [open, setOpen] = useState<number | null>(fields.length === 1 ? 0 : null)
  const setFields = (next: FieldDef[]) => set({ fields: next })
  const keys = fields.map((f) => f.key)
  const inputCount = Object.keys(record.fields).length

  return (
    <>
      <Group title="Fields" aside={fields.length || undefined}>
        {fields.length === 0 && (
          <p className="text-[12px] text-faint">
            Each field reads from the {inputCount ? `${inputCount} input fields` : 'input'} and
            computes one output value.
          </p>
        )}
        <div className="space-y-2">
          {fields.map((field, i) => (
            <FieldCard
              // Fields are edited in place; their position is their identity while the card is open.
              key={i}
              field={field}
              record={record}
              open={open === i}
              duplicate={field.key !== '' && keys.indexOf(field.key) !== i}
              onToggle={() => setOpen(open === i ? null : i)}
              onChange={(next) => setFields(fields.map((f, j) => (j === i ? next : f)))}
              onRemove={() => {
                setFields(fields.filter((_, j) => j !== i))
                setOpen(null)
              }}
            />
          ))}
        </div>
        <AddRow
          onClick={() => {
            let n = fields.length + 1
            while (keys.includes(`field_${n}`)) n += 1
            setFields([...fields, { key: `field_${n}`, pipeline: [{ op: 'extract', path: '' }] }])
            setOpen(fields.length)
          }}
        >
          Add field
        </AddRow>
      </Group>
      <Group title="Options">
        <Switch
          label="Pass input fields through"
          description="Keep every input field next to the new ones."
          checked={params.keep === 'all'}
          onChange={(on) =>
            set({ keep: on ? 'all' : undefined, drop: on ? params.drop : undefined })
          }
        />
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-[12.5px] text-fg">When a field fails</p>
            <p className="mt-0.5 text-[11.5px] leading-snug text-faint">
              A step that can fail, such as an unknown unit or text that is not a date.
            </p>
          </div>
          <div className="w-40 shrink-0">
            <Select
              aria-label="When a field fails"
              value={typeof params.on_error === 'string' ? params.on_error : 'default'}
              onChange={(v) => set({ on_error: v === 'default' ? undefined : v })}
              options={ON_ERROR}
            />
          </div>
        </div>
      </Group>
    </>
  )
}
