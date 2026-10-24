/**
 * A field pipeline as a column of steps. Each step shows the type of the value after it, as
 * the compiler derives it, so the reader sees `string?` become `number?` become `number`.
 * Steps are edited with controls; problems show under the step that causes them.
 */

import {
  compileSteps,
  expandStep,
  type MType,
  type RecordType,
  recordEnv,
  stripNull,
  t,
} from '@hockeymask/core'
import * as RadixSelect from '@radix-ui/react-select'
import { ArrowDown, ArrowUp, ChevronsUpDown, Plus, X } from 'lucide-react'
import { useMemo } from 'react'
import { Select } from '../Select'
import { ConditionEditor } from './ConditionEditor'
import { str, strings, useInspector } from './context'
import {
  AddRow,
  Field,
  FieldChips,
  FieldSelect,
  IconButton,
  NumberInput,
  Segmented,
  Switch,
  TextChips,
  TextInput,
  TypeChip,
} from './controls'
import { DATE_FORMATS, OP_GROUPS, opInfo, opsIn, type ParamSpec } from './ops'

type Step = Record<string, unknown> & { op: string }

/** Steps of a pipeline; sugar such as `if_lte` is shown and edited as the `when` it means. */
const asSteps = (v: unknown): Step[] =>
  Array.isArray(v)
    ? v
        .filter(
          (s): s is Step =>
            typeof s === 'object' && s !== null && typeof (s as Step).op === 'string',
        )
        .map((s) => {
          const expanded = expandStep(s)
          return expanded.ok ? (expanded.value as Step) : s
        })
    : []

interface StepState {
  /** Type of the value after this step; undefined when it cannot be derived. */
  readonly type?: MType
  readonly error?: string
}

/** Type after every step, and the first step that fails, by compiling growing prefixes. */
function useStepStates(steps: readonly Step[], record: RecordType, input: MType): StepState[] {
  const { version } = useInspector()
  return useMemo(() => {
    // Until the input's fields are known (no connection, schema still loading) nothing can be
    // checked; showing every step as failing would only be noise.
    if (Object.keys(record.fields).length === 0) return steps.map(() => ({}))
    const env = recordEnv(record, { params: version.params, tables: version.tables })
    const states: StepState[] = []
    for (let i = 0; i < steps.length; i++) {
      // `lookup_entity` is rewritten into graph nodes on save; types after it are unknown here.
      if (steps.slice(0, i + 1).some((s) => s.op === 'lookup_entity')) {
        states.push({})
        continue
      }
      const result = compileSteps(steps.slice(0, i + 1), { ...env }, input)
      if (result.ok) states.push({ type: result.value.type })
      else if (result.error.step === i) states.push({ error: result.error.message })
      else states.push({})
    }
    return states
  }, [steps, record, input, version.params, version.tables])
}

/** Grouped op menu. As a trigger it is either the step's op label or an "Add step" row. */
function OpPicker({
  value,
  first,
  onPick,
  variant,
}: {
  value?: string
  first: boolean
  onPick: (op: string) => void
  variant: 'label' | 'add'
}) {
  const groups = OP_GROUPS.map((g) => [g, opsIn(g, first)] as const).filter(([, ops]) => ops.length)
  return (
    <RadixSelect.Root value={value ?? ''} onValueChange={onPick}>
      <RadixSelect.Trigger
        aria-label={variant === 'add' ? 'Add step' : 'Change step'}
        className={variant === 'add' ? 'insp-add' : 'insp-op-trigger'}
      >
        {variant === 'add' ? (
          <>
            <Plus size={13} strokeWidth={1.75} />
            {first ? 'Choose how to start' : 'Add step'}
          </>
        ) : (
          <>
            <span>{opInfo(value ?? '')?.label ?? value}</span>
            <ChevronsUpDown size={12} strokeWidth={1.5} className="text-faint" />
          </>
        )}
      </RadixSelect.Trigger>
      <RadixSelect.Portal>
        <RadixSelect.Content
          position="popper"
          sideOffset={4}
          className="select-content z-50 max-h-[min(420px,var(--radix-select-content-available-height))] w-[300px] overflow-hidden rounded-lg border border-line-strong bg-[#141518] p-1 shadow-xl shadow-black/60"
        >
          <RadixSelect.Viewport>
            {groups.map(([group, ops]) => (
              <RadixSelect.Group key={group}>
                <RadixSelect.Label className="px-2 pt-2 pb-1 text-[11px] font-medium text-faint">
                  {group}
                </RadixSelect.Label>
                {ops.map((o) => (
                  <RadixSelect.Item
                    key={o.op}
                    value={o.op}
                    className="flex cursor-default flex-col rounded-[5px] px-2 py-1.5 outline-none select-none data-[highlighted]:bg-raised"
                  >
                    <RadixSelect.ItemText>
                      <span className="text-[13px] text-fg">{o.label}</span>
                    </RadixSelect.ItemText>
                    <span className="text-[11.5px] leading-snug text-faint">{o.summary}</span>
                  </RadixSelect.Item>
                ))}
              </RadixSelect.Group>
            ))}
          </RadixSelect.Viewport>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  )
}

type LiteralKind = 'text' | 'number' | 'true' | 'false' | 'null'

function literalKind(v: unknown): LiteralKind {
  if (v === null) return 'null'
  if (v === true) return 'true'
  if (v === false) return 'false'
  return typeof v === 'number' ? 'number' : 'text'
}

/** A JSON scalar: the kind is chosen explicitly, so "1" and 1 never get confused. */
export function LiteralInput({
  value,
  onChange,
  allowNull = true,
}: {
  value: unknown
  onChange: (value: unknown) => void
  allowNull?: boolean
}) {
  const kind = literalKind(value)
  return (
    <div className="space-y-1.5">
      <Segmented<LiteralKind>
        size="sm"
        aria-label="Kind of value"
        value={kind}
        onChange={(k) =>
          onChange(
            k === 'text'
              ? ''
              : k === 'number'
                ? 0
                : k === 'true'
                  ? true
                  : k === 'false'
                    ? false
                    : null,
          )
        }
        options={[
          { value: 'text', label: 'Text' },
          { value: 'number', label: 'Number' },
          { value: 'true', label: 'Yes' },
          { value: 'false', label: 'No' },
          ...(allowNull ? [{ value: 'null' as const, label: 'Empty' }] : []),
        ]}
      />
      {kind === 'text' && (
        <TextInput
          mono
          aria-label="Value"
          value={str(value)}
          onChange={onChange}
          placeholder="value"
        />
      )}
      {kind === 'number' && (
        <NumberInput
          aria-label="Value"
          value={value as number}
          onChange={(n) => onChange(n ?? 0)}
        />
      )}
    </div>
  )
}

/** One param of a step, by its kind. */
function ParamControl({
  spec,
  step,
  record,
  piped,
  onChange,
}: {
  spec: ParamSpec
  step: Step
  record: RecordType
  piped: MType | undefined
  onChange: (value: unknown) => void
}) {
  const { version } = useInspector()
  const value = step[spec.key]
  if (spec.options) {
    const options = spec.options
    const control =
      options.length <= 4 && spec.kind !== 'unit' ? (
        <Segmented
          size="sm"
          aria-label={spec.label}
          value={str(value) || undefined}
          onChange={onChange}
          options={options}
        />
      ) : (
        <Select
          mono={spec.kind === 'unit'}
          aria-label={spec.label}
          value={str(value)}
          placeholder={spec.optional ? 'Not set' : 'Choose…'}
          onChange={onChange}
          options={options}
        />
      )
    return (
      <Field
        label={spec.label}
        hint={spec.hint}
        aside={
          spec.optional && value !== undefined ? (
            <button
              type="button"
              className="text-[11.5px] text-faint hover:text-fg"
              onClick={() => onChange(undefined)}
            >
              Clear
            </button>
          ) : undefined
        }
      >
        {control}
      </Field>
    )
  }
  switch (spec.kind) {
    case 'switch':
      return (
        <Switch
          label={spec.label}
          description={spec.hint}
          checked={value === true}
          onChange={(c) => onChange(c || undefined)}
        />
      )
    case 'field':
      return (
        <Field label={spec.label} hint={spec.hint}>
          <FieldSelect record={record} value={str(value)} onChange={onChange} />
        </Field>
      )
    case 'fields':
      return (
        <Field label={spec.label} hint={spec.hint}>
          <FieldChips record={record} values={strings(value)} onChange={onChange} />
        </Field>
      )
    case 'fieldOrFields': {
      const values = typeof value === 'string' ? (value ? [value] : []) : strings(value)
      return (
        <Field label={values.length > 1 ? 'Fields (a tuple)' : spec.label} hint={spec.hint}>
          {values.length <= 1 ? (
            <div className="flex items-center gap-1.5">
              <div className="min-w-0 flex-1">
                <FieldSelect
                  record={record}
                  value={values[0] ?? ''}
                  onChange={(v) => onChange(v)}
                />
              </div>
              {values.length === 1 && (
                <IconButton
                  label="Read another field too"
                  onClick={() => onChange([...values, ''])}
                >
                  <Plus size={13} strokeWidth={1.75} />
                </IconButton>
              )}
            </div>
          ) : (
            <FieldChips
              record={record}
              values={values.filter(Boolean)}
              onChange={(next) => onChange(next.length === 1 ? next[0] : next)}
            />
          )}
        </Field>
      )
    }
    case 'number':
    case 'integer':
      return (
        <Field label={spec.label} hint={spec.hint}>
          <NumberInput
            aria-label={spec.label}
            integer={spec.kind === 'integer'}
            value={typeof value === 'number' ? value : undefined}
            placeholder={spec.placeholder}
            onChange={(n) => onChange(n)}
          />
        </Field>
      )
    case 'literal':
      return (
        <Field label={spec.label} hint={spec.hint}>
          <LiteralInput value={value} onChange={onChange} allowNull={step.op !== 'default'} />
        </Field>
      )
    case 'dateFormat':
      return (
        <Field
          label={spec.label}
          hint={spec.hint ?? 'Tokens YYYY MM DD HH mm ss, or iso, epoch_ms, epoch_s.'}
        >
          <TextInput
            mono
            aria-label={spec.label}
            value={str(value)}
            placeholder={spec.placeholder ?? 'YYYY-MM-DD'}
            onChange={(v) => onChange(v || undefined)}
          />
          <div className="mt-1.5 flex flex-wrap gap-1">
            {DATE_FORMATS.map((f) => (
              <button
                key={f}
                type="button"
                className={`insp-preset ${value === f ? 'is-on' : ''}`}
                onClick={() => onChange(f)}
              >
                {f}
              </button>
            ))}
          </div>
        </Field>
      )
    case 'duration':
      return (
        <Field label={spec.label} hint="Signed amounts of y, mo, w, d, h; e.g. +10y or -30d.">
          <TextInput
            mono
            aria-label={spec.label}
            value={str(value)}
            placeholder="+1d"
            onChange={onChange}
          />
        </Field>
      )
    case 'cond':
      return (
        <Field label={spec.label}>
          <ConditionEditor value={value} record={record} piped={piped} onChange={onChange} />
        </Field>
      )
    case 'lookupTable': {
      const tables = Object.keys(version.tables)
      return (
        <Field
          label={spec.label}
          hint={tables.length ? undefined : 'Add tables to the mapping in JSON mode.'}
        >
          <Select
            mono
            aria-label={spec.label}
            value={str(value)}
            placeholder={tables.length ? 'Choose a table' : 'No tables yet'}
            disabled={tables.length === 0}
            onChange={onChange}
            options={tables.map((name) => ({
              value: name,
              label: name,
              hint: Object.keys(version.tables[name] ?? {}).length,
            }))}
          />
        </Field>
      )
    }
    case 'operand':
      return (
        <Field label={spec.label}>
          <LiteralInput value={value} onChange={onChange} allowNull={false} />
        </Field>
      )
    default: {
      const list = Array.isArray(value)
      return (
        <Field label={spec.label} hint={spec.hint}>
          {list ? (
            <TextChips
              values={strings(value)}
              onChange={onChange}
              placeholder={spec.placeholder ?? 'Add a value'}
            />
          ) : (
            <TextInput
              mono
              aria-label={spec.label}
              value={str(value)}
              placeholder={spec.placeholder}
              onChange={(v) => onChange(v === '' && spec.optional ? undefined : v)}
            />
          )}
        </Field>
      )
    }
  }
}

type Branch = 'pass' | 'null' | 'value'

const branchOf = (v: unknown): Branch =>
  typeof v === 'object' &&
  v !== null &&
  !Array.isArray(v) &&
  (v as { pass?: unknown }).pass === true
    ? 'pass'
    : v === null
      ? 'null'
      : 'value'

/** What a `when` case yields: the value unchanged, empty, or a literal. */
function BranchInput({
  value,
  onChange,
  canPass,
  label,
}: {
  value: unknown
  onChange: (value: unknown) => void
  canPass: boolean
  label: string
}) {
  const branch = branchOf(value)
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <span className="w-9 shrink-0 text-[12px] text-muted">{label}</span>
        <Segmented<Branch>
          size="sm"
          aria-label={label}
          value={branch}
          onChange={(b) => onChange(b === 'pass' ? { pass: true } : b === 'null' ? null : '')}
          options={[
            ...(canPass ? [{ value: 'pass' as const, label: 'Keep value' }] : []),
            { value: 'null', label: 'Empty' },
            { value: 'value', label: 'Value' },
          ]}
        />
      </div>
      {branch === 'value' && (
        <div className="pl-11">
          <LiteralInput value={value} onChange={onChange} allowNull={false} />
        </div>
      )}
    </div>
  )
}

function WhenEditor({
  step,
  record,
  piped,
  first,
  onChange,
}: {
  step: Step
  record: RecordType
  piped: MType | undefined
  first: boolean
  onChange: (step: Step) => void
}) {
  const cases = Array.isArray(step.cases)
    ? (step.cases as { cond?: unknown; then?: unknown }[])
    : []
  const setCases = (next: typeof cases) => onChange({ ...step, cases: next })
  return (
    <div className="space-y-2.5">
      {cases.map((c, i) => (
        <div key={i} className="insp-case">
          <div className="mb-2 flex items-center">
            <span className="text-[12px] font-medium text-muted">{i === 0 ? 'If' : 'Else if'}</span>
            {cases.length > 1 && (
              <span className="ml-auto">
                <IconButton
                  label="Remove case"
                  tone="danger"
                  onClick={() => setCases(cases.filter((_, j) => j !== i))}
                >
                  <X size={13} strokeWidth={1.75} />
                </IconButton>
              </span>
            )}
          </div>
          <ConditionEditor
            value={c.cond}
            record={record}
            piped={piped}
            onChange={(cond) => setCases(cases.map((x, j) => (j === i ? { ...x, cond } : x)))}
          />
          <div className="mt-2.5">
            <BranchInput
              label="then"
              canPass={!first}
              value={c.then ?? null}
              onChange={(then) => setCases(cases.map((x, j) => (j === i ? { ...x, then } : x)))}
            />
          </div>
        </div>
      ))}
      <AddRow
        onClick={() =>
          setCases([
            ...cases,
            {
              cond: first
                ? { path: Object.keys(record.fields)[0] ?? '', is_null: true }
                : { is_null: true },
              then: null,
            },
          ])
        }
      >
        Add case
      </AddRow>
      <BranchInput
        label="else"
        canPass={!first}
        value={step.else === undefined ? (first ? null : { pass: true }) : step.else}
        onChange={(v) => {
          const { else: _else, ...rest } = step
          onChange(branchOf(v) === 'pass' ? (rest as Step) : { ...rest, else: v })
        }}
      />
    </div>
  )
}

function LookupEntityEditor({ step, onChange }: { step: Step; onChange: (step: Step) => void }) {
  const { targets } = useInspector()
  const entities = targets?.entities ?? []
  const entity = entities.find((e) => e.name === step.entity)
  const fields = (entity?.fields ?? []).map((f) => ({
    value: f.name,
    label: f.name,
    hint: f.logicalType,
  }))
  const set = (patch: Record<string, unknown>) => onChange({ ...step, ...patch })
  return (
    <div className="space-y-3">
      <Field label="Entity">
        <Select
          mono
          aria-label="Entity"
          value={str(step.entity)}
          onChange={(v) => set({ entity: v, by: '', field: '' })}
          options={entities.map((e) => ({ value: e.name, label: e.name, hint: e.fields.length }))}
        />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Match on">
          <Select
            mono
            aria-label="Match on"
            value={str(step.by)}
            disabled={!entity}
            onChange={(v) => set({ by: v })}
            options={fields}
          />
        </Field>
        <Field label="Return">
          <Select
            mono
            aria-label="Return"
            value={str(step.field)}
            disabled={!entity}
            onChange={(v) => set({ field: v })}
            options={fields}
          />
        </Field>
      </div>
      <Field label="When not found">
        <Segmented
          size="sm"
          aria-label="When not found"
          value={str(step.on_miss) || 'null'}
          onChange={(v) => set({ on_miss: v === 'null' ? undefined : v })}
          options={[
            { value: 'null', label: 'Empty' },
            { value: 'pass', label: 'Keep key' },
            { value: 'error', label: 'Fail' },
          ]}
        />
      </Field>
    </div>
  )
}

function StepBody({
  step,
  record,
  piped,
  first,
  depth,
  onChange,
}: {
  step: Step
  record: RecordType
  /** Type of the value entering the step; undefined for a pipeline's first step. */
  piped: MType | undefined
  first: boolean
  depth: number
  onChange: (step: Step) => void
}) {
  if (step.op === 'when') {
    return (
      <WhenEditor step={step} record={record} piped={piped} first={first} onChange={onChange} />
    )
  }
  if (step.op === 'lookup_entity') return <LookupEntityEditor step={step} onChange={onChange} />
  if (step.op === 'each') {
    const element =
      piped && stripNull(piped).kind === 'list' ? (stripNull(piped) as { of: MType }).of : t.unknown
    if (depth > 0) return <p className="text-[11.5px] text-down">For each cannot be nested.</p>
    return (
      <div className="insp-nested">
        <PipelineEditor
          steps={asSteps(step.pipeline)}
          record={record}
          input={element}
          depth={depth + 1}
          onChange={(pipeline) => onChange({ ...step, pipeline })}
        />
      </div>
    )
  }
  const info = opInfo(step.op)
  if (!info) {
    return <p className="text-[11.5px] text-faint">No form for this step; edit it in JSON mode.</p>
  }
  if (info.params.length === 0) return null
  return (
    <div className="space-y-3">
      {info.params.map((spec) => (
        <ParamControl
          key={spec.key}
          spec={spec}
          step={step}
          record={record}
          piped={piped}
          onChange={(v) => {
            const next: Step = { ...step, [spec.key]: v }
            if (v === undefined) delete next[spec.key]
            onChange(next)
          }}
        />
      ))}
    </div>
  )
}

const SYMBOL: Record<string, string> = {
  eq: '=',
  neq: '≠',
  lt: '<',
  lte: '≤',
  gt: '>',
  gte: '≥',
  before: 'before',
  after: 'after',
  in: 'in',
  not_in: 'not in',
  matches: '~',
}

/** "≤ 0 → empty" for a one-case `when` on the value itself; else the number of cases. */
function whenSummary(step: Step): string {
  const cases = Array.isArray(step.cases)
    ? (step.cases as { cond?: unknown; then?: unknown }[])
    : []
  const only = cases.length === 1 ? cases[0] : undefined
  const cond =
    only && typeof only.cond === 'object' && only.cond !== null
      ? (only.cond as Record<string, unknown>)
      : undefined
  const keys = cond ? Object.keys(cond) : []
  const key = keys[0]
  if (cond && keys.length === 1 && key && SYMBOL[key] && typeof cond[key] !== 'object') {
    const then = only?.then === null ? 'empty' : JSON.stringify(only?.then)
    return `${SYMBOL[key]} ${JSON.stringify(cond[key])} → ${then}`
  }
  return `${cases.length} case${cases.length === 1 ? '' : 's'}`
}

/** A one-line reading of a step, for collapsed fields: "Read field" + "width_mm". */
export function stepSummary(step: Step): { label: string; detail: string } {
  const info = opInfo(step.op)
  const label = info?.label ?? step.op
  const detail =
    step.op === 'extract'
      ? Array.isArray(step.path)
        ? strings(step.path).join(' + ')
        : str(step.path)
      : step.op === 'divide' || step.op === 'multiply'
        ? typeof step.by === 'number'
          ? String(step.by)
          : ''
        : step.op === 'convert_unit'
          ? `to ${str(step.to)}`
          : step.op === 'when'
            ? whenSummary(step)
            : step.op === 'const'
              ? JSON.stringify(step.value)
              : step.op === 'to_date' || step.op === 'format_date'
                ? str(step.format)
                : ''
  return { label, detail }
}

export function PipelineEditor({
  steps,
  record,
  input = t.unit,
  depth = 0,
  onChange,
}: {
  steps: readonly Step[]
  record: RecordType
  /** Type of the value entering the first step; `unit` for a field pipeline. */
  input?: MType
  depth?: number
  onChange: (steps: Step[]) => void
}) {
  const states = useStepStates(steps, record, input)
  const top = input.kind === 'unit'
  const replace = (i: number, step: Step) => onChange(steps.map((s, j) => (j === i ? step : s)))
  const move = (i: number, by: -1 | 1) => {
    const next = [...steps]
    const [s] = next.splice(i, 1)
    next.splice(i + by, 0, s as Step)
    onChange(next)
  }
  return (
    <ol className="insp-steps">
      {steps.map((step, i) => {
        const first = i === 0 && top
        // An unknown type (input not ready, an earlier step failing) still has a value to test.
        const piped = first ? undefined : i === 0 ? input : (states[i - 1]?.type ?? t.unknown)
        const state = states[i] ?? {}
        const entry = opInfo(step.op)?.entry === true
        return (
          // Steps have no ids; a step keeps its position while edited.
          <li key={i} className={`insp-step ${state.error ? 'has-error' : ''}`}>
            <div className="flex items-center gap-1.5">
              <OpPicker
                variant="label"
                value={step.op}
                first={first}
                onPick={(op) => op !== step.op && replace(i, { op, ...opInfo(op)?.make() })}
              />
              <span className="ml-auto flex items-center gap-0.5">
                <TypeChip type={state.type} />
                <span className="insp-step-tools">
                  {i > 0 && !entry && (
                    <IconButton label="Move up" onClick={() => move(i, -1)}>
                      <ArrowUp size={12} strokeWidth={1.75} />
                    </IconButton>
                  )}
                  {i < steps.length - 1 && i > 0 && (
                    <IconButton label="Move down" onClick={() => move(i, 1)}>
                      <ArrowDown size={12} strokeWidth={1.75} />
                    </IconButton>
                  )}
                  <IconButton
                    label="Remove step"
                    tone="danger"
                    onClick={() => onChange(steps.filter((_, j) => j !== i))}
                  >
                    <X size={13} strokeWidth={1.75} />
                  </IconButton>
                </span>
              </span>
            </div>
            <div className="mt-2">
              <StepBody
                step={step}
                record={record}
                piped={piped}
                first={first}
                depth={depth}
                onChange={(s) => replace(i, s)}
              />
            </div>
            {state.error && (
              <p className="mt-2 text-[11.5px] leading-snug text-down">{state.error}</p>
            )}
          </li>
        )
      })}
      <li className="insp-step insp-step--add">
        <OpPicker
          variant="add"
          first={steps.length === 0 && top}
          onPick={(op) => onChange([...steps, { op, ...opInfo(op)?.make() }])}
        />
      </li>
    </ol>
  )
}

export { asSteps }
export type { Step }
