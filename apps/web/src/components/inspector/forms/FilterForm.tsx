import { ConditionEditor } from '../ConditionEditor'
import { useInputType, useParams } from '../context'
import { Group, Note } from '../controls'

/** Keep the records where a condition holds. */
export function FilterForm() {
  const { params, set } = useParams()
  const record = useInputType()
  return (
    <Group title="Keep records where">
      <ConditionEditor
        value={params.cond}
        record={record}
        onChange={(cond) => set({ cond: cond ?? {} })}
      />
      <Note>
        A condition "is not empty" on a field also makes that field non-empty for the steps after
        this one.
      </Note>
    </Group>
  )
}
