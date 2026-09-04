import { cva, type VariantProps } from 'class-variance-authority'
import type { HTMLAttributes } from 'react'

import { cn } from '../../lib/cn'

const chipVariants = cva(
  'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[length:var(--text-meta)] font-medium',
  {
    defaultVariants: { tone: 'neutral' },
    variants: {
      tone: {
        accent: 'bg-accent/12 text-accent',
        danger: 'bg-danger/12 text-danger',
        muted: 'text-muted',
        neutral: 'bg-surface-2 text-muted',
        success: 'bg-success/12 text-success',
        warning: 'bg-warning/12 text-warning'
      }
    }
  }
)

export interface ChipProps
  extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof chipVariants> {}

export function Chip({ children, className, tone, ...props }: ChipProps) {
  return (
    <span className={cn(chipVariants({ tone }), className)} {...props}>
      {children}
    </span>
  )
}
