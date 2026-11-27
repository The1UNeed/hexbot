/**
 * Every bot's chat, read ahead and kept current, so switching to a bot shows
 * its chat at once instead of waiting for the daemon to start it.
 *
 * On each connection the chats are read two at a time, the primary bot first,
 * then by the list's order, with `hexbot.sections.history`, which starts no
 * bot. Afterwards only a chat whose bot shows new activity is read again, and
 * only the rows after the ones held come over. A chat with a loaded transcript
 * is left to its events. Daemons without `section_history` keep the old path:
 * a chat loads when it opens.
 */

import type { Bot } from '../lib/types'

import { useBots } from './bots'
import { useConnection } from './connection'
import { knownChat, sectionsActions } from './sections'

const PARALLEL = 2
/** Enough for any list a person keeps; the rest load when opened. */
const MOST = 40

let pass = 0
let queued = new Set<string>()
let running = false
/** What each bot looked like at its last read, so only a changed one reads again. */
const seen = new Map<string, string>()
/** Bots whose chat this connection is reading now. */
let reading = new Set<string>()

// A bot that wrote, or finished working, has something new in its chat.
const fingerprint = (bot: Bot) =>
  `${bot.last_activity_at ?? ''}:${bot.status ?? ''}:${bot.sections_recent
    .map(section => `${section.id}@${section.updated_at ?? ''}`)
    .join(',')}`

function ready(): boolean {
  const { daemon, status } = useConnection.getState()

  return status === 'connected' && Boolean(daemon?.section_history && daemon.one_chat)
}

/** The bots in the order a person reaches for them: the primary bot, then the list's order. */
function ranked(): Bot[] {
  const { byName, order } = useBots.getState()
  const bots = order.map(name => byName[name]).filter((bot): bot is Bot => Boolean(bot))

  return [...bots.filter(bot => bot.primary), ...bots.filter(bot => !bot.primary)].slice(0, MOST)
}

async function drain(generation: number): Promise<void> {
  if (running) {
    return
  }

  running = true

  try {
    const rank = new Map(ranked().map((bot, index) => [bot.name, index]))

    const next = () => {
      const name = [...queued].sort((a, b) => (rank.get(a) ?? MOST) - (rank.get(b) ?? MOST))[0]

      if (name !== undefined) {
        queued.delete(name)
      }

      return name
    }

    const current = () => generation === pass && ready()
    // An older connection's reads finish in their own set.
    const active = reading

    const worker = async () => {
      // A worker of an older connection takes nothing from the new one's queue.
      while (current()) {
        const name = next()
        const bot = name === undefined ? undefined : useBots.getState().byName[name]

        if (name === undefined) {
          return
        }

        if (!bot) {
          continue
        }

        active.add(name)

        try {
          // The daemon names the chat; a check never cancels a choice the user is making.
          const chat = knownChat(name) ?? (await sectionsActions().chat(name, current, true))

          if (chat && current()) {
            await sectionsActions().prefetch(chat.id, rank.get(name) ?? MOST)

            if (current()) {
              seen.set(name, fingerprint(bot))
            }
          }
        } catch {
          // Not marked read, so the bot's next change tries again; until then
          // its chat loads when it opens.
        } finally {
          active.delete(name)
        }
      }
    }

    await Promise.all(Array.from({ length: PARALLEL }, worker))
  } finally {
    running = false
  }

  // Bots that changed while this ran, or a new connection's whole list.
  if (queued.size && ready()) {
    void drain(pass)
  }
}

/** Read these bots' chats, or every bot's not read as it is now when none are named. */
export function prefetchChats(names?: string[]): void {
  if (!ready()) {
    return
  }

  const unread = ranked()
    .filter(bot => seen.get(bot.name) !== fingerprint(bot) && !reading.has(bot.name))
    .map(bot => bot.name)

  for (const name of names ?? unread) {
    queued.add(name)
  }

  void drain(pass)
}

/** A new connection reads everything again; what was held is sent as cursors. */
function restart(): void {
  pass++
  queued = new Set()
  reading = new Set()
  seen.clear()
  prefetchChats()
}

useConnection.subscribe((next, previous) => {
  const changed =
    next.target !== previous.target ||
    next.epoch !== previous.epoch ||
    next.daemon?.install_id !== previous.daemon?.install_id ||
    (next.status === 'connected') !== (previous.status === 'connected')

  if (changed) {
    restart()
  }
})

useBots.subscribe((next, previous) => {
  if (next.byName === previous.byName || !ready()) {
    return
  }

  // New, changed, or never read: a failed read tries again here.
  const changed = ranked()
    .filter(bot => seen.get(bot.name) !== fingerprint(bot))
    .map(bot => bot.name)

  if (changed.length) {
    prefetchChats(changed)
  }
})

export function resetChatPrefetchForTests(): void {
  pass++
  queued = new Set()
  seen.clear()
  reading = new Set()
  running = false
}
