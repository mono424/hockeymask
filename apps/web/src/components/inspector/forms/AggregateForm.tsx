import { X } from 'lucide-react'
import { Select } from '../../Select'
import { ConditionEditor, starterCondition } from '../ConditionEditor'
import { record as asRecord, str, strings, useInputType, useParams } from '../context'
import {
  AddRow,
  Field,
  FieldChips,
  FieldSelect,
  Group,
  IconButton,
  Switch,
  TextInput,
} from '../controls'

const FUNCTIONS = [
  { value: 'count', label: 'Count rows' },
  { value: 'count_distinct', label: 'Count distinct' },
  { value: 'sum', label: 'Sum' },
  { value: 'min', label: 'Smallest' },
  { value: 'max', label: 'Largest' },
  { value: 'collect_set', label: 'Set of values' },
  { value: 'collect_list', label: 'List of values' },
  { value: 'first', label: 'First' },
  { value: 'last', label: 'Last' },
  { value: 'any', label: 'Any row matches' },
  { value: 'all', label: 'All rows match' },
]

const NEEDS_PATH = new Set([
  'count_distinct',
  'sum',
  'min',
  'max',
  'collect_set',
  'collect_list',
  'first',
  'last',
])
const NEEDS_ORDER = new Set(['collect_list', 'first', 'last'])
const NEEDS_COND = new Set(['any', 'all'])

type Spec = Record<string, unknown> & { agg?: string }

/** Re-shape a spec for a new function: keep what still applies, add what is required. */
function reshape(spec: Spec, agg: string, firstField: string): Spec {
  const next: Spec = { agg }
  if (NEEDS_PATH.has(agg)) next.path = typeof spec.path === 'string' ? spec.path : firstField
  if (NEEDS_ORDER.has(agg))
    next.order_by = Array.isArray(spec.order_by) ? spec.order_by : [firstField]
  if (NEEDS_COND.has(agg)) next.cond = spec.cond ?? {}
  if (spec.where !== undefined) next.where = spec.where
  return next
}

/** One record per group, with counts, sums, sets and other aggregates. */
export function AggregateForm() {
  const { params, set } = useParams()
  const record = useInputType()
  const groupBy = strings(params.group_by)
  const fields = Object.entries(asRecord(params.fields)) as [string, Spec][]
  const firstField = Object.keys(record.fields)[0] ?? ''
  const setFields = (entries: [string, Spec][]) => set({ fields: Object.fromEntries(entries) })

  return (
    <>
      <Group title="Group by">
        <FieldChips
          record={record}
          values={groupBy}
          onChange={(group_by) => set({ group_by })}
          placeholder="Add a group field"
        />
        {groupBy.length === 0 && (
          <p className="text-[11.5px] text-faint">
            No group fields: one record for the whole input.
          </p>
        )}
      </Group>
      <Group title="Aggregates" aside={fields.length || undefined}>
        <div className="space-y-2">
          {fields.map(([name, spec], i) => {
            const agg = str(spec.agg) || 'count'
            const update = (patch: Spec) =>
              setFields(fields.map((e, j) => (j === i ? [e[0], { ...e[1], ...patch }] : e)))
            const order = Array.isArray(spec.order_by) ? spec.order_by : []
            const orderField =
              typeof order[0] === 'string' ? order[0] : str(asRecord(order[0]).path)
            const desc = typeof order[0] === 'object' && asRecord(order[0]).desc === true
            return (
              <div key={i} className="insp-fieldcard is-open">
                <div className="grid grid-cols-[1fr_1fr_auto] items-center gap-1.5">
                  <TextInput
                    mono
                    aria-label="Output name"
                    value={name}
                    invalid={!name || groupBy.includes(name)}
                    onChange={(to) => setFields(fields.map((e, j) => (j === i ? [to, e[1]] : e)))}
                  />
                  <Select
                    aria-label="Function"
                    value={agg}
                    onChange={(v) =>
                      setFields(
                        fields.map((e, j) => (j === i ? [e[0], reshape(e[1], v, firstField)] : e)),
                      )
                    }
                    options={FUNCTIONS}
                  />
                  <IconButton
                    label={`Remove ${name}`}
                    tone="danger"
                    onClick={() => setFields(fields.filter((_, j) => j !== i))}
                  >
                    <X size={13} strokeWidth={1.75} />
                  </IconButton>
                </div>
                <div className="mt-3 space-y-3">
                  {NEEDS_PATH.has(agg) && (
                    <Field label="Of field">
                      <FieldSelect
                        record={record}
                        value={str(spec.path)}
                        onChange={(path) => update({ path })}
                      />
                    </Field>
                  )}
                  {NEEDS_ORDER.has(agg) && (
                    <Field label="Ordered by">
                      <div className="grid grid-cols-[1fr_auto] items-center gap-1.5">
                        <FieldSelect
                          record={record}
                          value={orderField}
                          onChange={(path) =>
                            update({ order_by: [desc ? { path, desc: true } : path] })
                          }
                        />
                        <Switch
                          label="Desc"
                          checked={desc}
                          onChange={(d) =>
                            update({
                              order_by: [d ? { path: orderField, desc: true } : orderField],
                            })
                          }
                        />
                      </div>
                    </Field>
                  )}
                  {NEEDS_COND.has(agg) && (
                    <Field label="Condition">
                      <ConditionEditor
                        value={spec.cond}
                        record={record}
                        onChange={(cond) => update({ cond: cond ?? {} })}
                      />
                    </Field>
                  )}
                  <Switch
                    label="Only rows where…"
                    checked={spec.where !== undefined}
                    onChange={(on) => {
                      const { where: _w, ...rest } = spec
                      setFields(
                        fields.map((e, j) =>
                          j === i
                            ? [e[0], on ? { ...rest, where: starterCondition(record) } : rest]
                            : e,
                        ),
                      )
                    }}
                  />
                  {spec.where !== undefined && (
                    <ConditionEditor
                      value={spec.where}
                      record={record}
                      onChange={(where) => update({ where: where ?? {} })}
                    />
                  )}
                </div>
              </div>
            )
          })}
        </div>
        <AddRow
          onClick={() => {
            let n = fields.length ? fields.length + 1 : 0
            const names = fields.map(([k]) => k)
            let name = n ? `count_${n}` : 'count'
            while (names.includes(name)) name = `count_${++n}`
            setFields([...fields, [name, { agg: 'count' }]])
          }}
        >
          Add aggregate
        </AddRow>
      </Group>
      <Group title="More">
        <Switch
          label="Tolerate skipped records"
          description="Accept that a step upstream may drop records whose fields failed."
          checked={params.tolerate_skips === true}
          onChange={(on) => set({ tolerate_skips: on || undefined })}
        />
      </Group>
    </>
  )
}
