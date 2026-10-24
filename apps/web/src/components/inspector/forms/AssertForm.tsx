import { nodeCatalog, type RecordType, t } from '@hockeymask/core'
import { X } from 'lucide-react'
import { Select } from '../../Select'
import { ConditionEditor, starterCondition } from '../ConditionEditor'
import {
  nodeName,
  record as asRecord,
  str,
  strings,
  useInputType,
  useInspector,
  useParams,
} from '../context'
import {
  AddRow,
  Field,
  FieldChips,
  FieldSelect,
  Group,
  IconButton,
  NumberInput,
  Segmented,
  Switch,
} from '../controls'
import { LiteralInput } from '../PipelineEditor'

type Check = 'count' | 'unique' | 'rows' | 'acyclic'

const CHECKS: Record<Check, string> = {
  count: 'The number of rows stays within bounds.',
  unique: 'No two rows share a key.',
  rows: 'Every row satisfies a condition.',
  acyclic: 'Edges contain no cycle, per group, once that group’s removed edges are taken out.',
}

const ACTIONS = [
  { value: 'alert', label: 'Alert and continue', checks: ['count', 'unique', 'rows', 'acyclic'] },
  { value: 'drop_rows', label: 'Drop failing rows', checks: ['unique', 'rows'] },
  { value: 'set_null', label: 'Empty some fields', checks: ['rows'] },
  { value: 'set_default', label: 'Set default values', checks: ['rows'] },
  {
    value: 'skip_downstream',
    label: 'Hold back writes below',
    checks: ['count', 'unique', 'rows', 'acyclic'],
  },
  { value: 'stop', label: 'Stop the sync', checks: ['count', 'unique', 'rows', 'acyclic'] },
] as const

function actionName(v: unknown): string {
  if (typeof v === 'string') return v
  const o = asRecord(v)
  return 'set_null' in o ? 'set_null' : 'set_default' in o ? 'set_default' : 'alert'
}

/** Nodes this one may read for per / remove: anything upstream-capable with an output. */
function useNodeOptions() {
  const { version, node } = useInspector()
  const outputs = new Set(nodeCatalog.filter((e) => e.output).map((e) => e.op))
  return version.nodes
    .filter((n) => n.id !== node.id && outputs.has(n.op))
    .map((n) => ({ value: n.id, label: nodeName(version, n.id), hint: n.op }))
}

function OnFail({
  check,
  value,
  onChange,
  record,
}: {
  check: Check
  value: unknown
  onChange: (v: unknown) => void
  record: RecordType
}) {
  const name = actionName(value)
  const options = ACTIONS.filter((a) => (a.checks as readonly string[]).includes(check))
  const o = asRecord(value)
  const defaults = Object.entries(asRecord(o.set_default))
  return (
    <Field label="When it fails" hint="Every failure is also recorded as an issue on the run.">
      <Select
        aria-label="When it fails"
        value={options.some((a) => a.value === name) ? name : 'alert'}
        onChange={(v) =>
          onChange(
            v === 'alert'
              ? undefined
              : v === 'set_null'
                ? { set_null: [] }
                : v === 'set_default'
                  ? { set_default: {} }
                  : v,
          )
        }
        options={options.map(({ value, label }) => ({ value, label }))}
      />
      {name === 'set_null' && (
        <div className="mt-2">
          <FieldChips
            record={record}
            values={strings(o.set_null)}
            onChange={(f) => onChange({ set_null: f })}
            placeholder="Empty this field"
          />
        </div>
      )}
      {name === 'set_default' && (
        <div className="mt-2 space-y-1.5">
          {defaults.map(([field, v], i) => (
            <div key={i} className="insp-case space-y-1.5">
              <div className="flex items-center gap-1.5">
                <div className="min-w-0 flex-1">
                  <FieldSelect
                    record={record}
                    value={field}
                    onChange={(f) =>
                      onChange({
                        set_default: Object.fromEntries(
                          defaults.map((e, j) => (j === i ? [f, e[1]] : e)),
                        ),
                      })
                    }
                  />
                </div>
                <IconButton
                  label="Remove default"
                  tone="danger"
                  onClick={() =>
                    onChange({
                      set_default: Object.fromEntries(defaults.filter((_, j) => j !== i)),
                    })
                  }
                >
                  <X size={13} strokeWidth={1.75} />
                </IconButton>
              </div>
              <LiteralInput
                value={v}
                allowNull={false}
                onChange={(nv) =>
                  onChange({
                    set_default: Object.fromEntries(
                      defaults.map((e, j) => (j === i ? [e[0], nv] : e)),
                    ),
                  })
                }
              />
            </div>
          ))}
          <AddRow
            onClick={() =>
              onChange({
                set_default: {
                  ...asRecord(o.set_default),
                  [Object.keys(record.fields).find((f) => !(f in asRecord(o.set_default))) ?? '']:
                    '',
                },
              })
            }
          >
            Add default
          </AddRow>
        </div>
      )}
    </Field>
  )
}

/** A built-in check that passes its input through, repaired if the action repairs rows. */
export function AssertForm() {
  const { types } = useInspector()
  const { params, set } = useParams()
  const record = useInputType()
  const nodes = useNodeOptions()
  const check = (str(params.check) || 'count') as Check
  const edge = asRecord(params.edge)
  const per = params.per === undefined ? undefined : asRecord(params.per)
  const remove = params.remove === undefined ? undefined : asRecord(params.remove)
  const keyed = edge.key !== undefined
  const typeOf = (id: unknown) => (typeof id === 'string' && types[id]) || t.record({})

  const switchCheck = (next: Check) => {
    if (next === check) return
    const base: Record<string, unknown> = {
      check: next,
      on_fail: undefined,
      min: undefined,
      max: undefined,
      keys: undefined,
      cond: undefined,
      edge: undefined,
      per: undefined,
      remove: undefined,
    }
    if (next === 'unique') base.keys = []
    if (next === 'rows') base.cond = {}
    if (next === 'acyclic') base.edge = { from: '', to: '' }
    set(base)
  }

  return (
    <>
      <Group title="Check">
        <Field label="What must hold" hint={CHECKS[check]}>
          <Segmented<Check>
            aria-label="Check"
            value={check}
            onChange={switchCheck}
            options={[
              { value: 'count', label: 'Row count' },
              { value: 'unique', label: 'Unique' },
              { value: 'rows', label: 'Every row' },
              { value: 'acyclic', label: 'No cycles' },
            ]}
          />
        </Field>
        {check === 'count' && (
          <div className="grid grid-cols-2 gap-2">
            <Field label="At least">
              <NumberInput
                aria-label="At least"
                integer
                value={typeof params.min === 'number' ? params.min : undefined}
                placeholder="no minimum"
                onChange={(min) => set({ min })}
              />
            </Field>
            <Field label="At most">
              <NumberInput
                aria-label="At most"
                integer
                value={typeof params.max === 'number' ? params.max : undefined}
                placeholder="no maximum"
                onChange={(max) => set({ max })}
              />
            </Field>
          </div>
        )}
        {check === 'unique' && (
          <Field label="Key">
            <FieldChips
              record={record}
              values={strings(params.keys)}
              onChange={(keys) => set({ keys })}
            />
          </Field>
        )}
        {check === 'rows' && (
          <Field label="Every row must satisfy">
            <ConditionEditor
              value={params.cond}
              record={record}
              onChange={(cond) => set({ cond: cond ?? {} })}
            />
          </Field>
        )}
        {check === 'acyclic' && (
          <>
            <Field label="Edges" hint="Each row of the input is an edge from one value to another.">
              <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-1.5">
                <FieldSelect
                  record={record}
                  value={str(edge.from)}
                  placeholder="From"
                  aria-label="Edge from"
                  onChange={(from) => set({ edge: { ...edge, from } })}
                />
                <span className="text-faint">→</span>
                <FieldSelect
                  record={record}
                  value={str(edge.to)}
                  placeholder="To"
                  aria-label="Edge to"
                  onChange={(to) => set({ edge: { ...edge, to } })}
                />
              </div>
            </Field>
            <Switch
              label="Edges belong to groups"
              description="Each row names its group, such as a product, and every group is checked on its own edges."
              checked={keyed}
              onChange={(on) => {
                const { key: _k, ...rest } = edge
                set({
                  edge: on ? { ...rest, key: '' } : rest,
                  per: undefined,
                  remove: on ? remove : undefined,
                })
              }}
            />
            {keyed && (
              <Field label="Group key">
                <FieldSelect
                  record={record}
                  value={str(edge.key)}
                  aria-label="Edge group key"
                  onChange={(key) => set({ edge: { ...edge, key } })}
                />
              </Field>
            )}
            {!keyed && (
              <Switch
                label="Check per group"
                description="Run the check once for every distinct key of another step, on all edges."
                checked={per !== undefined}
                onChange={(on) =>
                  set({
                    per: on ? { in: '', key: '' } : undefined,
                    remove: on ? remove : undefined,
                  })
                }
              />
            )}
            {per && (
              <div className="grid grid-cols-2 gap-2">
                <Field label="Groups from">
                  <Select
                    aria-label="Groups from"
                    value={str(per.in)}
                    onChange={(id) => set({ per: { in: id, key: '' } })}
                    options={nodes}
                  />
                </Field>
                <Field label="Group key">
                  <FieldSelect
                    record={typeOf(per.in)}
                    value={str(per.key)}
                    onChange={(key) => set({ per: { ...per, key } })}
                  />
                </Field>
              </div>
            )}
            {(per || keyed) && (
              <Switch
                label="Remove edges per group"
                description="Each group's own removed edges are taken out before checking."
                checked={remove !== undefined}
                onChange={(on) =>
                  set({ remove: on ? { in: '', key: '', from: '', to: '' } : undefined })
                }
              />
            )}
            {(per || keyed) && remove && (
              <div className="insp-case space-y-3">
                <Field label="Removed edges from">
                  <Select
                    aria-label="Removed edges from"
                    value={str(remove.in)}
                    onChange={(id) => set({ remove: { in: id, key: '', from: '', to: '' } })}
                    options={nodes}
                  />
                </Field>
                <div className="grid grid-cols-3 gap-1.5">
                  {(['key', 'from', 'to'] as const).map((k) => (
                    <Field key={k} label={k === 'key' ? 'Group key' : k === 'from' ? 'From' : 'To'}>
                      <FieldSelect
                        record={typeOf(remove.in)}
                        value={str(remove[k])}
                        aria-label={`Removed edge ${k}`}
                        placeholder="Field"
                        onChange={(v) => set({ remove: { ...remove, [k]: v } })}
                      />
                    </Field>
                  ))}
                </div>
                <Switch
                  label="Only some removed edges"
                  checked={remove.where !== undefined}
                  onChange={(on) => {
                    const { where: _w, ...rest } = remove
                    set({
                      remove: on ? { ...rest, where: starterCondition(typeOf(remove.in)) } : rest,
                    })
                  }}
                />
                {remove.where !== undefined && (
                  <ConditionEditor
                    value={remove.where}
                    record={typeOf(remove.in)}
                    onChange={(where) => set({ remove: { ...remove, where: where ?? {} } })}
                  />
                )}
              </div>
            )}
          </>
        )}
      </Group>
      <Group title="Outcome">
        <OnFail
          check={check}
          value={params.on_fail}
          record={record}
          onChange={(on_fail) => set({ on_fail })}
        />
      </Group>
    </>
  )
}
