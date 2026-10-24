import { useAui, useAuiState } from '@assistant-ui/react'
import { ArrowUp, Sparkles } from 'lucide-react'
import { type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from 'react'

/** Typed out in the empty box, one after another: mappings to create, things to explain. */
const EXAMPLES = [
  'Map their locations to warehouses',
  'Explain what this mapping does',
  'Create a mapping from their vendors to suppliers',
  'Explain the selected step',
  'Create a mapping for supplier lead times',
  'Explain why the testbench drops rows',
]

const MAX_HEIGHT = 168

const reducedMotion = () =>
  globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false

interface Typing {
  index: number
  length: number
  erasing: boolean
}

/** The typing loop's next state for an example of `full` characters, and the wait before it. */
function step(t: Typing, full: number, instant: boolean): [number, Typing] {
  if (!t.erasing && t.length < full)
    return [instant ? 0 : 28 + Math.random() * 40, { ...t, length: instant ? full : t.length + 1 }]
  if (!t.erasing) return [instant ? 3500 : 2200, { ...t, erasing: true }]
  if (t.length > 0 && !instant) return [14, { ...t, length: t.length - 1 }]
  return [instant ? 0 : 420, { index: t.index + 1, length: 0, erasing: false }]
}

/**
 * The example currently shown, typed character by character, held, then erased. Stops where
 * it is while `paused`; with reduced motion each example appears whole.
 */
function useTypedExample(paused: boolean): string {
  const [typing, setTyping] = useState<Typing>({ index: 0, length: 0, erasing: false })
  const [instant] = useState(reducedMotion)
  const full = EXAMPLES[typing.index % EXAMPLES.length] ?? ''

  useEffect(() => {
    if (paused) return
    const [delay, next] = step(typing, full.length, instant)
    const timer = setTimeout(() => setTyping(next), delay)
    return () => clearTimeout(timer)
  }, [paused, instant, full, typing])

  return full.slice(0, typing.length)
}

/**
 * The frosted input at the bottom of the canvas. What is typed goes to the agent: the panel
 * opens and the message is sent there. Slides away while the panel is open, as the panel has
 * its own composer.
 */
export function PromptBar({
  hidden,
  style,
  onOpenAgent,
}: {
  hidden: boolean
  style?: CSSProperties
  onOpenAgent: () => void
}) {
  const aui = useAui()
  const running = useAuiState((s) => s.thread.isRunning)
  const [text, setText] = useState('')
  const field = useRef<HTMLTextAreaElement>(null)
  const example = useTypedExample(hidden || text !== '')
  const canSend = text.trim() !== '' && !running

  // Grow with the text up to a few lines, then scroll.
  useLayoutEffect(() => {
    const el = field.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`
    el.style.overflowY = el.scrollHeight > MAX_HEIGHT ? 'auto' : 'hidden'
  }, [text])

  const send = () => {
    if (!canSend) return
    onOpenAgent()
    aui.thread.append(text.trim())
    setText('')
  }

  return (
    <div
      className={`prompt-dock inset-motion ${hidden ? 'is-hidden' : ''}`}
      style={style}
      inert={hidden}
    >
      <form
        className="prompt-glass"
        onSubmit={(e) => {
          e.preventDefault()
          send()
        }}
      >
        <div className="flex gap-3 px-4 pt-4">
          <Sparkles size={16} strokeWidth={1.5} className="mt-[3px] shrink-0 text-muted" />
          <div className="relative min-w-0 flex-1">
            {text === '' && (
              <div
                aria-hidden
                className="pointer-events-none absolute inset-x-0 top-0 truncate text-[14px] leading-[1.6] text-faint"
              >
                {example}
                <span className="prompt-caret" />
              </div>
            )}
            <textarea
              ref={field}
              rows={2}
              value={text}
              aria-label="Ask the agent, or describe a mapping for it to build"
              className="block w-full resize-none bg-transparent text-[14px] leading-[1.6] text-fg outline-none"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return
                e.preventDefault()
                send()
              }}
            />
          </div>
        </div>
        <div className="flex items-center justify-between gap-3 pt-1.5 pr-3 pb-3 pl-11">
          <span className="truncate text-[11.5px] text-faint">
            Create a mapping, or have one explained
          </span>
          <button
            type="submit"
            aria-label="Send to the agent"
            disabled={!canSend}
            className="grid size-8 shrink-0 place-items-center rounded-full bg-fg text-frame transition-opacity hover:bg-white disabled:opacity-25"
          >
            <ArrowUp size={16} strokeWidth={2} />
          </button>
        </div>
      </form>
    </div>
  )
}
