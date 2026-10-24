/**
 * Form controls of the node inspector. Quiet by default, like the rest of the app: hairline
 * borders, 13px text, mono for anything that is a field name or a value from the data.
 */

import { type MType, type RecordType, show, stripNull } from '@hockeymask/core'
import { Plus, X } from 'lucide-react'
import { type ReactNode, useId, useState } from 'react'
import { Select, type SelectOption } from '../Select'

/** One labelled control. `aside` sits right of the label (a type, a switch, a count). */
export function Field({
  label,
  hint,
  aside,
  children,
}: {
  label: ReactNode
  hint?: ReactNode
  aside?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="insp-field">
      <div className="flex min-h-5 items-center gap-2">
        <span className="text-[12px] font-medium text-muted">{label}</span>
        {aside !== undefined && <span className="ml-auto flex items-center">{aside}</span>}
      </div>
      <div className="mt-1.5">{children}</div>
      {hint && <p className="mt-1.5 text-[11.5px] leading-snug text-faint">{hint}</p>}
    </div>
  )
}

/** A titled group of fields, separated from the previous one by a hairline. */
export function Group({
  title,
  aside,
  children,
}: {
  title: ReactNode
  aside?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="insp-group">
      <header className="mb-3 flex min-h-5 items-center gap-2">
        <h3 className="text-[12.5px] font-semibold tracking-[-0.01em] text-fg">{title}</h3>
        {aside !== undefined && (
          <span className="ml-auto flex items-center gap-1 text-[11.5px] text-faint">{aside}</span>
        )}
      </header>
      <div className="space-y-3.5">{children}</div>
    </section>
  )
}

export function TextInput({
  value,
  onChange,
  placeholder,
  mono = false,
  invalid = false,
  'aria-label': ariaLabel,
}: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  mono?: boolean
  invalid?: boolean
  'aria-label'?: string
}) {
  return (
    <input
      className={`insp-input ${mono ? 'font-mono text-[12.5px]' : ''} ${invalid ? 'is-invalid' : ''}`}
      value={value}
      placeholder={placeholder}
      aria-label={ariaLabel}
      spellCheck={false}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}

/**
 * A number field that keeps what is typed while it is not a number yet ("-", "1.") and
 * reports `undefined` when cleared.
 */
export function NumberInput({
  value,
  onChange,
  placeholder,
  integer = false,
  'aria-label': ariaLabel,
}: {
  value: number | undefined
  onChange: (value: number | undefined) => void
  placeholder?: string
  integer?: boolean
  'aria-label'?: string
}) {
  const parse = (text: string) => {
    const n = Number(text)
    return text.trim() === '' || Number.isNaN(n) || (integer && !Number.isInteger(n))
      ? undefined
      : n
  }
  const [draft, setDraft] = useState(value === undefined ? '' : String(value))
  const [seen, setSeen] = useState(value)
  // A value changed from outside (another control, JSON mode) replaces what is typed.
  if (value !== seen) {
    setSeen(value)
    if (parse(draft) !== value) setDraft(value === undefined ? '' : String(value))
  }
  const invalid = draft.trim() !== '' && parse(draft) === undefined
  return (
    <input
      className={`insp-input font-mono text-[12.5px] tabular-nums ${invalid ? 'is-invalid' : ''}`}
      inputMode={integer ? 'numeric' : 'decimal'}
      value={draft}
      placeholder={placeholder}
      aria-label={ariaLabel}
      onChange={(e) => {
        setDraft(e.target.value)
        const n = parse(e.target.value)
        if (e.target.value.trim() === '') onChange(undefined)
        else if (n !== undefined) onChange(n)
      }}
    />
  )
}

export function Switch({
  checked,
  onChange,
  label,
  description,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: ReactNode
  description?: ReactNode
}) {
  const id = useId()
  return (
    <div className="flex items-start gap-3">
      <div className="min-w-0 flex-1">
        <label htmlFor={id} className="block text-[12.5px] text-fg">
          {label}
        </label>
        {description && (
          <p className="mt-0.5 text-[11.5px] leading-snug text-faint">{description}</p>
        )}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        className="insp-switch"
        onClick={() => onChange(!checked)}
      >
        <span />
      </button>
    </div>
  )
}

export interface Choice<T extends string> {
  value: T
  label: ReactNode
  title?: string
}

/** A row of mutually exclusive options; the choice is visible without opening anything. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  'aria-label': ariaLabel,
  size = 'md',
}: {
  value: T | undefined
  options: readonly Choice<T>[]
  onChange: (value: T) => void
  'aria-label'?: string
  size?: 'sm' | 'md'
}) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={`insp-seg insp-seg--${size}`}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          title={o.title}
          className={value === o.value ? 'is-on' : ''}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** A type as the compiler sees it, coloured by kind; `?` marks nullable. */
export function TypeChip({ type, title }: { type: MType | undefined; title?: string }) {
  if (!type) return <span className="tchip tchip--none">—</span>
  const base = stripNull(type)
  const text = show(base)
  return (
    <span className={`tchip tchip--${base.kind}`} title={title ?? show(type)}>
      {text}
      {type.kind === 'nullable' && base.kind !== 'never' && <span className="tchip-q">?</span>}
    </span>
  )
}

/** Field options of a record type: name in mono, type as the hint. */
export function fieldOptions(record: RecordType, extra: readonly string[] = []): SelectOption[] {
  const names = Object.keys(record.fields)
  const options: SelectOption[] = names.map((name) => ({
    value: name,
    label: name,
    hint: show(record.fields[name] as MType),
  }))
  for (const name of extra) {
    if (name && !names.includes(name))
      options.push({ value: name, label: name, hint: 'not in input' })
  }
  return options
}

/** Pick one field of a record. A value the record lacks stays visible, flagged. */
export function FieldSelect({
  record,
  value,
  onChange,
  placeholder = 'Choose a field',
  'aria-label': ariaLabel,
}: {
  record: RecordType
  value: string
  onChange: (value: string) => void
  placeholder?: string
  'aria-label'?: string
}) {
  const options = fieldOptions(record, [value])
  return (
    <Select
      mono
      aria-label={ariaLabel ?? placeholder}
      value={value}
      placeholder={Object.keys(record.fields).length ? placeholder : 'Connect an input first'}
      disabled={options.length === 0}
      onChange={onChange}
      options={options}
    />
  )
}

/** Several fields as removable chips, plus a picker for the rest. Order is kept. */
export function FieldChips({
  record,
  values,
  onChange,
  placeholder = 'Add a field',
}: {
  record: RecordType
  values: readonly string[]
  onChange: (values: string[]) => void
  placeholder?: string
}) {
  const rest = fieldOptions(record).filter((o) => !values.includes(o.value))
  return (
    <div className="space-y-2">
      {values.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {values.map((v) => (
            <span key={v} className={`insp-chip ${v in record.fields ? '' : 'is-missing'}`}>
              <span className="truncate font-mono">{v}</span>
              <button
                type="button"
                aria-label={`Remove ${v}`}
                onClick={() => onChange(values.filter((x) => x !== v))}
              >
                <X size={11} strokeWidth={2} />
              </button>
            </span>
          ))}
        </div>
      )}
      {rest.length > 0 && (
        <Select
          mono
          aria-label={placeholder}
          value=""
          placeholder={placeholder}
          onChange={(v) => onChange([...values, v])}
          options={rest}
        />
      )}
      {rest.length === 0 && values.length === 0 && (
        <p className="text-[11.5px] text-faint">Connect an input to choose its fields.</p>
      )}
    </div>
  )
}

/** Free-form list of strings as chips (e.g. literal values for "is one of"). */
export function TextChips({
  values,
  onChange,
  placeholder,
}: {
  values: readonly string[]
  onChange: (values: string[]) => void
  placeholder: string
}) {
  const [draft, setDraft] = useState('')
  const add = () => {
    const v = draft.trim()
    if (v && !values.includes(v)) onChange([...values, v])
    setDraft('')
  }
  return (
    <div className="insp-chipbox">
      {values.map((v) => (
        <span key={v} className="insp-chip">
          <span className="truncate font-mono">{v}</span>
          <button
            type="button"
            aria-label={`Remove ${v}`}
            onClick={() => onChange(values.filter((x) => x !== v))}
          >
            <X size={11} strokeWidth={2} />
          </button>
        </span>
      ))}
      <input
        className="min-w-16 flex-1 bg-transparent font-mono text-[12.5px] text-fg outline-none placeholder:text-faint"
        value={draft}
        placeholder={values.length ? '' : placeholder}
        aria-label={placeholder}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={add}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault()
            add()
          } else if (e.key === 'Backspace' && draft === '' && values.length) {
            onChange(values.slice(0, -1))
          }
        }}
      />
    </div>
  )
}

/** Dashed full-width button that adds a row. */
export function AddRow({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button type="button" className="insp-add" onClick={onClick}>
      <Plus size={13} strokeWidth={1.75} />
      {children}
    </button>
  )
}

export function IconButton({
  label,
  onClick,
  children,
  tone = 'default',
}: {
  label: string
  onClick: () => void
  children: ReactNode
  tone?: 'default' | 'danger'
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`grid size-6 shrink-0 place-items-center rounded-md text-faint transition-colors hover:bg-raised ${tone === 'danger' ? 'hover:text-down' : 'hover:text-fg'}`}
    >
      {children}
    </button>
  )
}

/** A short explanatory line under a control group. */
export function Note({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'warn' }) {
  return <p className={`insp-note insp-note--${tone}`}>{children}</p>
}
