import {
  type CompileIssue,
  type MappingVersion,
  type NodeJson,
  removeNode,
  updateNode,
} from '@hockeymask/core'
import { catalogEntry, nodeTitle } from '@hockeymask/react'
import { CircleAlert, Trash2, X } from 'lucide-react'
import { useTargetSchema } from '../../api'
import { NodeIcon } from '../icons'
import { type Inspector, InspectorContext, useTypes } from './context'
import { Segmented } from './controls'
import { FORMS } from './forms'
import { JsonEditor } from './JsonEditor'

export type InspectorMode = 'form' | 'json'

function Issues({ issues }: { issues: readonly CompileIssue[] }) {
  if (issues.length === 0) return null
  return (
    <div className="insp-issues" role="status">
      <p className="flex items-center gap-1.5 text-[12px] font-medium text-down">
        <CircleAlert size={13} strokeWidth={1.75} />
        {issues.length === 1 ? '1 problem' : `${issues.length} problems`}
      </p>
      <ul className="mt-1.5 space-y-1">
        {issues.map((issue, i) => (
          <li key={`${issue.code}-${i}`} className="text-[12px] leading-snug text-fg/85">
            {issue.field && !issue.message.startsWith(issue.field) && (
              <span className="mr-1 font-mono text-[11.5px] text-muted">
                {issue.field}
                {issue.step !== undefined ? ` · step ${issue.step + 1}` : ''}
              </span>
            )}
            {issue.message}
          </li>
        ))}
      </ul>
    </div>
  )
}

/** The selected step: what it is, its settings as controls or JSON, and its problems. */
export function NodeInspector({
  version,
  node,
  issues,
  mode,
  onMode,
  onChange,
  onClose,
}: {
  version: MappingVersion
  node: NodeJson
  issues: readonly CompileIssue[]
  mode: InspectorMode
  onMode: (mode: InspectorMode) => void
  onChange: (version: MappingVersion) => void
  onClose: () => void
}) {
  const entry = catalogEntry(node.op)
  const targets = useTargetSchema().data
  const types = useTypes(version, targets)
  const own = issues.filter((i) => i.node === node.id)
  const Form = FORMS[node.op]
  const context: Inspector = { version, node, types, targets, onChange }

  return (
    <InspectorContext value={context}>
      <header className="insp-head">
        <div className="flex items-start gap-3">
          <span className={`insp-tile insp-tile--${entry?.category ?? 'transform'}`}>
            <NodeIcon op={node.op} size={15} />
          </span>
          <div className="min-w-0 flex-1">
            <input
              className="insp-title"
              aria-label="Step name"
              value={node.label ?? ''}
              placeholder={nodeTitle({ ...node, label: undefined })}
              spellCheck={false}
              onChange={(e) =>
                onChange(updateNode(version, node.id, { label: e.target.value || undefined }))
              }
            />
            <p className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-muted">
              {entry?.description ?? 'Unknown step type.'}
            </p>
          </div>
          <button type="button" aria-label="Close" className="insp-close" onClick={onClose}>
            <X size={15} strokeWidth={1.5} />
          </button>
        </div>
        <div className="mt-3 flex items-center gap-2">
          <Segmented<InspectorMode>
            size="sm"
            aria-label="Edit as"
            value={mode}
            onChange={onMode}
            options={[
              { value: 'form', label: 'Settings' },
              { value: 'json', label: 'JSON' },
            ]}
          />
          <span className="ml-auto truncate font-mono text-[11px] text-faint" title="Step id">
            {node.id}
          </span>
        </div>
      </header>
      <div key={`${node.id}:${mode}`} className="insp-body">
        <Issues issues={own} />
        {mode === 'json' || !Form ? <JsonEditor /> : <Form />}
      </div>
      <footer className="insp-foot">
        <button
          type="button"
          className="insp-remove"
          onClick={() => {
            const next = removeNode(version, node.id)
            const { [node.id]: _dropped, ...rest } = next.expectedSchema
            onChange({ ...next, expectedSchema: rest })
          }}
        >
          <Trash2 size={13} strokeWidth={1.75} />
          Remove step
        </button>
      </footer>
    </InspectorContext>
  )
}
