import type { TextareaHTMLAttributes } from 'react'

import { cn } from '../../lib/cn'

import { fieldClass } from './input'

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>

export function Textarea({ className, rows = 3, ...props }: TextareaProps) {
  return (
    <textarea
      className={cn(fieldClass, 'w-full resize-none px-3 py-2 leading-relaxed', className)}
      rows={rows}
      {...props}
    />
  )
}
