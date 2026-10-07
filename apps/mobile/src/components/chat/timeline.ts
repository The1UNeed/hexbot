/**
 * A bot's section as a flat list of rows, oldest first: time separators,
 * one row per bubble (each finished message is its own bubble), the cards
 * the turn stopped on, the memory marks, the work line and, at the foot of
 * a running turn, the live status. `gap` is the space above a row: 4 pt
 * under a bubble from the same side, 12 pt when the speaker changes.
 */

import { toMillis } from '../../lib/time'
import type { ApprovalRequest, Attachment, ClarifyRequest } from '../../lib/types'
import type { TranscriptMessage } from '../../stores/transcripts'

import type { Side } from './bubble'
import { memoryMarks, workShown } from './steps'

export type Row =
  | { approval: ApprovalRequest; gap: number; key: string; kind: 'approval' }
  | { attachments: Attachment[]; fresh: boolean; gap: number; key: string; kind: 'bubble'; last: boolean; side: Side; text: string }
  | { clarify: ClarifyRequest; gap: number; key: string; kind: 'clarify' }
  | { gap: number; key: string; kind: 'live'; message: TranscriptMessage }
  | { gap: number; key: string; kind: 'marks'; message: TranscriptMessage }
  | { gap: number; key: string; kind: 'separator'; time: number }
  | { gap: number; key: string; kind: 'stopped'; message: TranscriptMessage }
  | { fresh: boolean; gap: number; key: string; kind: 'summary'; message: TranscriptMessage }

export const JOINED = 4
export const NEW_SPEAKER = 12

const dayKey = (time: number) => new Date(toMillis(time)).toDateString()

/**
 * A separator before `message`: between days and after 20 quiet minutes.
 * Restored history has no times (createdAt 0), so it gets none, and none
 * right after it, so a reload never splits a turn.
 */
export function separatedFrom(previous: { createdAt: number } | undefined, message: { createdAt: number }): boolean {
  return (
    message.createdAt > 0 &&
    (!previous ||
      (previous.createdAt > 0 &&
        (dayKey(previous.createdAt) !== dayKey(message.createdAt) ||
          toMillis(message.createdAt) - toMillis(previous.createdAt) > 20 * 60_000)))
  )
}

type Item =
  | { approval: ApprovalRequest; at: number; kind: 'approval' }
  | { at: number; clarify: ClarifyRequest; kind: 'clarify' }
  | { at: number; kind: 'message'; message: TranscriptMessage }

export function buildRows(input: {
  approvals: ApprovalRequest[]
  clarifies: ClarifyRequest[]
  messages: TranscriptMessage[]
  openedAt: number
  /** When the section began; restored history has no times of its own, so this heads it. */
  startedAt?: null | number
  /** A Stopped card from the bot's status, for a failure that happened while the section was closed. */
  stopped?: null | TranscriptMessage
}): Row[] {
  const { approvals, clarifies, messages, openedAt } = input

  // Restored history carries no times and stays first; cards slot in by when they arrived.
  const items: Item[] = [
    ...messages.map(message => ({ at: message.createdAt > 0 ? toMillis(message.createdAt) : 0, kind: 'message' as const, message })),
    ...clarifies.map(clarify => ({ at: clarify.receivedAt, clarify, kind: 'clarify' as const })),
    ...approvals.map(approval => ({ approval, at: approval.receivedAt, kind: 'approval' as const }))
  ].sort((a, b) => a.at - b.at)

  const rows: Row[] = []
  /** Which side the previous row was drawn on, for the gap. */
  let side: 'none' | Side = 'none'
  let previousMessage: TranscriptMessage | undefined
  const lastUser = messages.findLast(message => message.role === 'user' && !message.error)

  const gapFor = (next: Side) => (side === next ? JOINED : NEW_SPEAKER)

  if (input.startedAt && messages[0] && messages[0].createdAt === 0) {
    rows.push({ gap: 0, key: 'sep:start', kind: 'separator', time: input.startedAt })
  }

  for (const item of items) {
    if (item.kind === 'approval') {
      rows.push({ approval: item.approval, gap: gapFor('bot'), key: `approval:${item.approval.requestId}`, kind: 'approval' })
      side = 'bot'
      continue
    }

    if (item.kind === 'clarify') {
      rows.push({ clarify: item.clarify, gap: gapFor('bot'), key: `clarify:${item.clarify.requestId}`, kind: 'clarify' })
      side = 'bot'
      continue
    }

    const { message } = item

    if (separatedFrom(previousMessage, message)) {
      rows.push({ gap: 0, key: `sep:${message.id}`, kind: 'separator', time: message.createdAt })
      side = 'none'
    }

    previousMessage = message

    if (message.error) {
      // The daemon's incident and the turn's own failure can both arrive for one failure: one card.
      const before = rows.at(-1)

      if (before?.kind === 'stopped' && before.message.error === message.error) {
        continue
      }

      rows.push({ gap: gapFor('bot'), key: `stopped:${message.id}`, kind: 'stopped', message })
      side = 'bot'
      continue
    }

    if (message.role !== 'assistant' && message.role !== 'user') {
      continue
    }

    const fresh = message.createdAt > 0 && toMillis(message.createdAt) > openedAt
    const own = message.role === 'user'

    // A bot's words show one finished message at a time, never mid-sentence.
    const words = (own ? [message.text] : [...(message.parts ?? []), ...(message.streaming ? [] : [message.text])]).filter(text => text.trim())

    if (!words.length && message.attachments.length && !message.streaming) {
      words.push('')
    }

    words.forEach((text, index) => {
      const next: Side = own ? 'user' : 'bot'
      const last = index === words.length - 1

      rows.push({
        attachments: last ? message.attachments : [],
        fresh,
        gap: gapFor(next),
        key: `${message.id}:${index}`,
        kind: 'bubble',
        last: own && last && message === lastUser,
        side: next,
        text
      })
      side = next
    })

    if (own) {
      continue
    }

    if (memoryMarks(message).length) {
      rows.push({ gap: 2, key: `marks:${message.id}`, kind: 'marks', message })
    }

    if (message.streaming) {
      rows.push({ gap: words.length ? JOINED : gapFor('bot'), key: `live:${message.id}`, kind: 'live', message })
      side = 'bot'
    } else if (workShown(message)) {
      rows.push({ fresh, gap: 0, key: `summary:${message.id}`, kind: 'summary', message })
    }
  }

  if (input.stopped) {
    rows.push({ gap: gapFor('bot'), key: `stopped:${input.stopped.id}`, kind: 'stopped', message: input.stopped })
  }

  return rows
}

/** "Today 9:13 PM", "Yesterday 4:02 PM", or "12 Aug 2:10 PM". */
export function dayLabel(time: number, now = Date.now()): string {
  const date = new Date(toMillis(time))
  const clock = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const today = new Date(now)
  const yesterday = new Date(now - 86_400_000)

  if (date.toDateString() === today.toDateString()) {
    return `Today ${clock}`
  }

  if (date.toDateString() === yesterday.toDateString()) {
    return `Yesterday ${clock}`
  }

  const day = date.toLocaleDateString([], {
    day: 'numeric',
    month: 'short',
    ...(date.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' })
  })

  return `${day} ${clock}`
}
