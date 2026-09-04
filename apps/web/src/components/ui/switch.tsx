import { cn } from '../../lib/cn'

export interface SwitchProps {
  'aria-label'?: string
  checked: boolean
  className?: string
  disabled?: boolean
  onCheckedChange: (checked: boolean) => void
}

/** An iOS-style toggle. */
export function Switch({ checked, className, disabled, onCheckedChange, ...props }: SwitchProps) {
  return (
    <button
      aria-checked={checked}
      aria-label={props['aria-label']}
      className={cn(
        'relative inline-flex h-[22px] w-[38px] shrink-0 items-center rounded-full transition-colors duration-[var(--hex-motion-panel)] outline-none focus-visible:ring-2 focus-visible:ring-foreground/40 focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:opacity-50',
        checked ? 'bg-foreground' : 'bg-surface-3',
        className
      )}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      role="switch"
      type="button"
    >
      <span
        className={cn(
          'absolute top-[2px] left-[2px] size-[18px] rounded-full shadow-sm transition-transform duration-[var(--hex-motion-panel)]',
          checked ? 'translate-x-4 bg-background' : 'translate-x-0 bg-background'
        )}
      />
    </button>
  )
}
