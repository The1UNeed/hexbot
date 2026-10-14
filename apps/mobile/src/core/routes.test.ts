import { describe, it, expect } from 'vitest'
import {
  ROOMS_QUERY,
  SECTIONS_QUERY,
  defaultSection,
  isOpenRoom,
  rebind,
  shownRoom,
  type ChatRoute
} from './routes'
import type { Bot, Room, Section } from './types'
const bot = { name: 'ada', display_name: 'Ada' } as Bot
const section = (id: string, extra: Partial<Section> = {}) =>
  ({ id, bot: 'ada', title: id, ...extra }) as Section
describe('open conversation', () => {
  it('keeps a teammate thread open when the lists reload', () => {
    // The daemon lists teammate threads only when asked to.
    expect(SECTIONS_QUERY.include_threads).toBe(true)
    const thread = section('t', { peer_bot: 'grace' } as Partial<Section>)
    const route: ChatRoute = { kind: 'section', section: thread, bot }
    expect(rebind(route, { bots: [bot], rooms: [], sections: [section('a'), thread] })).toEqual(
      route
    )
    expect(rebind(route, { bots: [bot], rooms: [], sections: [section('a')] })).toBeNull()
  })
  it('opens a bot on its one chat, not a teammate thread', () => {
    const thread = section('t', { peer_bot: 'grace' } as Partial<Section>)
    expect(defaultSection([thread, section('mine')], 'ada')?.id).toBe('mine')
    // Two left from before, or an archived one: the daemon picks.
    expect(defaultSection([section('old'), section('mine')], 'ada')).toBeUndefined()
    expect(
      defaultSection([section('old', { archived_at: 1 } as Partial<Section>)], 'ada')
    ).toBeUndefined()
  })
})
describe('rooms', () => {
  const room = (id: string, last_activity_at: number, archived_at: number | null = null) =>
    ({ id, name: id, last_activity_at, archived_at, members: [] }) as unknown as Room
  const rooms = [room('old', 1), room('new', 3), room('shelved', 5, 9)]
  it('lists archived rooms so they can be counted and restored', () => {
    // The daemon leaves archived rooms out unless asked.
    expect(ROOMS_QUERY.include_archived).toBe(true)
    const route: ChatRoute = { kind: 'room', room: rooms[2] }
    expect(rebind(route, { bots: [], rooms, sections: [] })).toEqual(route)
  })
  it('shows the picked room, or the latest one that is not archived', () => {
    expect(shownRoom(rooms, 'old', null)).toBe('old')
    expect(shownRoom(rooms, null, null)).toBe('new')
    expect(shownRoom(rooms, 'gone', null)).toBe('new')
    // Archived here: Rooms moves on. Archived elsewhere while open: it stays to be restored.
    expect(shownRoom(rooms, 'shelved', null)).toBe('new')
    expect(shownRoom(rooms, 'shelved', 'shelved')).toBe('shelved')
    expect(shownRoom([rooms[2]], 'shelved', null)).toBeNull()
    // Opened before the lists reload, such as right after it is created.
    expect(shownRoom([rooms[0]], 'made', 'made')).toBe('made')
  })
  it('knows the open room', () => {
    const route: ChatRoute = { kind: 'room', room: rooms[0] }
    expect(isOpenRoom(route, 'old')).toBe(true)
    expect(isOpenRoom(route, 'new')).toBe(false)
    expect(isOpenRoom(null, 'old')).toBe(false)
  })
})
