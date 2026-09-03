import { Select as BaseSelect } from '@base-ui/react/select'
import { Check, ChevronDown } from 'lucide-react'

export interface SelectOption {
  label: string
  value: string
}

export interface SelectProps {
  disabled?: boolean
  label?: string
  onValueChange: (value: string) => void
  options: SelectOption[]
  placeholder?: string
  value?: string
}

export function Select({ disabled, label, onValueChange, options, placeholder, value }: SelectProps) {
  return (
    <BaseSelect.Root disabled={disabled} onValueChange={next => next && onValueChange(next)} value={value}>
      <BaseSelect.Trigger
        aria-label={label}
        className="flex h-9 w-full items-center justify-between rounded-control border border-border bg-surface px-3 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50"
      >
        <BaseSelect.Value>{selected => selected ? options.find(item => item.value === selected)?.label : placeholder}</BaseSelect.Value>
        <BaseSelect.Icon><ChevronDown aria-hidden size={15} /></BaseSelect.Icon>
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner className="z-50 outline-none" sideOffset={6}>
          <BaseSelect.Popup className="min-w-[var(--anchor-width)] rounded-control border border-border bg-surface p-1 text-foreground shadow-popup outline-none">
            <BaseSelect.List>
              {options.map(option => (
                <BaseSelect.Item
                  className="flex cursor-default items-center gap-2 rounded-control px-2.5 py-2 text-[length:var(--text-secondary)] outline-none data-[highlighted]:bg-surface-2"
                  key={option.value}
                  value={option.value}
                >
                  <BaseSelect.ItemIndicator><Check aria-hidden size={14} /></BaseSelect.ItemIndicator>
                  <BaseSelect.ItemText>{option.label}</BaseSelect.ItemText>
                </BaseSelect.Item>
              ))}
            </BaseSelect.List>
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  )
}
