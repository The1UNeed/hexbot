import { Input as BaseInput } from '@base-ui/react/input'
import type { ComponentPropsWithoutRef } from 'react'

import { cn } from '../../lib/cn'

export interface InputProps extends ComponentPropsWithoutRef<typeof BaseInput> {
  invalid?: boolean
}

export function Input({ className, invalid = false, ...props }: InputProps) {
  return (
    <BaseInput
      aria-invalid={invalid || undefined}
      className={cn(
        'h-9 w-full rounded-control border border-border bg-background px-3 text-[length:var(--text-body)] text-foreground outline-none transition-colors placeholder:text-muted focus-visible:border-foreground/40 disabled:opacity-50',
        invalid && 'border-danger focus-visible:border-danger',
        className
      )}
      {...props}
    />
  )
}
