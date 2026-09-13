import { cva, type VariantProps } from 'class-variance-authority'
import type { ButtonHTMLAttributes, ReactNode } from 'react'

import { cn } from '../../lib/cn'

import { Spinner } from './spinner'

export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 rounded-control font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-foreground/40 focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50',
  {
    defaultVariants: { size: 'md', variant: 'secondary' },
    variants: {
      size: {
        icon: 'size-8 rounded-full',
        md: 'h-9 px-4 text-[length:var(--text-body)]',
        sm: 'h-7 px-2.5 text-[length:var(--text-secondary)]'
      },
      variant: {
        danger: 'bg-danger text-white hover:opacity-90',
        ghost: 'text-muted hover:bg-surface-2 hover:text-foreground',
        pill: 'rounded-full bg-surface-2 text-foreground hover:bg-surface-3',
        primary: 'bg-foreground text-background hover:opacity-85',
        secondary: 'bg-surface-2 text-foreground hover:bg-surface-3'
      }
    }
  }
)

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  /** Shows a spinner and blocks interaction. */
  busy?: boolean
  icon?: ReactNode
}

export function Button({
  busy = false,
  children,
  className,
  disabled,
  icon,
  size,
  type = 'button',
  variant,
  ...props
}: ButtonProps) {
  return (
    <button
      className={cn(buttonVariants({ size, variant }), className)}
      disabled={disabled || busy}
      type={type}
      {...props}
    >
      {busy ? <Spinner size="sm" /> : icon}
      {children}
    </button>
  )
}
