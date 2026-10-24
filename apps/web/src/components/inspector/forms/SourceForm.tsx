import { type MType, sourceRecordType, t, updateNode } from '@hockeymask/core'
import { useSources, useTables } from '../../../api'
import { formatCount, shortTableName } from '../../../format'
import { Select } from '../../Select'
import { ConditionEditor, starterCondition } from '../ConditionEditor'
import { paramsOf, str, useInspector } from '../context'
import { Field, Group, Switch, TypeChip } from '../controls'

/** Pick the table; the record type comes from its schema, re-read whenever the table changes. */
export function SourceForm() {
  const { version, node, onChange } = useInspector()
  const system = str(node.system)
  const sources = useSources()
  const tables = useTables(system || undefined)
  const schema = version.expectedSchema[node.id]
  const declared = schema ? sourceRecordType(schema) : undefined
  const record = declared?.ok ? declared.value : t.record({})
  const fields = Object.entries(record.fields)

  const set = (patch: Record<string, unknown>, dropSchema: boolean) => {
    const next = { ...paramsOf(node), ...patch }
    for (const [k, v] of Object.entries(patch)) if (v === undefined) delete next[k]
    const updated = updateNode(version, node.id, { params: next })
    if (!dropSchema) return onChange(updated)
    // A different table means a different record type: drop the schema so it is re-read.
    const { [node.id]: _dropped, ...rest } = updated.expectedSchema
    onChange({ ...updated, expectedSchema: rest })
  }

  return (
    <>
      <Group title="Table">
        <Field label="System">
          <Select
            aria-label="System"
            value={system}
            onChange={(value) => set({ system: value, entity: '' }, true)}
            options={(sources.data ?? []).map((s) => ({ value: s.key, label: s.system }))}
          />
        </Field>
        <Field label="Table">
          <Select
            aria-label="Table"
            mono
            value={str(node.entity)}
            disabled={!system}
            placeholder={system ? 'Choose a table' : 'Choose a system first'}
            onChange={(value) => set({ entity: value }, true)}
            options={(tables.data ?? []).map((tbl) => ({
              value: tbl.name,
              label: shortTableName(tbl.name),
              hint: formatCount(tbl.rowCount),
            }))}
          />
        </Field>
      </Group>
      <Group title="Rows">
        <Switch
          label="Only some rows"
          description="Read the rows that match a condition; the rest never enter the mapping."
          checked={node.filter !== undefined}
          onChange={(on) => set({ filter: on ? starterCondition(record) : undefined }, false)}
        />
        {node.filter !== undefined && (
          <ConditionEditor
            value={node.filter}
            record={record}
            onChange={(filter) => set({ filter }, false)}
          />
        )}
      </Group>
      <Group title="Fields" aside={fields.length ? `${fields.length}` : undefined}>
        {fields.length === 0 ? (
          <p className="text-[12px] text-faint">
            {str(node.entity) ? 'Reading the table schema…' : 'Choose a table to see its fields.'}
          </p>
        ) : (
          <ul className="insp-schema">
            {fields.map(([name, type]) => (
              <li key={name}>
                <span className="truncate font-mono">{name}</span>
                <TypeChip type={type as MType} />
              </li>
            ))}
          </ul>
        )}
      </Group>
    </>
  )
}
