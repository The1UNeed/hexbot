import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '../../lib/cn'

const spinnerVariants = cva('inline-block animate-spin rounded-full border-2 border-current border-t-transparent', {
  defaultVariants: { size: 'md' },
  variants: {
    size: {
      md: 'size-4',
      sm: 'size-3'
    }
  }
})

export interface SpinnerProps extends VariantProps<typeof spinnerVariants> {
  className?: string
  label?: string
}

export function Spinner({ className, label = 'Loading', size }: SpinnerProps) {
  return <span aria-label={label} className={cn(spinnerVariants({ size }), className)} role="status" />
}
