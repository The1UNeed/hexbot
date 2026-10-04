import { cn } from '../../lib/cn'

export interface SwitchProps {
  'aria-label'?: string
  checked: boolean
  className?: string
  disabled?: boolean
  onCheckedChange: (checked: boolean) => void
}

/** An iOS-style toggle: the foreground colour when on, a quiet track when off. */
export function Switch({ checked, className, disabled, onCheckedChange, ...props }: SwitchProps) {
  return (
    <button
      aria-checked={checked}
      aria-label={props['aria-label']}
      className={cn(
        'relative inline-flex h-[24px] w-[40px] shrink-0 items-center hex-focus rounded-full transition-colors duration-[var(--hex-motion-panel)] disabled:opacity-50',
        checked ? 'bg-foreground' : 'bg-foreground/[0.16]',
        className
      )}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      role="switch"
      type="button"
    >
      <span
        className={cn(
          'absolute top-[2px] left-[2px] size-[20px] rounded-full bg-background shadow-[0_1px_2px_rgb(0_0_0/0.2),0_0_0_0.5px_rgb(0_0_0/0.04)] transition-transform duration-[var(--hex-motion-panel)] ease-[var(--hex-ease-spring)]',
          checked ? 'translate-x-[16px]' : 'translate-x-0'
        )}
      />
    </button>
  )
}
