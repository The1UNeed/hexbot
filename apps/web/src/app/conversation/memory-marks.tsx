import { ChevronDown } from 'lucide-react'
import { useState } from 'react'

import { cn } from '../../lib/cn'
import type { Message } from '../../lib/types'

import { type MemoryMark, memoryMarks } from './steps'

const LABEL: Record<MemoryMark['kind'], string> = {
  memory: 'Memory updated',
  soul: 'Soul updated'
}

/** One "Memory updated" or "Soul updated" mark; opens to show what was written. */
function Mark({ mark }: { mark: MemoryMark }) {
  const [open, setOpen] = useState(false)

  return (
    <li>
      <button
        aria-expanded={open}
        className="flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[length:var(--text-meta)] text-muted hover:text-foreground"
        onClick={() => setOpen(!open)}
        type="button"
      >
        {LABEL[mark.kind]}
        <ChevronDown className={cn('shrink-0', open && 'rotate-180')} size={11} />
      </button>
      {open ? (
        <pre className="mt-1 max-h-40 max-w-prose overflow-auto whitespace-pre-wrap rounded-control bg-surface-2 p-2 font-mono text-[length:var(--text-meta)]">
          {mark.text}
        </pre>
      ) : null}
    </li>
  )
}

/**
 * Under a bot's bubble: a small mark for every memory or soul write the turn
 * made, so the user always sees when the bot changed what it knows or who it
 * is. The tool rows themselves stay out of the work panel.
 */
export function MemoryMarks({ message }: { message: Message }) {
  const marks = memoryMarks(message)

  if (!marks.length) {
    return null
  }

  return (
    <ul className="mt-1 flex flex-wrap gap-1.5 px-1" data-testid="memory-marks">
      {marks.map((mark, index) => (
        <Mark key={`${mark.kind}-${index}`} mark={mark} />
      ))}
    </ul>
  )
}
