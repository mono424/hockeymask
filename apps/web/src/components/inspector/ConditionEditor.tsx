/**
 * A condition builder for the engine's predicate vocabulary (docs/operators.md): rows of
 * "subject, comparison, value", combined with all / any. Conditions the rows cannot express
 * (`not`, nested groups) stay editable as JSON in place.
 */

import { type MType, type RecordType, show, stripNull } from '@hockeymask/core'
import { X } from 'lucide-react'
import { useState } from 'react'
import { Select, type SelectOption } from '../Select'
import { useInspector } from './context'
import {
  AddRow,
  FieldSelect,
  fieldOptions,
  IconButton,
  NumberInput,
  Segmented,
  TextChips,
  TextInput,
} from './controls'

type Op =
  | 'eq'
  | 'neq'
  | 'lt'
  | 'lte'
  | 'gt'
  | 'gte'
  | 'in'
  | 'not_in'
  | 'before'
  | 'after'
  | 'matches'
  | 'empty'
  | 'set'
  | 'blank'
  | 'not_blank'

const OP_LABEL: Record<Op, string> = {
  eq: 'is',
  neq: 'is not',
  lt: 'is less than',
  lte: 'is at most',
  gt: 'is more than',
  gte: 'is at least',
  in: 'is one of',
  not_in: 'is not one of',
  before: 'is before',
  after: 'is after',
  matches: 'matches pattern',
  empty: 'is empty',
  set: 'is not empty',
  blank: 'is blank',
  not_blank: 'is not blank',
}

const PRESENCE: Partial<Record<Op, [string, boolean]>> = {
  empty: ['is_null', true],
  set: ['is_null', false],
  blank: ['is_blank', true],
  not_blank: ['is_blank', false],
}

interface Row {
  /** A field, or null for the piped value. */
  readonly path: string | null
  readonly op: Op
  readonly operand: unknown
}

type Mode = 'all' | 'any'

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function parseRow(cond: unknown): Row | null {
  if (!isObject(cond)) return null
  const { path, ...rest } = cond
  if (path !== undefined && typeof path !== 'string') return null
  const keys = Object.keys(rest)
  if (keys.length !== 1) return null
  const key = keys[0] as string
  const value = rest[key]
  const subject = path ?? null
  if (key === 'is_null' || key === 'is_blank') {
    if (typeof value !== 'boolean') return null
    const op: Op = key === 'is_null' ? (value ? 'empty' : 'set') : value ? 'blank' : 'not_blank'
    return { path: subject, op, operand: undefined }
  }
  if (!(key in OP_LABEL) || key in PRESENCE) return null
  return { path: subject, op: key as Op, operand: value }
}

/** The rows of a condition, or null when the form cannot show it. */
export function parseCondition(cond: unknown): { mode: Mode; rows: Row[] } | null {
  if (cond === undefined || (isObject(cond) && Object.keys(cond).length === 0)) {
    return { mode: 'all', rows: [] }
  }
  for (const mode of ['all', 'any'] as const) {
    if (isObject(cond) && Object.keys(cond).length === 1 && isObject(cond[mode])) {
      const of = (cond[mode] as { of?: unknown }).of
      if (!Array.isArray(of)) return null
      const rows = of.map(parseRow)
      return rows.every(Boolean) ? { mode, rows: rows as Row[] } : null
    }
  }
  const row = parseRow(cond)
  return row ? { mode: 'all', rows: [row] } : null
}

function toPredicate(row: Row): Record<string, unknown> {
  const presence = PRESENCE[row.op]
  return {
    ...(row.path === null ? {} : { path: row.path }),
    ...(presence ? { [presence[0]]: presence[1] } : { [row.op]: row.operand ?? '' }),
  }
}

export function serializeCondition(mode: Mode, rows: readonly Row[]): Record<string, unknown> {
  if (rows.length === 0) return {}
  if (rows.length === 1) return toPredicate(rows[0] as Row)
  return { [mode]: { of: rows.map(toPredicate) } }
}

function opsFor(type: MType | undefined): Op[] {
  const kind = type ? stripNull(type).kind : 'unknown'
  const base: Op[] = ['eq', 'neq', 'in', 'not_in', 'empty', 'set']
  if (kind === 'number') return [...base.slice(0, 2), 'lt', 'lte', 'gt', 'gte', ...base.slice(2)]
  if (kind === 'date')
    return ['before', 'after', 'eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'empty', 'set']
  if (kind === 'string') return [...base, 'blank', 'not_blank', 'matches', 'lt', 'gt']
  if (kind === 'boolean') return ['eq', 'neq', 'empty', 'set']
  return [...base, 'blank', 'not_blank', 'matches', 'lt', 'lte', 'gt', 'gte', 'before', 'after']
}

const PIPED = '__value'

/** A first condition to start from when one is switched on: the first field is not empty. */
export function starterCondition(record: RecordType): Record<string, unknown> {
  const first = Object.keys(record.fields)[0]
  return first ? { path: first, is_null: false } : {}
}

type Source = 'value' | 'ref' | 'param'

function sourceOf(operand: unknown): Source {
  if (isObject(operand) && typeof operand.ref === 'string') return 'ref'
  if (isObject(operand) && typeof operand.param === 'string') return 'param'
  return 'value'
}

/** The value a comparison is against: a literal shaped by the subject's type, a field, or a param. */
function OperandInput({
  row,
  type,
  record,
  onChange,
}: {
  row: Row
  type: MType | undefined
  record: RecordType
  onChange: (operand: unknown) => void
}) {
  const { version } = useInspector()
  const source = sourceOf(row.operand)
  const kind = type ? stripNull(type).kind : 'unknown'
  const list = row.op === 'in' || row.op === 'not_in'
  const params = Object.keys(version.params)

  let input
  if (source === 'ref') {
    input = (
      <FieldSelect
        record={record}
        value={String((row.operand as { ref: string }).ref)}
        onChange={(ref) => onChange({ ref })}
        aria-label="Compare with field"
      />
    )
  } else if (source === 'param') {
    input = (
      <Select
        mono
        aria-label="Compare with param"
        value={String((row.operand as { param: string }).param)}
        placeholder={params.length ? 'Choose a param' : 'No params in this mapping'}
        disabled={params.length === 0}
        onChange={(param) => onChange({ param })}
        options={params.map((name) => ({ value: name, label: name }))}
      />
    )
  } else if (list) {
    const values = Array.isArray(row.operand) ? row.operand.map(String) : []
    input = (
      <TextChips
        values={values}
        placeholder="Type a value, press Enter"
        onChange={(next) =>
          onChange(kind === 'number' ? next.map(Number).filter((n) => !Number.isNaN(n)) : next)
        }
      />
    )
  } else if (kind === 'boolean') {
    input = (
      <Segmented
        aria-label="Value"
        value={row.operand === true ? 'true' : row.operand === false ? 'false' : undefined}
        onChange={(v) => onChange(v === 'true')}
        options={[
          { value: 'true', label: 'Yes' },
          { value: 'false', label: 'No' },
        ]}
      />
    )
  } else if (kind === 'number' && row.op !== 'matches') {
    input = (
      <NumberInput
        aria-label="Value"
        value={typeof row.operand === 'number' ? row.operand : undefined}
        onChange={(n) => onChange(n ?? '')}
        placeholder="0"
      />
    )
  } else {
    const date = kind === 'date' || row.op === 'before' || row.op === 'after'
    input = (
      <TextInput
        mono
        aria-label="Value"
        value={
          typeof row.operand === 'string'
            ? row.operand
            : row.operand == null
              ? ''
              : JSON.stringify(row.operand)
        }
        placeholder={date ? 'today+10y, 2026-01-31' : row.op === 'matches' ? '^\\d{13}$' : 'value'}
        onChange={onChange}
      />
    )
  }

  return (
    <div className="space-y-1.5">
      <Segmented<Source>
        size="sm"
        aria-label="Compare with"
        value={source}
        onChange={(next) => {
          if (next === source) return
          if (next === 'ref') onChange({ ref: Object.keys(record.fields)[0] ?? '' })
          else if (next === 'param') onChange({ param: params[0] ?? '' })
          else onChange(list ? [] : '')
        }}
        options={[
          { value: 'value', label: 'Value' },
          { value: 'ref', label: 'Field' },
          { value: 'param', label: 'Param', title: 'A named constant of this mapping' },
        ]}
      />
      {input}
    </div>
  )
}

function RowEditor({
  row,
  record,
  piped,
  onChange,
  onRemove,
}: {
  row: Row
  record: RecordType
  piped: MType | undefined
  onChange: (row: Row) => void
  onRemove: () => void
}) {
  const subjectType = row.path === null ? piped : record.fields[row.path]
  const ops = opsFor(subjectType)
  const subjects: SelectOption[] = [
    ...(piped ? [{ value: PIPED, label: 'This value', hint: show(piped) }] : []),
    ...fieldOptions(record, row.path ? [row.path] : []),
  ]
  return (
    <div className="insp-cond-row">
      <div className="grid grid-cols-[1fr_1fr_auto] items-center gap-1.5">
        <Select
          mono={row.path !== null}
          aria-label="Subject"
          value={row.path ?? PIPED}
          onChange={(v) => onChange({ ...row, path: v === PIPED ? null : v })}
          options={subjects}
        />
        <Select
          aria-label="Comparison"
          value={row.op}
          onChange={(v) => {
            const op = v as Op
            const wasList = row.op === 'in' || row.op === 'not_in'
            const isList = op === 'in' || op === 'not_in'
            onChange({
              ...row,
              op,
              operand: PRESENCE[op]
                ? undefined
                : wasList === isList
                  ? row.operand
                  : isList
                    ? []
                    : '',
            })
          }}
          options={(ops.includes(row.op) ? ops : [row.op, ...ops]).map((op) => ({
            value: op,
            label: OP_LABEL[op],
          }))}
        />
        <IconButton label="Remove condition" tone="danger" onClick={onRemove}>
          <X size={13} strokeWidth={1.75} />
        </IconButton>
      </div>
      {!PRESENCE[row.op] && (
        <div className="mt-1.5">
          <OperandInput
            row={row}
            type={subjectType}
            record={record}
            onChange={(operand) => onChange({ ...row, operand })}
          />
        </div>
      )}
    </div>
  )
}

/**
 * `piped` is the type of the value being tested (`when`, `filter_list`); without it every
 * row tests a field of `record` (`filter`, join and aggregate `where`, `rows` checks).
 */
export function ConditionEditor({
  value,
  onChange,
  record,
  piped,
  emptyLabel = 'Add condition',
}: {
  value: unknown
  onChange: (cond: Record<string, unknown> | undefined) => void
  record: RecordType
  piped?: MType
  emptyLabel?: string
}) {
  const parsed = parseCondition(value)
  const [raw, setRaw] = useState(() => JSON.stringify(value ?? {}, null, 2))
  if (!parsed) {
    return (
      <div className="space-y-1.5">
        <p className="text-[11.5px] text-faint">Too complex for the form; edit it as JSON.</p>
        <textarea
          className="insp-code h-28"
          spellCheck={false}
          value={raw}
          onChange={(e) => {
            setRaw(e.target.value)
            try {
              onChange(JSON.parse(e.target.value) as Record<string, unknown>)
            } catch {
              // Applied once it parses.
            }
          }}
        />
      </div>
    )
  }
  const { mode, rows } = parsed
  const set = (nextMode: Mode, next: Row[]) => onChange(serializeCondition(nextMode, next))
  const fresh = (): Row => ({
    path: piped ? null : (Object.keys(record.fields)[0] ?? ''),
    op: 'eq',
    operand: '',
  })
  return (
    <div className="space-y-2">
      {rows.length > 1 && (
        <div className="flex items-center gap-2 text-[12px] text-muted">
          <span>Match</span>
          <Segmented<Mode>
            size="sm"
            aria-label="Match"
            value={mode}
            onChange={(m) => set(m, rows)}
            options={[
              { value: 'all', label: 'all' },
              { value: 'any', label: 'any' },
            ]}
          />
          <span>of these</span>
        </div>
      )}
      {rows.map((row, i) => (
        <RowEditor
          // Rows have no identity of their own; position is stable while editing one.
          key={i}
          row={row}
          record={record}
          piped={piped}
          onChange={(next) =>
            set(
              mode,
              rows.map((r, j) => (j === i ? next : r)),
            )
          }
          onRemove={() =>
            set(
              mode,
              rows.filter((_, j) => j !== i),
            )
          }
        />
      ))}
      <AddRow onClick={() => set(mode, [...rows, fresh()])}>
        {rows.length ? 'Add condition' : emptyLabel}
      </AddRow>
    </div>
  )
}
