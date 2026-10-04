import { cva, type VariantProps } from 'class-variance-authority'
import type { ButtonHTMLAttributes, ReactNode } from 'react'

import { cn } from '../../lib/cn'

import { Spinner } from './spinner'

export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 rounded-[10px] font-medium whitespace-nowrap transition-[background-color,color,opacity,transform] duration-[var(--hex-motion-fast)] hex-focus active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50',
  {
    defaultVariants: { size: 'md', variant: 'secondary' },
    variants: {
      size: {
        icon: 'size-8 rounded-full',
        md: 'h-[36px] px-4 text-[length:var(--text-body)]',
        sm: 'h-[30px] px-3 text-[length:var(--text-secondary)]'
      },
      variant: {
        danger: 'bg-danger text-white hover:opacity-90',
        ghost: 'text-muted hover:bg-foreground/[0.06] hover:text-foreground',
        pill: 'rounded-full bg-foreground/[0.07] text-foreground hover:bg-foreground/[0.11]',
        primary: 'bg-foreground text-background hover:opacity-85',
        secondary: 'bg-foreground/[0.07] text-foreground hover:bg-foreground/[0.11]'
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
