import { disconnect, show } from '@hockeymask/core'
import { X } from 'lucide-react'
import { nodeName, strings, useInspector } from '../context'
import { Group, IconButton, Note } from '../controls'

/** All records of several inputs with the same fields; duplicates collapse. */
export function UnionForm() {
  const { version, node, types, onChange } = useInspector()
  const inputs = strings(node.inputs)
  const shapes = inputs.map((id) =>
    types[id] ? Object.keys(types[id].fields).sort().join(', ') : null,
  )
  const known = shapes.filter((s): s is string => s !== null)
  const mismatch = new Set(known).size > 1
  return (
    <Group title="Inputs" aside={inputs.length || undefined}>
      {inputs.length === 0 ? (
        <Note>Connect two or more steps with the same fields on the canvas.</Note>
      ) : (
        <ul className="insp-inputs">
          {inputs.map((id) => (
            <li key={id}>
              <span className="truncate">{nodeName(version, id)}</span>
              <span className="ml-auto truncate font-mono text-[11px] text-faint">
                {types[id] ? `${Object.keys(types[id].fields).length} fields` : 'not ready'}
              </span>
              <IconButton
                label={`Disconnect ${nodeName(version, id)}`}
                tone="danger"
                onClick={() =>
                  onChange(disconnect(version, { source: id, target: node.id, slot: 'inputs' }))
                }
              >
                <X size={13} strokeWidth={1.75} />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
      {mismatch && (
        <Note tone="warn">
          Inputs have different fields. Map them to the same fields first, e.g.{' '}
          {inputs[0] && types[inputs[0]] ? show(types[inputs[0]]) : ''}.
        </Note>
      )}
      {inputs.length === 1 && <Note>Connect at least one more input on the canvas.</Note>}
    </Group>
  )
}
