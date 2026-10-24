import { useState } from 'react'
import { nodeName, str, strings, useInspector, useParams } from '../context'
import { Field, Group, Note, TextInput } from '../controls'

/** Reviewed code with a declared output schema; the escape hatch for what nodes can't say. */
export function TransformForm() {
  const { version, node } = useInspector()
  const { params, set } = useParams()
  const [draft, setDraft] = useState(() => JSON.stringify(params.schema ?? {}, null, 2))
  const [invalid, setInvalid] = useState(false)
  const inputs = strings(node.inputs)
  return (
    <>
      <Group title="Code">
        <Field label="Transform" hint="The name the host registered the reviewed function under.">
          <TextInput
            mono
            aria-label="Transform"
            value={str(params.ref)}
            placeholder="routing.special_case@2"
            onChange={(ref) => set({ ref })}
          />
        </Field>
        <Field label="Inputs">
          {inputs.length ? (
            <ul className="insp-inputs">
              {inputs.map((id) => (
                <li key={id}>
                  <span className="truncate">{nodeName(version, id)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <Note>Connect inputs on the canvas.</Note>
          )}
        </Field>
      </Group>
      <Group title="Output schema">
        <Field
          label="JSON Schema of one output record"
          hint="Keeps the rest of the graph type-checked."
        >
          <textarea
            className={`insp-code h-44 ${invalid ? 'is-invalid' : ''}`}
            spellCheck={false}
            aria-label="Output schema"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value)
              try {
                const value: unknown = JSON.parse(e.target.value)
                if (typeof value !== 'object' || value === null || Array.isArray(value))
                  throw new Error()
                setInvalid(false)
                set({ schema: value })
              } catch {
                setInvalid(true)
              }
            }}
          />
        </Field>
        {invalid && (
          <p className="text-[11.5px] text-down">
            Not a JSON object yet; the last valid schema is kept.
          </p>
        )}
      </Group>
    </>
  )
}
