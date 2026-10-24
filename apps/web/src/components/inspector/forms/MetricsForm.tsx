import { type MType, t } from '@hockeymask/core'
import { str, strings, useInputType, useParams } from '../context'
import { Field, FieldChips, Group, Note, TextInput, TypeChip } from '../controls'

/** Report a small relation on the sync run; never held back by checks. */
export function MetricsForm() {
  const { params, set } = useParams()
  const record = useInputType()
  const countBy = strings(params.count_by)
  // With count_by the run reports one row per group and its number of rows.
  const fields: [string, MType | undefined][] = countBy.length
    ? [
        ...countBy.map((f): [string, MType | undefined] => [f, record.fields[f]]),
        ['rows', t.number],
      ]
    : Object.entries(record.fields)
  return (
    <Group title="Report">
      <Field label="Metric name" hint="Shown on every sync run, also when the run is stopped.">
        <TextInput
          mono
          aria-label="Metric name"
          value={str(params.name)}
          placeholder="plc.kind_counts"
          onChange={(name) => set({ name })}
        />
      </Field>
      <Field
        label="Count rows by"
        hint="Report how many rows each combination of these fields has, instead of the rows."
      >
        <FieldChips
          record={record}
          values={countBy}
          onChange={(next) => set({ count_by: next.length ? next : undefined })}
          placeholder="Add a field to count by"
        />
      </Field>
      {fields.length > 0 ? (
        <Field label="Columns">
          <ul className="insp-schema">
            {fields.map(([name, type]) => (
              <li key={name}>
                <span className="truncate font-mono">{name}</span>
                <TypeChip type={type} />
              </li>
            ))}
          </ul>
        </Field>
      ) : (
        <Note>Connect the rows to report, or count them by a field.</Note>
      )}
    </Group>
  )
}
