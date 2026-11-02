import type { Bot, Room, Rpc, Section } from './types'
export type ChatRoute =
  { kind: 'section'; section: Section; bot: Bot } | { kind: 'room'; room: Room }
/**
 * A section's purpose. A bot's recent sections never carry one from a daemon
 * from before one chat; the listed copy, marked by `listSections`, does.
 */
export const purposeOf = (s: Section, sections: Section[]) =>
  s.purpose ?? sections.find(listed => listed.id === s.id)?.purpose
/** The bot's chat with its owner: not a teammate thread or a section with its own purpose. */
export const ownerChat = (s: Section) => !s.peer_bot && !s.purpose
/**
 * Whether a stopped bot's failure shows in this section: the one it names, or
 * the bot's chat for a failure nothing else shows (`in_chat`), such as a dream's.
 */
export function stoppedIn(bot: Bot, section: Section): boolean {
  const detail = bot.status === 'stopped' ? bot.status_detail : null
  return Boolean(
    detail && (detail.section_id === section.id || (detail.in_chat && ownerChat(section)))
  )
}
/**
 * Sections as `hexbot.sections.list` returns them, with the Check-ins section
 * marked on a daemon with check-ins from before one chat per bot, which names
 * no purpose: its check-ins status names that section.
 */
export async function listSections(
  rpc: Rpc,
  params: Record<string, unknown>
): Promise<Section[]> {
  const { sections } = await rpc<{ sections: Section[] }>('hexbot.sections.list', params)
  if (!sections.length || sections.some(s => 'purpose' in s)) return sections
  const checkins = await rpc<{ section_id?: string | null }>('hexbot.checkins.status', {})
    .then(status => status.section_id ?? null)
    .catch(() => null)
  return sections.map(s => (s.id === checkins ? { ...s, purpose: 'checkins' } : s))
}
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
    .filter(s => s.bot === bot && !s.peer_bot && !s.purpose)
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
 * A bot tap resolves its owner chat. An older chooser can supply `chosen`;
 * an explicit teammate thread keeps its own route. A daemon with one
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
  // A Pulse question opens its actual thread, and a check-in its Check-ins,
  // without changing the owner-chat pick.
  if (chosen?.peer_bot || chosen?.purpose) return { section: chosen }
  if (oneChat) return { section: await create() }
  let section = chosen
  if (!section) {
    const sections = await listSections(rpc, { ...SECTIONS_QUERY, bot })
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
 * Where Pulse opens a busy bot: the room it reports while that room is not
 * archived, else the conversation between bots or Check-ins it reports while
 * that section is the bot's and runs the reported session. Otherwise no
 * section, so the bot's own chat opens.
 */
export function pulseTarget(
  bot: Bot,
  rooms: Room[],
  sections: Section[]
): { room: Room } | { section?: Section } {
  const detail = bot.status_detail
  const room = detail?.room_id
    ? rooms.find(r => r.id === detail.room_id && !r.archived_at)
    : undefined
  if (room) return { room }
  const section = sections.find(
    s =>
      s.id === detail?.section_id &&
      s.bot === bot.name &&
      (s.peer_bot || purposeOf(s, sections)) &&
      (!detail.session_id || !s.live_session_id || detail.session_id === s.live_session_id)
  )
  return { section }
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
    [...recent, ...sections]
      .filter(s => s.bot === bot && !s.peer_bot && !purposeOf(s, sections))
      .map(s => [s.id, s])
  )
  return chats.size === 1 ? [...chats.values()][0]!.preview || null : null
}
