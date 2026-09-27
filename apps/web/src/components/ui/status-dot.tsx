import { CircleHelp, type LucideIcon, Wrench } from 'lucide-react'

import { cn } from '../../lib/cn'
import type { BotStatus } from '../../lib/types'

/**
 * One colour per state, everywhere a bot or room shows one: blue while it
 * works, purple (the accent) when it needs you, red when it stopped, green
 * when it finished and you have not looked yet. The first three colours back
 * the transcript banners and the composer border.
 */
export type DotStatus = 'done' | BotStatus

export const STATUS_TONES: Record<Exclude<DotStatus, 'idle'>, { dot: string; label: string }> = {
  done: { dot: 'bg-success', label: 'Done' },
  needs_you: { dot: 'bg-accent', label: 'Needs you' },
  stopped: { dot: 'bg-danger', label: 'Stopped' },
  working: { dot: 'bg-info', label: 'Working' }
}

export function StatusDot({
  className,
  size = 'md',
  status
}: {
  className?: string
  /** `sm` sits on a 24px face, `md` on a 40px one. */
  size?: 'md' | 'sm'
  status?: DotStatus
}) {
  if (!status || status === 'idle') {
    return null
  }

  const tone = STATUS_TONES[status]

  return (
    <span
      aria-label={tone.label}
      className={cn(
        'absolute rounded-full border-surface',
        size === 'sm' ? '-right-px -bottom-px size-2.5 border' : '-right-0.5 -bottom-0.5 size-3 border-2',
        tone.dot,
        status === 'working' && 'hex-pulse',
        className
      )}
      data-status={status}
      role="img"
    />
  )
}

/** The two states that get a word beside an icon; the rest only colour a dot. */
const TAGS: Partial<Record<DotStatus, { icon: LucideIcon; text: string; word: string }>> = {
  needs_you: { icon: CircleHelp, text: 'text-accent', word: 'Waiting' },
  working: { icon: Wrench, text: 'text-info', word: 'Working' }
}

/**
 * An icon and a word at the end of a roster row: "Waiting" while the bot
 * needs you, "Working" while it works. Any other state draws nothing.
 */
export function StatusTag({ className, status }: { className?: string; status?: DotStatus }) {
  const tag = status ? TAGS[status] : undefined

  if (!tag) {
    return null
  }

  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 text-[length:var(--text-meta)] font-medium',
        tag.text,
        className
      )}
      data-testid="status-tag"
    >
      <tag.icon aria-hidden size={12} />
      {tag.word}
    </span>
  )
}
