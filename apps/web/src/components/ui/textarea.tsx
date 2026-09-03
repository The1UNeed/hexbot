import type { TextareaHTMLAttributes } from 'react'

import { cn } from '../../lib/cn'

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>

export function Textarea({ className, rows = 3, ...props }: TextareaProps) {
  return (
    <textarea
      className={cn(
        'w-full resize-none rounded-control border border-border bg-surface px-3 py-2 text-[length:var(--text-body)] leading-relaxed text-foreground outline-none transition-colors placeholder:text-muted focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50',
        className
      )}
      rows={rows}
      {...props}
    />
  )
}
