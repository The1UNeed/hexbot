/**
 * Each bot's chat held in memory, so opening it shows it at once (as the web
 * app does in `apps/web/src/stores/sections.ts`). Chats are read ahead with
 * `hexbot.sections.history`, which starts no bot, and every read sends the
 * daemon's cursor, so only rows newer than the ones held come over.
 */
import type { Bot } from './types'

export interface HeldRows {
  rows: unknown[]
  /** The daemon's cursor for the end of `rows`. */
  cursor?: string
  /** False when `rows` are only the newest part of the history. */
  complete: boolean
  /** When the chat was last opened here; a chat only read ahead ranks below, by its bot's place. */
  touched: number
  /** Whole and within the budget, measured once: trimming leaves it be. */
  fits?: boolean
}

export interface HistoryRead {
  messages?: unknown[]
  history_cursor?: string
  history_delta?: boolean
}

const PART_ROWS = 500
const PART_BYTES = 512 * 1024
/** Whole histories kept for the chats opened most recently; the rest keep their newest part. */
const WHOLE = 4

/** The newest rows that fit the budget; one oversized row cannot take it all. */
export function newestPart(rows: unknown[]): unknown[] {
  let bytes = 2
  const kept: unknown[] = []
  for (const row of rows.slice(-PART_ROWS).reverse()) {
    const size = JSON.stringify(row).length + 1
    if (bytes + size > PART_BYTES) break
    bytes += size
    kept.push(row)
  }
  return kept.reverse()
}

/** The cursor to send: only rows that are the whole history can take what follows them. */
export function cursorFor(held: HeldRows | undefined, partial = false): string | undefined {
  return held && (partial || held.complete) ? held.cursor : undefined
}

/** What is held after a read that sent `sent` as its cursor. */
export function afterRead(
  held: HeldRows | undefined,
  read: HistoryRead,
  sent: string | undefined,
  touched: number
): HeldRows {
  const appended = read.messages ?? []
  const delta = Boolean(held && sent && read.history_delta)
  return {
    rows: delta ? [...held!.rows, ...appended] : appended,
    cursor: read.history_cursor,
    complete: delta ? held!.complete : true,
    touched
  }
}

/** Keep `held` under `chat`, and trim whole histories past the most recent few. */
export function keep(map: Map<string, HeldRows>, chat: string, held: HeldRows): void {
  const part = newestPart(held.rows)
  const fits = part.length === held.rows.length
  map.set(chat, held.complete ? { ...held, fits } : { ...held, rows: part, fits: false })
  // Only whole chats too big for the budget are trimmed, so none is measured twice.
  const whole = [...map]
    .filter(([, item]) => item.complete && !item.fits)
    .sort(([, a], [, b]) => b.touched - a.touched)
  for (const [key, item] of whole.slice(WHOLE))
    map.set(key, { ...item, complete: false, rows: newestPart(item.rows) })
}

/** The bots in the order a person reaches for them: the primary bot, then the list's order. */
export function prefetchOrder(bots: Bot[]): Bot[] {
  return [...bots.filter(bot => bot.primary), ...bots.filter(bot => !bot.primary)]
}

/** A bot that wrote, or finished working, has something new in its chat. */
export const fingerprint = (bot: Bot) =>
  `${bot.last_activity_at ?? ''}:${bot.status ?? ''}:${(bot.sections_recent ?? [])
    .map(section => `${section.id}@${section.updated_at ?? ''}`)
    .join(',')}`
