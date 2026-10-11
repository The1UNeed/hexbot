import type { Bot, Room, Section } from './types'
export type ChatRoute =
  { kind: 'section'; section: Section; bot: Bot } | { kind: 'room'; room: Room }
/** Every section the open conversation can be, teammate threads included. */
export const SECTIONS_QUERY = { include_archived: true, include_threads: true }
/** The thread a bot opens on when none is picked: its latest own one, never a teammate thread. */
export const defaultSection = (sections: Section[], bot: string) =>
  sections.find(s => s.bot === bot && !s.archived_at && !s.peer_bot)
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
