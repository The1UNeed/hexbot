import { Select as BaseSelect } from '@base-ui/react/select'
import { Check, ChevronDown } from 'lucide-react'

import { cn } from '../../lib/cn'

import { fieldClass } from './input'

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

export function Select({
  disabled,
  label,
  onValueChange,
  options,
  placeholder,
  value
}: SelectProps) {
  return (
    <BaseSelect.Root
      disabled={disabled}
      onValueChange={next => next && onValueChange(next)}
      value={value ?? null}
    >
      <BaseSelect.Trigger
        aria-label={label}
        className={cn(
          fieldClass,
          'flex h-[36px] w-full min-w-0 items-center justify-between gap-2 px-3 text-left'
        )}
      >
        <BaseSelect.Value className="min-w-0 truncate">
          {selected =>
            selected ? options.find(item => item.value === selected)?.label : placeholder
          }
        </BaseSelect.Value>
        <BaseSelect.Icon className="shrink-0 text-muted">
          <ChevronDown aria-hidden size={15} />
        </BaseSelect.Icon>
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner
          alignItemWithTrigger={false}
          className="z-50 outline-none"
          sideOffset={6}
        >
          <BaseSelect.Popup className="hex-glass-strong hex-menu-in max-h-80 min-w-[var(--anchor-width)] overflow-auto rounded-[14px] p-1 text-foreground outline-none">
            <BaseSelect.List>
              {options.map(option => (
                <BaseSelect.Item
                  className="flex cursor-default items-center gap-2 rounded-[10px] py-2 pr-3 pl-2.5 text-[length:var(--text-secondary)] outline-none data-[highlighted]:bg-foreground/[0.07]"
                  key={option.value}
                  value={option.value}
                >
                  <span className="flex size-4 shrink-0 items-center justify-center">
                    <BaseSelect.ItemIndicator>
                      <Check aria-hidden size={14} />
                    </BaseSelect.ItemIndicator>
                  </span>
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
