import type { Bot, Room, Rpc, Section } from './types'
export type ChatRoute =
  { kind: 'section'; section: Section; bot: Bot } | { kind: 'room'; room: Room }
/** Every section the open conversation can be, teammate threads included. */
export const SECTIONS_QUERY = { include_archived: true, include_threads: true }
/** Every room, archived ones included, so Rooms can count them and restore one. */
export const ROOMS_QUERY = { include_archived: true }
/**
 * A bot's chat on a daemon from before one chat per bot, which keeps many
 * sections and makes another on every create. Its update keeps the one with
 * the latest conversation, giving way only for report-only logs, which its
 * list cannot tell apart, renamed or not. So the chat is certain only while at
 * most one section has something said; otherwise those are the choices,
 * open ones first, newest first. Null for a bot with none: create makes it.
 * Never a teammate thread.
 */
export function legacyChat(
  sections: Section[],
  bot: string
): { choices: Section[] } | { section: Section } | null {
  const chats = sections
    .filter(s => s.bot === bot && !s.peer_bot)
    .sort(
      (a, b) =>
        Number(!!a.archived_at) - Number(!!b.archived_at) || (b.updated_at ?? 0) - (a.updated_at ?? 0)
    )
  const said = chats.filter(s => s.message_count > 0)
  if (said.length > 1) return { choices: said }
  const section = said[0] ?? chats[0]
  return section ? { section } : null
}
/**
 * The section a tap on a bot opens, or the `chosen` one. A daemon with one
 * chat per bot names it, never one recovery set aside, whatever the lists
 * here say. An older one: the section its list makes certain, else the one
 * in `picked` from before, else the sections to choose from; made only for
 * a bot with none. The one it opens is remembered in `picked` and comes out
 * of the archive first: archived, it takes no messages and loses at the update.
 */
export async function botChat(
  rpc: Rpc,
  bot: string,
  oneChat: boolean,
  picked: Map<string, string>,
  chosen?: Section
): Promise<{ choices: Section[] } | { section: Section }> {
  const create = async () =>
    (await rpc<{ section: Section }>('hexbot.sections.create', { bot })).section
  if (oneChat) return { section: chosen ?? (await create()) }
  let section = chosen
  if (!section) {
    const { sections } = await rpc<{ sections: Section[] }>('hexbot.sections.list', {
      ...SECTIONS_QUERY,
      bot
    })
    const found = legacyChat(sections, bot)
    if (!found) return { section: await create() }
    section = 'section' in found ? found.section : found.choices.find(s => s.id === picked.get(bot))
    if (!section) return found
  }
  // Older daemons update recency even for an open section. Persist the pick
  // before remembering it, so an upgrade keeps it without another message.
  const opened = await rpc<{ section: Section }>('hexbot.sections.unarchive', { id: section.id })
  picked.set(bot, section.id)
  return opened
}
/**
 * The room Rooms shows: the picked one while it is open or not archived,
 * otherwise the most recent room that is not archived. An open room the list
 * does not have yet, such as one just created, stays.
 */
export function shownRoom(rooms: Room[], picked: string | null, open: string | null) {
  if (picked && picked === open) return picked
  const room = rooms.find(r => r.id === picked)
  if (room && !room.archived_at) return room.id
  return (
    rooms.filter(r => !r.archived_at).sort((a, b) => b.last_activity_at - a.last_activity_at)[0]
      ?.id ?? null
  )
}
/** Whether this room is the open conversation. */
export const isOpenRoom = (route: ChatRoute | null, id: string) =>
  route?.kind === 'room' && route.room.id === id
/** The open conversation after the lists reload, or null once it is gone. */
export function rebind(
  route: ChatRoute,
  lists: { bots: Bot[]; rooms: Room[]; sections: Section[] }
): ChatRoute | null {
  if (route.kind === 'section') {
    const section = lists.sections.find(x => x.id === route.section.id)
    const bot = lists.bots.find(x => x.name === route.bot.name)
    return section && bot ? { kind: 'section', section, bot } : null
  }
  const room = lists.rooms.find(x => x.id === route.room.id)
  return room ? { kind: 'room', room: { ...room, turns: room.turns ?? route.room.turns } } : null
}

/** A catalog cannot identify a canonical chat among preserved recovery rows. */
export function chatPreview(bot: string, sections: Section[], recent: Section[] = []): string | null {
  const chats = new Map(
    [...recent, ...sections].filter(s => s.bot === bot && !s.peer_bot).map(s => [s.id, s])
  )
  return chats.size === 1 ? [...chats.values()][0]!.preview || null : null
}
