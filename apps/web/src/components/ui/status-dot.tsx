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
