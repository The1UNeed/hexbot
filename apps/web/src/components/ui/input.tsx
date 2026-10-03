import { Input as BaseInput } from '@base-ui/react/input'
import type { ComponentPropsWithoutRef } from 'react'

import { cn } from '../../lib/cn'

export interface InputProps extends ComponentPropsWithoutRef<typeof BaseInput> {
  invalid?: boolean
}

/** Shared by Input, Textarea and the Select trigger: a soft fill, a ring on focus. */
export const fieldClass =
  'rounded-[10px] bg-surface-2/60 text-[length:var(--text-body)] text-foreground outline-none transition-[background-color,box-shadow] duration-[var(--hex-motion-fast)] placeholder:text-muted hover:bg-surface-2/80 focus-visible:bg-background focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-50'

export function Input({ className, invalid = false, ...props }: InputProps) {
  return (
    <BaseInput
      aria-invalid={invalid || undefined}
      className={cn(
        fieldClass,
        'h-[36px] w-full px-3',
        invalid && 'ring-2 ring-danger/50 focus-visible:ring-danger/60',
        className
      )}
      {...props}
    />
  )
}
