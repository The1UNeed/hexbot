import type { Bot, Room, Section } from './types'
export type ChatRoute =
  { kind: 'section'; section: Section; bot: Bot } | { kind: 'room'; room: Room }
/** Every section the open conversation can be, teammate threads included. */
export const SECTIONS_QUERY = { include_archived: true, include_threads: true }
/** Every room, archived ones included, so Rooms can count them and restore one. */
export const ROOMS_QUERY = { include_archived: true }
/**
 * The bot's one chat when this list knows it for sure, never a teammate thread.
 * While a bot has more than one, or only an archived one, the daemon picks.
 */
export const defaultSection = (sections: Section[], bot: string) => {
  const chats = sections.filter(s => s.bot === bot && !s.peer_bot)
  return chats.length === 1 && !chats[0].archived_at ? chats[0] : undefined
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
