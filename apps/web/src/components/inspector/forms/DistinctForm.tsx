import { strings, useInputType, useParams } from '../context'
import { FieldChips, Group, Note } from '../controls'

/** One record per distinct combination of the key fields; the output has just those fields. */
export function DistinctForm() {
  const { params, set } = useParams()
  const record = useInputType()
  return (
    <Group title="Distinct on">
      <FieldChips
        record={record}
        values={strings(params.keys)}
        onChange={(keys) => set({ keys })}
      />
      <Note>The output keeps only these fields, one record per combination.</Note>
    </Group>
  )
}
