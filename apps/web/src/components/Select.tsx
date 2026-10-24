import * as RadixSelect from '@radix-ui/react-select'
import { Check, ChevronsUpDown } from 'lucide-react'
import type { ReactNode } from 'react'

export interface SelectOption {
  value: string
  label: ReactNode
  /** Secondary text shown muted in the list only, e.g. a row count. */
  hint?: ReactNode
  disabled?: boolean
}

/**
 * The one select in the app (Radix, so keyboard and typeahead work). Radix reserves the
 * empty string, so `''` / `null` mean "no value" and show the placeholder.
 */
export function Select({
  value,
  onChange,
  options,
  placeholder = 'Choose…',
  disabled = false,
  mono = false,
  className = '',
  'aria-label': ariaLabel,
}: {
  value: string | null | undefined
  onChange: (value: string) => void
  options: readonly SelectOption[]
  placeholder?: string
  disabled?: boolean
  mono?: boolean
  className?: string
  'aria-label'?: string
}) {
  return (
    <RadixSelect.Root value={value || undefined} onValueChange={onChange} disabled={disabled}>
      <RadixSelect.Trigger
        aria-label={ariaLabel}
        className={`flex h-9 w-full min-w-0 items-center justify-between gap-2 rounded-md border border-line bg-canvas px-2.5 text-left text-[13.5px] text-fg outline-none transition-colors hover:border-line-strong focus-visible:border-line-strong disabled:cursor-not-allowed disabled:opacity-50 data-[placeholder]:text-faint data-[state=open]:border-line-strong ${mono ? 'font-mono text-[12.5px]' : ''} ${className}`}
      >
        <span className="truncate">
          <RadixSelect.Value placeholder={placeholder} />
        </span>
        <RadixSelect.Icon className="shrink-0 text-faint">
          <ChevronsUpDown size={14} strokeWidth={1.5} />
        </RadixSelect.Icon>
      </RadixSelect.Trigger>
      <RadixSelect.Portal>
        <RadixSelect.Content
          position="popper"
          sideOffset={4}
          className="select-content z-50 max-h-[min(300px,var(--radix-select-content-available-height))] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-lg border border-line-strong bg-[#141518] p-1 shadow-xl shadow-black/60"
        >
          <RadixSelect.Viewport>
            {options
              .filter((o) => o.value !== '')
              .map((option) => (
                <RadixSelect.Item
                  key={option.value}
                  value={option.value}
                  disabled={option.disabled}
                  className={`relative flex h-8 cursor-default items-center gap-2 rounded-[5px] px-1.5 text-[13.5px] text-fg outline-none select-none data-[disabled]:opacity-40 data-[highlighted]:bg-raised ${mono ? 'font-mono text-[12.5px]' : ''}`}
                >
                  <RadixSelect.ItemText>{option.label}</RadixSelect.ItemText>
                  {option.hint !== undefined && (
                    <span className="ml-auto pl-3 text-[12px] text-faint">{option.hint}</span>
                  )}
                  {/* Fixed slot, so hints don't shift when the check appears. */}
                  <span
                    className={`grid w-4 shrink-0 place-items-center ${option.hint === undefined ? 'ml-auto' : ''}`}
                  >
                    <RadixSelect.ItemIndicator className="text-fg">
                      <Check size={14} strokeWidth={1.75} />
                    </RadixSelect.ItemIndicator>
                  </span>
                </RadixSelect.Item>
              ))}
          </RadixSelect.Viewport>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  )
}
