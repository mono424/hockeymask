import { type MType, t } from '@hockeymask/core'
import { X } from 'lucide-react'
import { ConditionEditor, starterCondition } from '../ConditionEditor'
import {
  nodeName,
  record as asRecord,
  str,
  useInputType,
  useInspector,
  useParams,
} from '../context'
import {
  AddRow,
  Field,
  FieldSelect,
  Group,
  IconButton,
  Note,
  Segmented,
  Switch,
  TextInput,
} from '../controls'

type JoinType = 'inner' | 'left' | 'semi' | 'anti'
type Cardinality = '1:1' | 'n:1' | '1:n' | 'n:m'

const TYPES: Record<JoinType, string> = {
  inner: 'One record per match; records without a match are dropped.',
  left: 'Every left record, with the right fields empty where nothing matches.',
  semi: 'Left records that have at least one match. No right fields are added.',
  anti: 'Left records that have no match. No right fields are added.',
}

const CARDINALITY: Record<Cardinality, string> = {
  '1:1': 'At most one match per record on both sides.',
  'n:1': 'Each left record matches at most one right record, as in a lookup.',
  '1:n': 'Each right record matches at most one left record.',
  'n:m': 'Unrestricted. Needs a count check on this step to catch runaway fan-out.',
}

const pairs = (v: unknown): [string, string][] =>
  Array.isArray(v)
    ? v.map((p) => (Array.isArray(p) ? [String(p[0] ?? ''), String(p[1] ?? '')] : ['', '']))
    : []

/** Combine two inputs on matching keys, with a declared and enforced cardinality. */
export function JoinForm() {
  const { version, node, onChange } = useInspector()
  const { params, set } = useParams()
  const left = useInputType('left')
  const right = useInputType('right')
  const type = (str(params.type) || 'inner') as JoinType
  const cardinality = (str(params.cardinality) || undefined) as Cardinality | undefined
  const on = pairs(params.on)
  const select =
    params.select === undefined ? undefined : (asRecord(params.select) as Record<string, string>)
  const adds = type === 'inner' || type === 'left'
  const rightFields = Object.keys(right.fields)
  const carried: Record<string, MType> = {}
  for (const name of rightFields) {
    const to = select ? select[name] : name
    if (to) carried[to] = right.fields[name] as MType
  }
  const merged = t.record({ ...carried, ...left.fields })
  const counted = version.expect[node.id]?.count !== undefined

  return (
    <>
      <Group title="Inputs">
        <div className="grid grid-cols-2 gap-2">
          {(['left', 'right'] as const).map((side) => {
            const id = str(params[side])
            const fields = Object.keys((side === 'left' ? left : right).fields).length
            return (
              <div key={side} className="insp-side">
                <span className="text-[11.5px] text-faint">
                  {side === 'left' ? 'Left' : 'Right'}
                </span>
                <span className="truncate text-[12.5px] text-fg">
                  {id ? nodeName(version, id) : 'Not connected'}
                </span>
                <span className="text-[11px] text-faint">
                  {id ? `${fields} fields` : 'Connect on the canvas'}
                </span>
              </div>
            )
          })}
        </div>
      </Group>
      <Group title="Match">
        <Field label="Keep" hint={TYPES[type]}>
          <Segmented<JoinType>
            aria-label="Join type"
            value={type}
            onChange={(v) => set({ type: v === 'inner' ? undefined : v })}
            options={[
              { value: 'inner', label: 'Matches' },
              { value: 'left', label: 'All left' },
              { value: 'semi', label: 'With match' },
              { value: 'anti', label: 'Without' },
            ]}
          />
        </Field>
        <Field label="Matching keys">
          <div className="space-y-1.5">
            {on.map(([l, r], i) => (
              <div key={i} className="grid grid-cols-[1fr_auto_1fr_auto] items-center gap-1.5">
                <FieldSelect
                  record={left}
                  value={l}
                  aria-label="Left key"
                  placeholder="Left field"
                  onChange={(v) => set({ on: on.map((p, j) => (j === i ? [v, p[1]] : p)) })}
                />
                <span className="text-faint">=</span>
                <FieldSelect
                  record={right}
                  value={r}
                  aria-label="Right key"
                  placeholder="Right field"
                  onChange={(v) => set({ on: on.map((p, j) => (j === i ? [p[0], v] : p)) })}
                />
                <IconButton
                  label="Remove key"
                  tone="danger"
                  onClick={() => set({ on: on.filter((_, j) => j !== i) })}
                >
                  <X size={13} strokeWidth={1.75} />
                </IconButton>
              </div>
            ))}
            <AddRow onClick={() => set({ on: [...on, ['', '']] })}>Add key pair</AddRow>
          </div>
        </Field>
        <Field
          label="Matches per record"
          hint={
            cardinality
              ? CARDINALITY[cardinality]
              : 'Declare how many matches to expect; the run checks it.'
          }
        >
          <Segmented<Cardinality>
            aria-label="Cardinality"
            value={cardinality}
            onChange={(v) => set({ cardinality: v })}
            options={[
              { value: 'n:1', label: 'n : 1', title: 'Many to one' },
              { value: '1:1', label: '1 : 1', title: 'One to one' },
              { value: '1:n', label: '1 : n', title: 'One to many' },
              { value: 'n:m', label: 'n : m', title: 'Many to many' },
            ]}
          />
        </Field>
        {cardinality === 'n:m' && !counted && (
          <Note tone="warn">
            Many-to-many needs a count check.{' '}
            <button
              type="button"
              className="underline decoration-dotted underline-offset-2 hover:text-fg"
              onClick={() =>
                onChange({
                  ...version,
                  expect: {
                    ...version.expect,
                    [node.id]: {
                      ...version.expect[node.id],
                      count: { shiftRatio: { min: 0.8, max: 1.2 } },
                    },
                  },
                })
              }
            >
              Add one
            </button>{' '}
            (alerts when the count moves more than 20% between runs).
          </Note>
        )}
      </Group>
      {adds && (
        <Group title="Right fields to add">
          <Switch
            label="All right fields"
            description="Keys with the same name on both sides merge."
            checked={select === undefined}
            onChange={(all) => set({ select: all ? undefined : {} })}
          />
          {select !== undefined && (
            <ul className="space-y-1">
              {rightFields.map((name) => {
                const on = name in select
                return (
                  <li key={name} className="grid grid-cols-[auto_1fr_1fr] items-center gap-2">
                    <input
                      type="checkbox"
                      className="insp-check"
                      aria-label={`Add ${name}`}
                      checked={on}
                      onChange={(e) => {
                        const next = { ...select }
                        if (e.target.checked) next[name] = name
                        else delete next[name]
                        set({ select: next })
                      }}
                    />
                    <span
                      className={`truncate font-mono text-[12.5px] ${on ? 'text-fg' : 'text-faint'}`}
                    >
                      {name}
                    </span>
                    {on ? (
                      <TextInput
                        mono
                        aria-label={`Name for ${name}`}
                        value={select[name] ?? ''}
                        onChange={(to) => set({ select: { ...select, [name]: to } })}
                      />
                    ) : (
                      <span />
                    )}
                  </li>
                )
              })}
              {rightFields.length === 0 && (
                <Note>Connect the right input to choose its fields.</Note>
              )}
            </ul>
          )}
        </Group>
      )}
      <Group title="More">
        <Switch
          label="Extra match condition"
          description="Compared on the combined record, as part of the match."
          checked={params.where !== undefined}
          onChange={(on) => set({ where: on ? starterCondition(merged) : undefined })}
        />
        {params.where !== undefined && (
          <ConditionEditor
            value={params.where}
            record={merged}
            onChange={(where) => set({ where: where ?? {} })}
          />
        )}
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
