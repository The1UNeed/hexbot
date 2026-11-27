import type { LucideIcon } from 'lucide-react'

import type { MenuItem } from '../../../components/ui/menu'

/**
 * A notice: something the chat wants you to know that is not a message, such
 * as a turn that stopped, a chat that did not load, or the offer to turn on
 * notifications. Every notice floats in one place, just above the composer
 * (`NoticeDock`). What belongs to one message (its "Not sent" line, a
 * question card, an approval) stays in the chat.
 */
export type NoticeTone = 'accent' | 'danger' | 'info' | 'warning'

export interface NoticeAction {
  label: string
  onSelect: () => void
  primary?: boolean
}

export interface Notice {
  id: string
  tone: NoticeTone
  icon?: LucideIcon
  title: string
  detail?: string
  /** When it happened, in milliseconds. */
  time?: number
  actions?: NoticeAction[]
  menu?: MenuItem[]
  onDismiss?: () => void
  /** Names the card for tests, such as `stopped-card`. */
  testId?: string
}

/**
 * Failures first, then what waits on you, then the rest. Within each, what
 * you can act on (Retry, Enable) comes before what you can only read, then
 * the newest.
 */
const RANK: Record<NoticeTone, number> = { accent: 1, danger: 0, info: 3, warning: 2 }

const actionable = (notice: Notice) => (notice.actions?.length ? 0 : 1)

export function sortNotices(notices: Notice[]): Notice[] {
  return [...notices].sort(
    (a, b) =>
      RANK[a.tone] - RANK[b.tone] || actionable(a) - actionable(b) || (b.time ?? 0) - (a.time ?? 0)
  )
}
