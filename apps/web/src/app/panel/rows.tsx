import type { LucideIcon } from 'lucide-react'

/** A white card of rows on the glass panel, with hairlines between them. */
export const listClass =
  'divide-y divide-foreground/[0.06] overflow-hidden rounded-[16px] bg-background shadow-card'

export const rowClass =
  'hex-focus flex min-h-11 w-full items-center gap-3 px-3.5 py-2 text-left transition-colors duration-[var(--hex-motion-fast)] hover:bg-foreground/[0.03] focus-visible:-outline-offset-2'

/** A group's label above its card. */
export const headingClass = 'mb-1.5 px-1 text-[length:var(--text-meta)] font-medium text-muted'

export function RowIcon({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span className="grid size-7 shrink-0 place-items-center rounded-[9px] bg-foreground/[0.05] text-foreground/70">
      <Icon size={14} />
    </span>
  )
}

export function Empty({ icon: Icon, text }: { icon: LucideIcon; text: string }) {
  return (
    <div className="hex-fade grid justify-items-center gap-3 px-6 pt-10 text-center">
      <span className="grid size-11 place-items-center rounded-[14px] bg-background text-muted shadow-card">
        <Icon size={18} />
      </span>
      <p className="max-w-60 text-[length:var(--text-secondary)] text-muted">{text}</p>
    </div>
  )
}

/** "14:05" today, "Oct 25" this year, "10/25/24" before. */
export function shortTime(ms: number | undefined, now = Date.now()): string {
  if (!ms) {
    return ''
  }

  const date = new Date(ms)
  const today = new Date(now)

  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  }

  return date.getFullYear() === today.getFullYear()
    ? date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
    : date.toLocaleDateString(undefined, { day: 'numeric', month: 'numeric', year: '2-digit' })
}
