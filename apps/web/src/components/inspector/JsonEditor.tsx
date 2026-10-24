import { catalogEntry } from '@hockeymask/react'
import { useRef, useState } from 'react'
import { paramsOf, useInspector } from './context'

/**
 * The node's settings as JSON. Input references (`in`, `left`, `right`, `inputs`) stay out:
 * edges are drawn on the canvas. Valid JSON applies as you type; invalid JSON is held back.
 */
export function JsonEditor() {
  const { version, node, onChange } = useInspector()
  const refs = new Set(
    catalogEntry(node.op)
      ?.slots.filter((s) => s.path.length === 1)
      .map((s) => s.path[0] as string) ?? [],
  )
  const params = paramsOf(node)
  const editable = Object.fromEntries(Object.entries(params).filter(([k]) => !refs.has(k)))
  const [draft, setDraft] = useState(() => JSON.stringify(editable, null, 2))
  const [error, setError] = useState<string | null>(null)
  const gutter = useRef<HTMLDivElement>(null)
  const lines = draft.split('\n').length

  const apply = (text: string) => {
    setDraft(text)
    try {
      const value: unknown = JSON.parse(text)
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        setError('Settings are a JSON object: { … }')
        return
      }
      const kept = Object.fromEntries(Object.entries(params).filter(([k]) => refs.has(k)))
      setError(null)
      onChange({
        ...version,
        nodes: version.nodes.map((n) =>
          n.id === node.id
            ? {
                ...(value as object),
                ...kept,
                id: n.id,
                op: n.op,
                ...(n.label ? { label: n.label } : {}),
              }
            : n,
        ),
      })
    } catch (e) {
      setError((e as Error).message.replace(/^JSON\.parse: /, ''))
    }
  }

  return (
    <div className="insp-json">
      <div className="flex items-center justify-between pb-2">
        <span className="text-[11.5px] text-faint">Connections are edited on the canvas.</span>
        <button
          type="button"
          className="text-[11.5px] text-muted hover:text-fg"
          disabled={error !== null}
          onClick={() => apply(JSON.stringify(JSON.parse(draft), null, 2))}
        >
          Format
        </button>
      </div>
      <div className={`insp-json-box ${error ? 'is-invalid' : ''}`}>
        <div ref={gutter} className="insp-json-gutter" aria-hidden>
          {Array.from({ length: lines }, (_, i) => (
            <span key={i}>{i + 1}</span>
          ))}
        </div>
        <textarea
          aria-label="Settings as JSON"
          spellCheck={false}
          value={draft}
          onChange={(e) => apply(e.target.value)}
          onScroll={(e) => {
            if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Tab') return
            e.preventDefault()
            const el = e.currentTarget
            const { selectionStart: s, selectionEnd: end } = el
            const next = `${draft.slice(0, s)}  ${draft.slice(end)}`
            apply(next)
            requestAnimationFrame(() => el.setSelectionRange(s + 2, s + 2))
          }}
        />
      </div>
      <p className={`mt-2 text-[11.5px] ${error ? 'text-down' : 'text-faint'}`}>
        {error ? `Not applied: ${error}` : 'Applied as you type.'}
      </p>
    </div>
  )
}
