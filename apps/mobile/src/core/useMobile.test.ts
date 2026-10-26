// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useMobile } from './useMobile'
import { pulseTarget } from './routes'
import type { Bot, Room, SavedDaemon, Section } from './types'

const state = vi.hoisted(() => ({
  request: vi.fn(),
  revoked: () => {},
  event: (_event: unknown) => {},
  ready: async () => {}
}))
vi.mock('react-native', () => ({
  AppState: { addEventListener: () => ({ remove() {} }) }
}))
vi.mock('expo-crypto', () => ({ randomUUID: () => 'message' }))
vi.mock('./storage', () => ({
  activeDaemonId: async () => null,
  loadDaemons: async () => [],
  loadToken: async () => 'token',
  selectDaemon: async () => {},
  forgetDaemon: async () => {},
  saveDaemon: async () => {}
}))
vi.mock('./transport', () => ({ pair: vi.fn() }))
// Push registration needs the native notifications module.
vi.mock('./push', () => ({ registerPush: vi.fn(async () => undefined) }))
vi.mock('./session', () => ({
  MobileSession: class {
    client = { connectionState: 'open', request: state.request }
    constructor(_daemon: unknown, _token: string, changed: (state: string) => void, ready: () => Promise<void>, event: (event: unknown) => void) {
      state.ready = ready
      state.event = event
      state.revoked = () => changed('revoked')
    }
    async connect() {}
    stop() {}
  }
}))

const bot = { name: 'owl', display_name: 'Owl' } as Bot
const other = { name: 'yak', display_name: 'Yak' } as Bot
const room = { id: 'room', name: 'Room', members: [] } as unknown as Room
const section = (id = 'chat', extra: Partial<Section> = {}) =>
  ({ id, bot: 'owl', live_session_id: `live-${id}`, archived_at: null, ...extra }) as Section
const daemon = { id: 'first', name: 'First' } as SavedDaemon
const deferred = <T = unknown>() => {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
let oneChat = true
let sections: Section[] = []
const reply = async (method: string, params: Record<string, unknown> = {}) => {
  if (method === 'hexbot.info') return { one_chat: oneChat }
  if (method === 'hexbot.bots.list') return { bots: [bot, other] }
  if (method === 'hexbot.rooms.list') return { rooms: [room] }
  if (method === 'hexbot.sections.list') return { sections }
  if (method === 'hexbot.sections.create')
    return { section: section(`${params.bot}-chat`, { bot: String(params.bot) }) }
  if (method === 'hexbot.sections.open')
    return { section: section(String(params.id)), messages: [] }
  if (method === 'hexbot.sections.unarchive') return { section: section(String(params.id)) }
  if (method === 'session.status') return { status: 'idle' }
  if (method === 'hexbot.rooms.log') return { events: [] }
  if (method === 'hexbot.rooms.get') return { room }
  return {}
}
/** Hold a real lookup boundary until the test navigates away. */
const pause = (method: string, matches = (_params: Record<string, unknown>) => true) => {
  const result = deferred()
  const called = deferred<void>()
  state.request.mockImplementation((name: string, params: Record<string, unknown> = {}) => {
    if (name === method && matches(params)) {
      called.resolve()
      return result.promise
    }
    return reply(name, params)
  })
  return { ...result, called: called.promise }
}
const connected = async () => {
  const hook = renderHook(() => useMobile())
  await act(async () => {
    await hook.result.current.activate(daemon, 'token')
  })
  await act(async () => {
    await hook.result.current.refresh()
  })
  return hook
}
beforeEach(() => {
  oneChat = true
  sections = []
  state.request.mockReset().mockImplementation(reply)
})
afterEach(cleanup)

describe('mobile navigation while a bot lookup waits', () => {
  it('keeps the later room when canonical resolution completes', async () => {
    const hook = await connected()
    const held = pause('hexbot.sections.create')
    let opening!: Promise<void>
    await act(async () => {
      opening = hook.result.current.openSection(bot)
      await held.called
    })
    await act(async () => {
      await hook.result.current.openRoom(room)
    })
    await act(async () => {
      held.resolve({ section: section() })
      await opening
    })
    expect(hook.result.current.route).toEqual({ kind: 'room', room })
    expect(state.request.mock.calls.some(([m]) => m === 'hexbot.sections.open')).toBe(false)
  })
  it('does not publish old choices after navigating to a room', async () => {
    oneChat = false
    const hook = await connected()
    const held = pause('hexbot.sections.list')
    let opening!: Promise<void>
    await act(async () => {
      opening = hook.result.current.openSection(bot)
      await held.called
    })
    await act(async () => {
      await hook.result.current.openRoom(room)
    })
    await act(async () => {
      held.resolve({
        sections: [section('a', { message_count: 2 }), section('b', { message_count: 2 })]
      })
      await opening
    })
    expect(hook.result.current.choosing).toBeNull()
    expect(hook.result.current.route?.kind).toBe('room')
  })
  it('keeps the latest bot when lookups finish in reverse order', async () => {
    const hook = await connected()
    const held = pause('hexbot.sections.create', p => p.bot === 'owl')
    let opening!: Promise<void>
    await act(async () => {
      opening = hook.result.current.openSection(bot)
      await held.called
    })
    await act(async () => {
      await hook.result.current.openSection(other)
    })
    await act(async () => {
      held.resolve({ section: section() })
      await opening
    })
    expect(hook.result.current.route).toMatchObject({
      kind: 'section',
      bot: other,
      section: { id: 'yak-chat' }
    })
  })
  it("does not clear a later navigation's loading state or show an obsolete error", async () => {
    const hook = await connected()
    const held = pause('hexbot.sections.create')
    let opening!: Promise<void>
    await act(async () => {
      opening = hook.result.current.openSection(bot)
      await held.called
    })
    const log = pause('hexbot.rooms.log')
    let roomOpening!: Promise<void>
    await act(async () => {
      roomOpening = hook.result.current.openRoom(room)
      await log.called
    })
    await act(async () => {
      held.reject(new Error('obsolete'))
      await opening
    })
    expect(hook.result.current.error).toBeNull()
    expect(hook.result.current.loading).toBe(true)
    await act(async () => {
      log.resolve({ events: [] })
      await roomOpening
    })
    expect(hook.result.current.loading).toBe(false)
  })
  it.each(['back', 'disconnect', 'remove', 'switch', 'revoke', 'cancel', 'unmount'] as const)(
    'invalidates a pending canonical lookup on %s',
    async action => {
      const hook = await connected()
      const held = pause('hexbot.sections.create')
      let opening!: Promise<void>
      await act(async () => {
        opening = hook.result.current.openSection(bot)
        await held.called
      })
      await act(async () => {
        if (action === 'back') hook.result.current.back()
        if (action === 'disconnect') await hook.result.current.disconnect()
        if (action === 'remove') await hook.result.current.remove(daemon.id)
        if (action === 'switch')
          await hook.result.current.activate({ ...daemon, id: 'second' }, 'token')
        if (action === 'revoke') state.revoked()
        if (action === 'cancel') hook.result.current.choose(null)
        if (action === 'unmount') hook.unmount()
      })
      await act(async () => {
        held.resolve({ section: section() })
        await opening
      })
      expect(state.request.mock.calls.some(([m]) => m === 'hexbot.sections.open')).toBe(false)
      if (action !== 'unmount') {
        expect(hook.result.current.route).toBeNull()
        expect(hook.result.current.error).toBeNull()
        expect(hook.result.current.loading).toBe(false)
      }
    }
  )
  it('cancels the complete info lookup before any create', async () => {
    const hook = renderHook(() => useMobile())
    await act(async () => {
      await hook.result.current.activate(daemon, 'token')
    })
    const held = pause('hexbot.info')
    let opening!: Promise<void>
    await act(async () => {
      opening = hook.result.current.openSection(bot)
      await held.called
    })
    act(() => hook.result.current.choose(null))
    await act(async () => {
      held.resolve({ one_chat: true })
      await opening
    })
    expect(state.request.mock.calls.some(([m]) => m === 'hexbot.sections.create')).toBe(false)
    expect(hook.result.current.loading).toBe(false)
  })
  it('does not create after an abandoned older-daemon list comes back empty', async () => {
    oneChat = false
    const hook = await connected()
    const held = pause('hexbot.sections.list')
    let opening!: Promise<void>
    await act(async () => {
      opening = hook.result.current.openSection(bot)
      await held.called
    })
    act(() => hook.result.current.choose(null))
    await act(async () => {
      held.resolve({ sections: [] })
      await opening
    })
    expect(state.request.mock.calls.some(([m]) => m === 'hexbot.sections.create')).toBe(false)
  })
  it('cancels choices without creation and remembers a successful archived pick', async () => {
    oneChat = false
    sections = [
      section('a', { message_count: 2 }),
      section('b', { message_count: 2, archived_at: 9 })
    ]
    const hook = await connected()
    await act(async () => {
      await hook.result.current.openSection(bot)
    })
    expect(hook.result.current.choosing?.choices).toHaveLength(2)
    act(() => hook.result.current.choose(null))
    expect(hook.result.current.route).toBeNull()
    await act(async () => {
      await hook.result.current.openSection(bot)
    })
    await act(async () => {
      await hook.result.current.openSection(bot, sections[1])
    })
    expect(hook.result.current.choosing).toBeNull()
    expect(hook.result.current.route).toMatchObject({
      kind: 'section',
      section: { id: 'b', archived_at: null }
    })
    act(() => hook.result.current.back())
    await act(async () => {
      await hook.result.current.openSection(bot)
    })
    expect(hook.result.current.choosing).toBeNull()
    expect(hook.result.current.route).toMatchObject({ kind: 'section', section: { id: 'b' } })
    expect(state.request.mock.calls.some(([m]) => m === 'hexbot.sections.create')).toBe(false)
  })
})

/** Open what Pulse opens for a bot, the way the app does, with the real hook. */
const pulse = (mobile: ReturnType<typeof useMobile>, selected: Bot) => {
  const target = pulseTarget(selected, mobile.rooms, mobile.sections)
  const pending =
    'room' in target ? mobile.openRoom(target.room) : mobile.openSection(selected, target.section)
  return { done: () => pending, room: () => ('room' in target ? target.room.id : null) }
}
const waiting = (id = 'thread') => ({ ...bot, status: 'needs_you', status_detail: { section_id: id, room_id: null } }) as Bot

describe('actual App Pulse callback and mobile conversation', () => {
  it.each(['approval', 'clarify'] as const)('opens the waiting peer thread and responds to its %s card', async kind => {
    const thread = section('thread', { peer_bot: 'yak' })
    sections = [section('owner'), thread]
    const hook = await connected()
    state.request.mockImplementation(async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'hexbot.sections.open') {
        const chosen = sections.find(s => s.id === params.id) ?? section(String(params.id))
        state.event({ type: kind === 'approval' ? 'approval.request' : 'clarify.request', session_id: chosen.live_session_id, payload: { request_id: 'pending', command: 'pwd', question: 'Which file?', qid: 'file', choices: ['once', 'deny'] } })
        return { section: chosen, messages: [] }
      }
      return reply(method, params)
    })
    await act(async () => { await pulse(hook.result.current, waiting()).done() })
    expect(hook.result.current.route).toMatchObject({ kind: 'section', section: { id: 'thread', peer_bot: 'yak' }, bot: { name: 'owl' } })
    const cards = kind === 'approval' ? hook.result.current.chat.approvals : hook.result.current.chat.questions
    expect(cards).toMatchObject([{ requestId: 'pending', sessionId: 'live-thread' }])
    await act(async () => {
      if (kind === 'approval') await hook.result.current.approval('pending', 'once')
      else await hook.result.current.answer('pending', 'file', 'answer')
    })
    expect(state.request).toHaveBeenCalledWith(kind === 'approval' ? 'approval.respond' : 'clarify.respond', expect.objectContaining({ session_id: 'live-thread', request_id: 'pending' }))
    expect(state.request.mock.calls.some(([m]) => m === 'hexbot.sections.create')).toBe(false)
  })
  it.each(['missing', 'wrong-bot', 'stale-session', 'no-detail'] as const)('keeps ordinary canonical selection for %s status metadata', async why => {
    sections = [section('thread', { peer_bot: 'yak', ...(why === 'wrong-bot' ? { bot: 'yak' } : {}), ...(why === 'stale-session' ? { live_session_id: 'older-live' } : {}) })]
    const hook = await connected()
    const selected = { ...waiting(why === 'missing' ? 'absent' : 'thread'), status_detail: { section_id: why === 'missing' ? 'absent' : 'thread', room_id: null, session_id: why === 'stale-session' ? 'new-live' : null }, ...(why === 'no-detail' ? { status_detail: null } : {}) } as Bot
    await act(async () => { await pulse(hook.result.current, selected).done() })
    expect(hook.result.current.route).toMatchObject({ section: { id: 'owl-chat' } })
  })
  it('gives an available room precedence and falls back from an archived room to the waiting thread', async () => {
    sections = [section('thread', { peer_bot: 'yak' })]
    const hook = await connected()
    const selected = { ...waiting(), status_detail: { section_id: 'thread', room_id: 'room' } } as Bot
    let opened!: ReturnType<typeof pulse>
    await act(async () => { opened = pulse(hook.result.current, selected); await opened.done() })
    expect(opened.room()).toBe('room')
    expect(state.request.mock.calls.some(([m]) => m === 'hexbot.sections.open')).toBe(false)
    hook.result.current.rooms[0]!.archived_at = 1
    await act(async () => { await pulse(hook.result.current, selected).done() })
    expect(hook.result.current.route).toMatchObject({ section: { id: 'thread' } })
  })
  it('opens an archived waiting thread without selecting it as the owner chat', async () => {
    sections = [section('thread', { peer_bot: 'yak', archived_at: 1 })]
    const hook = await connected()
    await act(async () => { await pulse(hook.result.current, waiting()).done() })
    expect(hook.result.current.route).toMatchObject({ section: { id: 'thread' } })
    expect(state.request.mock.calls.some(([m]) => m === 'hexbot.sections.create')).toBe(false)
    await act(async () => { await hook.result.current.openSection(bot) })
    expect(hook.result.current.route).toMatchObject({ section: { id: 'owl-chat' } })
  })
  it('ignores a waiting-thread history arriving after room navigation', async () => {
    sections = [section('thread', { peer_bot: 'yak' })]
    const hook = await connected()
    const held = pause('hexbot.sections.open', p => p.id === 'thread')
    let opening!: ReturnType<typeof pulse>
    await act(async () => { opening = pulse(hook.result.current, waiting()); await Promise.resolve() })
    // The exact-base callback opens the owner chat, which is the negative control.
    await act(async () => { await hook.result.current.openRoom(room) })
    await act(async () => { held.resolve({ section: sections[0], messages: [] }); await opening.done() })
    expect(hook.result.current.route?.kind).toBe('room')
  })
})

describe('legacy choices across daemon hydration', () => {
  it('clears an obsolete chooser and resolves a stale owner choice through the upgraded daemon', async () => {
    oneChat = false
    sections = [section('keep', { message_count: 2 }), section('removed', { message_count: 2 })]
    const hook = await connected()
    await act(async () => { await hook.result.current.openSection(bot) })
    const obsolete = hook.result.current.choosing!.choices[1]!
    oneChat = true
    sections = [section('owl-chat')]
    await act(async () => { await hook.result.current.refresh() })
    expect(hook.result.current.choosing).toBeNull()
    // Also guard a callback already queued by the native sheet before it disappeared.
    await act(async () => { await hook.result.current.openSection(bot, obsolete) })
    expect(hook.result.current.route).toMatchObject({ section: { id: 'owl-chat' } })
    expect(state.request).not.toHaveBeenCalledWith('hexbot.sections.open', { id: 'removed' })
  })
})

it.each(['daemon', 'back'] as const)('a Pulse thread open yields to later %s', async action => {
  sections = [section('thread', { peer_bot: 'yak' })]
  const hook = await connected()
  const held = pause('hexbot.sections.open', p => p.id === 'thread')
  let opening!: ReturnType<typeof pulse>
  await act(async () => { opening = pulse(hook.result.current, waiting()); await held.called })
  await act(async () => {
    if (action === 'daemon') await hook.result.current.activate({ ...daemon, id: 'second' }, 'token')
    else hook.result.current.back()
    held.resolve({ section: sections[0], messages: [], pending_clarify: { request_id: 'obsolete', question: 'Old question' } })
    await opening.done()
  })
  expect(hook.result.current.route).toBeNull()
  expect(hook.result.current.chat.questions).toHaveLength(0)
})

it('reconnect keeps Check-ins open on a daemon from before one chat', async () => {
  oneChat = false
  sections = [section('owl-chat', { message_count: 2 }), section('checkins', { message_count: 2 })]
  // That daemon names no purpose; its check-ins status names the section.
  state.request.mockImplementation(async (method: string, params: Record<string, unknown> = {}) =>
    method === 'hexbot.checkins.status' ? { section_id: 'checkins' } : reply(method, params))
  const hook = await connected()
  const listed = hook.result.current.sections.find(s => s.id === 'checkins')!
  expect(listed.purpose).toBe('checkins')
  await act(async () => { await hook.result.current.openSection(bot, listed) })
  expect(hook.result.current.route).toMatchObject({ section: { id: 'checkins', purpose: 'checkins' } })
  await act(async () => { await state.ready() })
  expect(hook.result.current.route).toMatchObject({ section: { id: 'checkins' } })
  expect(hook.result.current.choosing).toBeNull()
})
it('reconnect clears a legacy chooser even when capability is unchanged', async () => {
  oneChat = false
  sections = [section('a', { message_count: 2 }), section('b', { message_count: 2 })]
  const hook = await connected()
  await act(async () => { await hook.result.current.openSection(bot) })
  expect(hook.result.current.choosing).not.toBeNull()
  await act(async () => { await state.ready() })
  expect(hook.result.current.choosing).toBeNull()
  await act(async () => { await hook.result.current.openSection(bot) })
  expect(hook.result.current.choosing).not.toBeNull()
})
it('an older hydration reply cannot replace fresh canonical capability on the same connection', async () => {
  const hook = await connected()
  const older = pause('hexbot.info')
  let refresh!: ReturnType<ReturnType<typeof useMobile>['refresh']>
  await act(async () => { refresh = hook.result.current.refresh(); await older.called })
  state.request.mockImplementation(reply)
  await act(async () => { await hook.result.current.refresh() })
  await act(async () => { older.resolve({ one_chat: false }); await refresh })
  expect(hook.result.current.info?.one_chat).toBe(true)
  await act(async () => { await hook.result.current.openSection(bot, section('obsolete')) })
  expect(hook.result.current.route).toMatchObject({ section: { id: 'owl-chat' } })
})


it.each([true, false])('reconnect resolves the canonical owner chat after upgrade, old row survives: %s', async survives => {
  oneChat = false
  sections = [section('old', { message_count: 2 }), section('owl-chat', { message_count: 2 })]
  const hook = await connected()
  await act(async () => { await hook.result.current.openSection(bot, sections[0]) })
  oneChat = true
  if (!survives) sections = [sections[1]!]
  state.request.mockImplementation(async (method: string, params: Record<string, unknown> = {}) => method === 'hexbot.sections.open'
    ? { section: section(String(params.id)), messages: [{ role: 'assistant', text: `${params.id} history` }] }
    : reply(method, params))
  state.request.mockClear()
  await act(async () => { await state.ready() })
  const restored = hook.result.current.chat.messages.map(m => m.text)
  await act(async () => { await hook.result.current.send('Canonical reply') })
  expect(state.request).toHaveBeenCalledWith('prompt.submit', expect.objectContaining({ session_id: 'live-owl-chat' }))
  expect(state.request).toHaveBeenCalledWith('hexbot.sections.create', { bot: 'owl' })
  expect(state.request).not.toHaveBeenCalledWith('hexbot.sections.open', { id: 'old' })
  expect(hook.result.current.route).toMatchObject({ section: { id: 'owl-chat' } })
  expect(restored).toEqual(['owl-chat history'])
})


it.each(['room', 'peer', 'legacy', 'same-canonical'] as const)(
  'reconnect preserves the explicit %s control', async kind => {
    oneChat = kind !== 'legacy'
    sections = [section('owl-chat', { message_count: 2 }), section('other', { message_count: 2 }), section('peer', { peer_bot: 'yak', archived_at: 1 })]
    const hook = await connected()
    state.request.mockImplementation(async (method: string, params: Record<string, unknown> = {}) => method === 'hexbot.sections.open'
      ? { section: sections.find(s => s.id === params.id) ?? section(String(params.id)), messages: [] }
      : reply(method, params))
    if (kind === 'room') await act(async () => { await hook.result.current.openRoom(room) })
    else await act(async () => { await hook.result.current.openSection(bot, kind === 'peer' ? sections[2] : kind === 'legacy' ? sections[1] : undefined) })
    state.request.mockClear()
    await act(async () => { await state.ready() })
    if (kind === 'room') expect(hook.result.current.route).toMatchObject({ kind: 'room', room: { id: 'room' } })
    else expect(hook.result.current.route).toMatchObject({ section: { id: kind === 'peer' ? 'peer' : kind === 'legacy' ? 'other' : 'owl-chat' } })
    expect(state.request.mock.calls.filter(([method]) => method === 'hexbot.sections.create')).toHaveLength(kind === 'same-canonical' ? 1 : 0)
  }
)
it('holds owner input through reconnect lookup failure and retries the canonical lookup', async () => {
  sections = [section('owl-chat'), section('survivor')]
  const hook = await connected()
  await act(async () => { await hook.result.current.openSection(bot) })
  const held = pause('hexbot.sections.create')
  let reconnect!: Promise<void>
  await act(async () => { reconnect = state.ready(); await Promise.resolve() })
  expect(hook.result.current.liveSessionId()).toBeNull()
  await expect(hook.result.current.send('too early')).rejects.toThrow()
  await act(async () => { held.reject(new Error('Canonical lookup unavailable')); await reconnect.catch(() => {}) })
  expect(hook.result.current.error).toBe('Canonical lookup unavailable')
  const opened = state.request.mock.calls.filter(([method]) => method === 'hexbot.sections.open').length
  // App Retry and report reload both call this public history-sync callback.
  await act(async () => { await hook.result.current.syncChat() })
  expect(state.request.mock.calls.filter(([method]) => method === 'hexbot.sections.open')).toHaveLength(opened)
  expect(hook.result.current.liveSessionId()).toBeNull()
  await expect(hook.result.current.send('still too early')).rejects.toThrow()
  state.request.mockImplementation(reply)
  await act(async () => { await state.ready() })
  expect(hook.result.current.liveSessionId()).toBe('live-owl-chat')
  await act(async () => { await hook.result.current.send('after retry') })
  expect(state.request).toHaveBeenCalledWith('prompt.submit', expect.objectContaining({ session_id: 'live-owl-chat', text: 'after retry' }))
  expect(state.request.mock.calls.some(([method, params]) => method === 'prompt.submit' && params.text.includes('early'))).toBe(false)
})
it.each(['room', 'bot', 'back', 'daemon', 'unmount'] as const)(
  'a held reconnect canonical reply yields to later %s', async action => {
    sections = [section('owl-chat'), section('survivor')]
    const hook = await connected()
    await act(async () => { await hook.result.current.openSection(bot) })
    const held = pause('hexbot.sections.create', p => p.bot === 'owl')
    let reconnect!: Promise<void>
    await act(async () => { reconnect = state.ready(); await Promise.resolve() })
    // Assert the reconnect actually reaches the canonical boundary.
    expect(state.request.mock.calls.filter(([method]) => method === 'hexbot.sections.create').length).toBeGreaterThan(1)
    await act(async () => {
      if (action === 'room') await hook.result.current.openRoom(room)
      if (action === 'bot') await hook.result.current.openSection(other)
      if (action === 'back') hook.result.current.back()
      if (action === 'daemon') await hook.result.current.activate({ ...daemon, id: 'second' }, 'token')
      if (action === 'unmount') hook.unmount()
      held.resolve({ section: section('late-canonical') })
      await reconnect
    })
    expect(state.request).not.toHaveBeenCalledWith('hexbot.sections.open', { id: 'late-canonical' })
    if (action === 'room') expect(hook.result.current.route?.kind).toBe('room')
    if (action === 'bot') expect(hook.result.current.route).toMatchObject({ section: { id: 'yak-chat' } })
    if (action === 'back' || action === 'daemon') expect(hook.result.current.route).toBeNull()
  }
)


it.each(['history', 'status'] as const)('reconnect publishes no write ID until canonical %s is restored', async boundary => {
  sections = [section('owl-chat')]
  const hook = await connected()
  await act(async () => { await hook.result.current.openSection(bot) })
  const held = pause(boundary === 'history' ? 'hexbot.sections.open' : 'session.status')
  let reconnect!: Promise<void>
  await act(async () => { reconnect = state.ready(); await held.called })
  expect(hook.result.current.liveSessionId()).toBeNull()
  await expect(hook.result.current.send('premature')).rejects.toThrow()
  await act(async () => {
    held.resolve(boundary === 'history' ? { section: section('owl-chat'), messages: [{ role: 'assistant', text: 'Canonical history' }] } : { status: 'idle' })
    await reconnect
  })
  expect(hook.result.current.liveSessionId()).toBe('live-owl-chat')
  expect(state.request.mock.calls.some(([method]) => method === 'prompt.submit')).toBe(false)
})
it('reconnect hydration yields to room navigation before any canonical or stale history RPC', async () => {
  sections = [section('owl-chat')]
  const hook = await connected()
  await act(async () => { await hook.result.current.openSection(bot) })
  state.request.mockClear()
  const held = pause('hexbot.info')
  let reconnect!: Promise<void>
  await act(async () => { reconnect = state.ready(); await held.called })
  await act(async () => { await hook.result.current.openRoom(room) })
  await act(async () => { held.resolve({ one_chat: true }); await reconnect })
  expect(hook.result.current.route?.kind).toBe('room')
  expect(state.request.mock.calls.some(([method]) => method === 'hexbot.sections.create' || method === 'hexbot.sections.open')).toBe(false)
  expect(state.request.mock.calls.filter(([method]) => method === 'hexbot.rooms.log')).toHaveLength(1)
})
it('a superseded reconnect hydration cannot open an ordinary row with older capability', async () => {
  sections = [section('owl-chat'), section('survivor')]
  const hook = await connected()
  await act(async () => { await hook.result.current.openSection(bot) })
  const held = pause('hexbot.info')
  let reconnect!: Promise<void>
  await act(async () => { reconnect = state.ready(); await held.called })
  state.request.mockImplementation(reply)
  await act(async () => { await hook.result.current.refresh() })
  state.request.mockClear()
  await act(async () => { held.resolve({ one_chat: false }); await reconnect })
  expect(hook.result.current.info?.one_chat).toBe(true)
  expect(hook.result.current.liveSessionId()).toBeNull()
  expect(hook.result.current.error).toMatch(/Retry/)
  expect(state.request.mock.calls.some(([method]) => method === 'hexbot.sections.open' || method === 'hexbot.sections.unarchive')).toBe(false)
  await act(async () => { await state.ready() })
  expect(hook.result.current.liveSessionId()).toBe('live-owl-chat')
})


it('an obsolete legacy sheet answer cannot change a later room after reconnect', async () => {
  oneChat = false
  sections = [section('a', { message_count: 2 }), section('b', { message_count: 2 })]
  const hook = await connected()
  await act(async () => { await hook.result.current.openSection(bot) })
  const oldChoose = hook.result.current.choose
  const oldChoice = hook.result.current.choosing!.choices[1]!
  await act(async () => { await state.ready() })
  await act(async () => { await hook.result.current.openRoom(room) })
  state.request.mockClear()
  await act(async () => { oldChoose(oldChoice) })
  expect(hook.result.current.route?.kind).toBe('room')
  expect(state.request.mock.calls.some(([method]) => method === 'hexbot.sections.unarchive' || method === 'hexbot.sections.open' || method === 'hexbot.sections.create')).toBe(false)
})

it('a question replayed while the chat loads keeps the answers the read has', async () => {
  const hook = await connected()
  const held = pause('hexbot.sections.open')
  let opening!: Promise<unknown>
  await act(async () => { opening = hook.result.current.openSection(bot); await held.called })
  const questions = [{ qid: 'q1', question: 'Colour?' }, { qid: 'q2', question: 'Shape?' }]
  await act(async () => {
    // The original card, then a read taken after the first answer.
    state.event({ type: 'clarify.request', session_id: 'live-owl-chat', payload: { request_id: 'batch', questions } })
    held.resolve({ section: section('owl-chat'), messages: [], pending_clarify: { request_id: 'batch', questions, answers: { q1: 'red' } } })
    await opening
  })
  expect(hook.result.current.chat.questions.map(q => q.questions.map(question => question.id))).toEqual([['q2']])
})

it.each(['clarify.resolved', 'clarify.expire'])('a question settled by %s while the chat loads stays settled', async type => {
  const hook = await connected()
  const held = pause('hexbot.sections.open')
  let opening!: Promise<unknown>
  await act(async () => { opening = hook.result.current.openSection(bot); await held.called })
  // The snapshot still names the question; another app answered it, or the bot stopped waiting, meanwhile.
  await act(async () => {
    state.event({ type, session_id: 'live-owl-chat', payload: { request_id: 'q1', answers: { q1: 'red' } } })
    held.resolve({ section: section('owl-chat'), messages: [], pending_clarify: { request_id: 'q1', question: 'Colour?' } })
    await opening
  })
  expect(hook.result.current.route).toMatchObject({ section: { id: 'owl-chat' } })
  expect(hook.result.current.chat.questions).toEqual([])
})

it("keeps the bots' computer current from its events without reloading everything", async () => {
  const hook = await connected()
  const running = {
    activity: null,
    actor: null,
    available: true,
    control: 'bot',
    cursors: [],
    error: null,
    state: 'running'
  }
  state.request.mockImplementation(async (method: string, params: Record<string, unknown> = {}) =>
    method === 'hexbot.computer.status' ? running : reply(method, params)
  )
  await act(async () => {
    await hook.result.current.computerCall()
  })
  state.request.mockClear()
  await act(async () => {
    state.event({
      type: 'hexbot.computer.changed',
      payload: {
        actor: 'owl',
        activity: 'click',
        cursors: [{ action: 'click', at: 1, bot: 'owl', x: 0.5, y: 0.25 }]
      }
    })
    await new Promise(resolve => setTimeout(resolve, 300))
  })
  expect(hook.result.current.computer).toMatchObject({
    actor: 'owl',
    available: true,
    cursors: [{ bot: 'owl', x: 0.5, y: 0.25 }]
  })
  // A computer event comes with every bot action; it reloads nothing.
  expect(state.request).not.toHaveBeenCalled()
})
