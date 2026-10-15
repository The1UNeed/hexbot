import { describe, it, expect } from 'vitest'
import {
  ROOMS_QUERY,
  SECTIONS_QUERY,
  botChat,
  chatPreview,
  isOpenRoom,
  rebind,
  shownRoom,
  type ChatRoute
} from './routes'
import type { Bot, Room, Rpc, Section } from './types'
const bot = { name: 'ada', display_name: 'Ada' } as Bot
const section = (id: string, extra: Partial<Section> = {}) =>
  ({ id, bot: 'ada', title: id, archived_at: null, ...extra }) as Section
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
})
describe("a bot's chat", () => {
  const said = (id: string, extra: Partial<Section> = {}) =>
    section(id, { message_count: 3, updated_at: 1, ...extra } as Partial<Section>)
  /** A daemon listing `sections`, recording each call. */
  const daemon = (sections: Section[], fail?: string) => {
    const calls: [string, Record<string, unknown>?][] = []
    const rpc = (async (method: string, params?: Record<string, unknown>) => {
      calls.push([method, params])
      if (method === fail) throw new Error('daemon unavailable')
      if (method === 'hexbot.sections.list') return { sections }
      if (method === 'hexbot.sections.unarchive')
        return { section: { ...sections.find(s => s.id === params?.id), archived_at: null } }
      return { section: section('made') }
    }) as Rpc
    return { calls, rpc, methods: () => calls.map(([method]) => method) }
  }
  it('is the one a daemon with one chat per bot names, whatever this app lists', async () => {
    // Its only section may be one recovery set aside: the daemon makes a new chat.
    const { methods, rpc } = daemon([said('set-aside')])
    expect(await botChat(rpc, 'ada', true, new Map())).toEqual({ section: section('made') })
    expect(methods()).toEqual(['hexbot.sections.create'])
  })
  it('is asked for on an older daemon rather than guess which section is its Dreams log', async () => {
    // A real conversation, and a newer log the user renamed: the list cannot tell them apart.
    const sections = [
      said('night', { title: 'Night notes', updated_at: 9 }),
      said('trip', { title: 'Trip', updated_at: 5 }),
      section('empty', { message_count: 0, updated_at: 10 } as Partial<Section>),
      said('thread', { peer_bot: 'grace', updated_at: 11 } as Partial<Section>)
    ]
    const { calls, methods, rpc } = daemon(sections)
    const picked = new Map<string, string>()
    const found = await botChat(rpc, 'ada', false, picked)
    expect('choices' in found && found.choices.map(s => s.id)).toEqual(['night', 'trip'])
    expect(calls[0]).toEqual(['hexbot.sections.list', { ...SECTIONS_QUERY, bot: 'ada' }])
    // The one picked is the chat from then on, while the app runs.
    expect(await botChat(rpc, 'ada', false, picked, sections[1])).toEqual({ section: sections[1] })
    expect(await botChat(rpc, 'ada', false, picked)).toEqual({ section: sections[1] })
    expect(methods()).not.toContain('hexbot.sections.create')
    // So is a conversation the user named Dreams beside another.
    const named = said('named', { title: 'Dreams', title_by: null, updated_at: 7 })
    const both = await botChat(daemon([named, sections[1]!]).rpc, 'ada', false, new Map())
    expect('choices' in both && both.choices.map(s => s.id)).toEqual(['named', 'trip'])
  })
  it('is the one section with something said on an older daemon, made only for none', async () => {
    const dreams = said('dreams', { title: 'Dreams', updated_at: 2 })
    const empty = section('empty', { message_count: 0, updated_at: 9 } as Partial<Section>)
    const open = (sections: Section[]) => botChat(daemon(sections).rpc, 'ada', false, new Map())
    expect(await open([dreams, empty])).toEqual({ section: dreams })
    expect(await open([empty])).toEqual({ section: empty })
    const none = daemon([said('other', { bot: 'grace' })])
    expect(await botChat(none.rpc, 'ada', false, new Map())).toEqual({ section: section('made') })
    expect(none.methods()).toEqual(['hexbot.sections.list', 'hexbot.sections.create'])
  })
  it('comes out of the archive to take messages, or fails without a new section', async () => {
    const archived = said('trip', { archived_at: 5 })
    const ok = daemon([archived])
    // The chat screen shows the composer only for a section that is not archived.
    const found = await botChat(ok.rpc, 'ada', false, new Map())
    expect(found).toEqual({ section: { ...archived, archived_at: null } })
    expect(ok.calls.at(-1)).toEqual(['hexbot.sections.unarchive', { id: 'trip' }])
    // Picked from the choices too.
    const picked = await botChat(ok.rpc, 'ada', false, new Map(), archived)
    expect(picked).toEqual({ section: { ...archived, archived_at: null } })
    const failing = daemon([archived], 'hexbot.sections.unarchive')
    await expect(botChat(failing.rpc, 'ada', false, new Map())).rejects.toThrow(
      'daemon unavailable'
    )
    expect(failing.methods()).not.toContain('hexbot.sections.create')
  })
  it.each([null, 5])(
    'persists an explicit older pick even when already open, archived_at=%s',
    async archived_at => {
      const old = said('old', { archived_at, title: 'Trip' })
      const newer = said('new', { updated_at: 9 })
      const api = daemon([old, newer])
      const picked = new Map<string, string>()
      expect(await botChat(api.rpc, 'ada', false, picked, old)).toEqual({
        section: { ...old, archived_at: null }
      })
      expect(api.calls).toEqual([['hexbot.sections.unarchive', { id: 'old' }]])
      expect(picked.get('ada')).toBe('old')
      // A new client asks again; it never invents a chat or a remembered choice.
      expect(await botChat(api.rpc, 'ada', false, new Map())).toHaveProperty('choices')
      expect(api.methods()).not.toContain('hexbot.sections.create')
    }
  )
  it('does not remember an unarchived pick when persisting it fails', async () => {
    const sections = [said('old'), said('new', { updated_at: 9 })]
    const failing = daemon(sections, 'hexbot.sections.unarchive')
    const picked = new Map<string, string>()
    await expect(botChat(failing.rpc, 'ada', false, picked, sections[0])).rejects.toThrow(
      'daemon unavailable'
    )
    expect(picked.size).toBe(0)
    const retry = daemon(sections)
    expect(await botChat(retry.rpc, 'ada', false, picked)).toHaveProperty('choices')
    expect(retry.methods()).not.toContain('hexbot.sections.create')
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

describe('bot card preview', () => {
  it('omits an ambiguous quote when a newer unavailable row precedes the older canonical chat', () => {
    const healthy = section('healthy', { preview: 'Ongoing conversation', message_count: 2, updated_at: 1 })
    const unavailable = section('quarantined', { preview: 'Unavailable history', message_count: 4, updated_at: 9 })
    expect(chatPreview('ada', [unavailable, healthy], [unavailable])).toBeNull()
    expect(chatPreview('ada', [healthy], [unavailable])).toBeNull()
  })
  it('keeps ordinary singleton previews, recent-list fallback, and ignores teammate threads', () => {
    const chat = section('chat', { preview: 'Ongoing conversation' })
    const thread = section('thread', { peer_bot: 'grace', preview: 'Teammate question' })
    expect(chatPreview('ada', [chat, thread], [chat])).toBe('Ongoing conversation')
    expect(chatPreview('ada', [], [chat])).toBe('Ongoing conversation')
    expect(chatPreview('ada', [{ ...chat, preview: 'Latest message' }], [chat])).toBe('Latest message')
    expect(chatPreview('ada', [thread])).toBeNull()
    expect(chatPreview('ada', [])).toBeNull()
  })
})
