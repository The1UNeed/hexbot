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
  ready: async () => {},
  connectionState: 'open' as 'open' | 'closed',
  session: null as null | { client: { connectionState: string } }
}))
const appState = vi.hoisted(() => ({
  currentState: 'active',
  listeners: new Set<(next: string) => void>(),
  addEventListener: (_type: string, cb: (next: string) => void) => {
    appState.listeners.add(cb)
    return {
      remove() {
        appState.listeners.delete(cb)
      }
    }
  },
  emit(next: string) {
    appState.currentState = next
    for (const cb of [...appState.listeners]) cb(next)
  }
}))
vi.mock('react-native', () => ({ AppState: appState }))
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
    #ready: () => Promise<void>
    constructor(_daemon: unknown, _token: string, changed: (state: string) => void, ready: () => Promise<void>, event: (event: unknown) => void) {
      this.#ready = ready
      state.ready = ready
      state.event = event
      state.revoked = () => changed('revoked')
      state.session = this
    }
    async connect() {
      const wasClosed = this.client.connectionState !== 'open'
      this.client.connectionState = 'open'
      if (wasClosed) await this.#ready()
    }
    suspend() {
      this.client.connectionState = 'closed'
    }
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
  it('keeps a chat opening until its history arrives', async () => {
    const hook = await connected()
    const held = pause('hexbot.sections.open')
    let opening!: Promise<void>
    await act(async () => {
      opening = hook.result.current.openSection(bot)
      await held.called
    })
    expect(hook.result.current.route).toMatchObject({ kind: 'section', section: { id: 'owl-chat' } })
    expect(hook.result.current.opening).toBe(true)
    state.request.mockImplementation(reply)
    await act(async () => {
      held.resolve(await reply('hexbot.sections.open', { id: 'owl-chat' }))
      await opening
    })
    expect(hook.result.current.opening).toBe(false)
  })
  it('opens a chat the daemon named on this connection without waiting for it again', async () => {
    const hook = await connected()
    await act(async () => { await hook.result.current.openSection(bot) })
    await act(async () => { await hook.result.current.openRoom(room) })
    const held = pause('hexbot.sections.create')
    await act(async () => { await hook.result.current.openSection(bot) })
    expect(hook.result.current.route).toMatchObject({ kind: 'section', section: { id: 'owl-chat' } })
    expect(state.request).toHaveBeenCalledWith('hexbot.sections.open', { id: 'owl-chat' })
    // The daemon may still name another chat; the tap moves there.
    await act(async () => {
      held.resolve({ section: section('moved') })
      await held.promise
    })
    await vi.waitFor(() => expect(hook.result.current.route).toMatchObject({ section: { id: 'moved' } }))
  })
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
  expect(state.request).toHaveBeenCalledWith('prompt.submit', expect.objectContaining({ session_id: 'live-owl-chat', text: 'after retry', interrupt: true }))
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

describe('recall and closing an error in a bot chat', () => {
  const daemonWith = (bots: Bot[]) =>
    state.request.mockImplementation(async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'hexbot.info') return { one_chat: true, transcript_identity: true, recall: true }
      if (method === 'hexbot.bots.list') return { bots }
      if (method === 'session.recall') return { recalled: true, text: 'Hello' }
      return reply(method, params)
    })
  const chat = async (bots: Bot[] = [bot]) => {
    daemonWith(bots)
    const hook = await connected()
    await act(async () => { await hook.result.current.openSection(bot) })
    return hook
  }

  it('sends with an input id and recalls that message by it', async () => {
    const hook = await chat()
    await act(async () => { await hook.result.current.send('Hello') })
    expect(state.request).toHaveBeenCalledWith('prompt.submit', expect.objectContaining({ session_id: 'live-owl-chat', text: 'Hello', input_id: 'message' }))
    expect(hook.result.current.chat.messages).toMatchObject([{ id: 'message', role: 'user', inputId: 'message' }])
    let text: string | null = null
    await act(async () => { text = await hook.result.current.recall('message') })
    expect(text).toBe('Hello')
    expect(state.request).toHaveBeenCalledWith('session.recall', { session_id: 'live-owl-chat', input_id: 'message' })
    expect(hook.result.current.chat.messages).toEqual([])
    expect(hook.result.current.chat.busy).toBe(false)
  })

  it('keeps a running reply working when a follow-up is refused', async () => {
    const hook = await chat()
    act(() => state.event({ type: 'message.start', session_id: 'live-owl-chat', payload: {} }))
    state.request.mockImplementation(async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'prompt.submit') throw Object.assign(new Error('attachment not found: gone; attach it again'), { code: 4204 })
      return reply(method, params)
    })
    await act(async () => { await hook.result.current.send('Use this file').catch(() => {}) })
    expect(hook.result.current.chat.busy).toBe(true)
    expect(hook.result.current.chat.messages).toEqual([])
    act(() => state.event({ type: 'message.complete', session_id: 'live-owl-chat', payload: { text: 'Done' } }))
    expect(hook.result.current.chat.busy).toBe(false)
  })

  it('keeps a reply that was running when the chat opened working when a follow-up is refused', async () => {
    daemonWith([bot])
    const base = state.request.getMockImplementation()!
    state.request.mockImplementation(async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'hexbot.sections.open')
        return { ...(await reply(method, params)), busy: true, messages: [{ role: 'user', content: 'Write an essay' }] }
      if (method === 'prompt.submit') throw Object.assign(new Error('session is compacting'), { code: 4002 })
      return base(method, params)
    })
    const hook = await connected()
    await act(async () => { await hook.result.current.openSection(bot) })
    expect(hook.result.current.chat.busy).toBe(true)
    await act(async () => { await hook.result.current.send('/compact').catch(() => {}) })
    expect(hook.result.current.chat.busy).toBe(true)
    act(() => state.event({ type: 'message.complete', session_id: 'live-owl-chat', payload: { text: 'Bridges are' } }))
    act(() => state.event({ type: 'status.update', session_id: 'live-owl-chat', payload: { kind: 'idle', text: '' } }))
    expect(hook.result.current.chat.busy).toBe(false)
  })

  it('does not keep a finished turn working when a later message is refused', async () => {
    const hook = await chat()
    act(() => state.event({ type: 'message.start', session_id: 'live-owl-chat', payload: {} }))
    act(() => state.event({ type: 'status.update', session_id: 'live-owl-chat', payload: { kind: 'interrupted', text: '' } }))
    const base = state.request.getMockImplementation()!
    state.request.mockImplementation(async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'prompt.submit') throw Object.assign(new Error('attachment not found: gone; attach it again'), { code: 4204 })
      return base(method, params)
    })
    await act(async () => { await hook.result.current.send('Use this file').catch(() => {}) })
    expect(hook.result.current.chat.busy).toBe(false)
  })

  it('names a message from the history by its row when it has no input id', async () => {
    const hook = await chat()
    state.request.mockImplementation(async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'hexbot.sections.open') return { section: section('owl-chat'), messages: [{ role: 'user', row_id: 'pi-e1', text: 'Earlier' }] }
      if (method === 'session.recall') return { recalled: true, text: 'Earlier' }
      return reply(method, params)
    })
    await act(async () => { await hook.result.current.syncChat() })
    await act(async () => { await hook.result.current.recall('pi-e1') })
    expect(state.request).toHaveBeenCalledWith('session.recall', { session_id: 'live-owl-chat', row_id: 'pi-e1' })
  })

  it('closes the error, and the bot’s Stopped state when it is for this chat', async () => {
    const stopped = { ...bot, status: 'stopped', status_detail: { section_id: 'owl-chat' } } as Bot
    const hook = await chat([stopped])
    act(() => state.event({ type: 'message.complete', session_id: 'live-owl-chat', payload: { error: 'The model request failed' } }))
    expect(hook.result.current.chat.error).toBe('The model request failed')
    await act(async () => { await hook.result.current.dismissError() })
    expect(hook.result.current.chat.error).toBeNull()
    expect(state.request).toHaveBeenCalledWith('hexbot.bots.clear_status', { name: 'owl' })
  })

  it('marks a reply read as it lands on screen, so this phone is not woken about it', async () => {
    await chat()
    const reads = () => state.request.mock.calls.filter(([m]) => m === 'hexbot.sections.mark_read').length
    const before = reads()
    act(() => state.event({ type: 'message.complete', session_id: 'live-owl-chat', payload: { text: 'Done.' } }))
    expect(reads()).toBe(before + 1)
    expect(state.request).toHaveBeenLastCalledWith('hexbot.sections.mark_read', { id: 'owl-chat' })
    // In the background the reply stays unread for the push.
    appState.currentState = 'background'
    act(() => state.event({ type: 'message.complete', session_id: 'live-owl-chat', payload: { text: 'Again.' } }))
    appState.currentState = 'active'
    expect(reads()).toBe(before + 1)
  })

  it('leaves a reply unread while a page covers the chat, and reads it when the page closes', async () => {
    const hook = await chat()
    const reads = () => state.request.mock.calls.filter(([m]) => m === 'hexbot.sections.mark_read').length
    const before = reads()
    act(() => hook.result.current.setChatCovered(true))
    act(() => state.event({ type: 'message.complete', session_id: 'live-owl-chat', payload: { text: 'Done.' } }))
    expect(reads()).toBe(before)
    act(() => hook.result.current.setChatCovered(false))
    expect(reads()).toBe(before + 1)
    expect(state.request).toHaveBeenLastCalledWith('hexbot.sections.mark_read', { id: 'owl-chat' })
  })

  it('leaves the bot’s state alone when the error is not a Stopped state here', async () => {
    const hook = await chat()
    act(() => state.event({ type: 'message.complete', session_id: 'live-owl-chat', payload: { error: 'The turn was interrupted' } }))
    await act(async () => { await hook.result.current.dismissError() })
    expect(hook.result.current.chat.error).toBeNull()
    expect(state.request.mock.calls.some(([m]) => m === 'hexbot.bots.clear_status')).toBe(false)
  })

  it('clears the open chat error when hexbot.bots.changed reports its section resolved', async () => {
    const stopped = { ...bot, status: 'stopped', status_detail: { section_id: 'owl-chat' } } as Bot
    const hook = await chat([stopped])
    act(() =>
      state.event({
        type: 'message.complete',
        session_id: 'live-owl-chat',
        payload: { error: 'Codex error: The usage limit has been reached' }
      })
    )
    expect(hook.result.current.chat.error).toBe('Codex error: The usage limit has been reached')
    act(() =>
      state.event({
        type: 'hexbot.bots.changed',
        payload: { resolved_incidents: ['inc-1'], resolved_sections: ['owl-chat'] }
      })
    )
    expect(hook.result.current.chat.error).toBeNull()
  })

  it('triggers provider recovery after reconnecting from background only when a bot is stopped', async () => {
    const stopped = { ...bot, status: 'stopped', status_detail: { section_id: 'owl-chat' } } as Bot
    await chat([stopped])
    const recoveryCalls = () =>
      state.request.mock.calls.filter(([m]) => m === 'hexbot.providers.check_recovery').length

    // Initial onReady after cold connect fires once because a bot is stopped.
    await act(async () => {
      await state.ready()
    })
    expect(recoveryCalls()).toBe(1)

    // Going to background suspends (closes) the socket; returning active reconnects and triggers once open.
    await act(async () => {
      appState.emit('background')
    })
    expect(state.session?.client.connectionState).toBe('closed')
    await act(async () => {
      appState.emit('active')
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(state.session?.client.connectionState).toBe('open')
    expect(recoveryCalls()).toBe(2)

    // Returning from inactive while socket stayed open also triggers once.
    await act(async () => {
      appState.emit('inactive')
      appState.emit('active')
    })
    expect(recoveryCalls()).toBe(3)

    // Once all bots are idle, foregrounding does not trigger recovery.
    daemonWith([{ ...bot, status: 'idle' } as Bot])
    await act(async () => {
      appState.emit('background')
    })
    await act(async () => {
      appState.emit('active')
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(recoveryCalls()).toBe(3)
  })
})


describe('mobile history critical path', () => {
  it.each([true, false])('uses sections.open busy=%s without session.status or a read-receipt wait', async busy => {
    const hook = await connected()
    const read = deferred()
    state.request.mockImplementation((method: string, params: Record<string, unknown> = {}) => {
      if (method === 'hexbot.sections.open') return Promise.resolve({ section: section('owl-chat'), messages: [{ row_id: 'history', role: 'assistant', text: 'Loaded' }], busy })
      if (method === 'hexbot.sections.mark_read') return read.promise
      return reply(method, params)
    })
    await act(async () => { await hook.result.current.openSection(bot) })
    expect(hook.result.current.chat.messages).toMatchObject([{ text: 'Loaded' }])
    expect(hook.result.current.chat.busy).toBe(busy)
    expect(hook.result.current.opening).toBe(false)
    expect(hook.result.current.loading).toBe(false)
    expect(state.request.mock.calls.some(([m]) => m === 'session.status')).toBe(false)
    await act(async () => { read.reject(new Error('read receipt failed')); await Promise.resolve() })
    expect(hook.result.current.error).toBeNull()
  })

  it('still reads session.status on older daemons and never publishes a stale snapshot', async () => {
    const hook = await connected()
    const status = pause('session.status')
    let opening!: Promise<void>
    await act(async () => { opening = hook.result.current.openSection(bot); await status.called })
    await act(async () => { await hook.result.current.openRoom(room) })
    await act(async () => { status.resolve({ status: 'working' }); await opening })
    expect(hook.result.current.route?.kind).toBe('room')
    expect(hook.result.current.chat.busy).toBe(false)
    expect(state.request).not.toHaveBeenCalledWith('hexbot.sections.mark_read', { id: 'owl-chat' })
  })

  it('leaves a room message unread while the room is covered, and reads it when it is back', async () => {
    const hook = await connected()
    await act(async () => { await hook.result.current.openRoom(room) })
    const reads = () => state.request.mock.calls.filter(([m, p]) => m === 'hexbot.rooms.mark_read' && p.seq === 4).length
    act(() => hook.result.current.setChatCovered(true))
    act(() => state.event({ type: 'hexbot.rooms.event', payload: { room_id: 'room', event: { room_id: 'room', seq: 4, kind: 'message.user', actor_kind: 'human', actor_id: 'local', payload: { text: 'Behind the page' } } } }))
    expect(reads()).toBe(0)
    act(() => hook.result.current.setChatCovered(false))
    expect(reads()).toBe(1)
  })

  it('starts room metadata alongside its log and finishes opening before the read receipt', async () => {
    const hook = await connected()
    const log = pause('hexbot.rooms.log')
    const read = deferred()
    const request = state.request.getMockImplementation()!
    state.request.mockImplementation((method: string, params: Record<string, unknown> = {}) =>
      method === 'hexbot.rooms.mark_read' ? read.promise : request(method, params)
    )
    let opening!: Promise<void>
    await act(async () => { opening = hook.result.current.openRoom(room); await log.called })
    expect(state.request).toHaveBeenCalledWith('hexbot.rooms.get', { id: 'room' })
    await act(async () => {
      log.resolve({ events: [{ room_id: 'room', seq: 3, kind: 'message.user', actor_kind: 'human', actor_id: 'local', payload: { text: 'Room history' } }] })
      await opening
    })
    expect(hook.result.current.chat.messages).toMatchObject([{ text: 'Room history' }])
    expect(hook.result.current.loading).toBe(false)
    await act(async () => { read.reject(new Error('receipt failed')); await Promise.resolve() })
    expect(hook.result.current.error).toBeNull()
  })
})
describe('switching to a bot read ahead', () => {
  let install = 'first-daemon'
  const said = (text: string) => ({ role: 'assistant', row_id: text, text })
  const ahead = async (method: string, params: Record<string, unknown> = {}) => {
    if (method === 'hexbot.info') return { one_chat: true, section_history: true, install_id: install }
    if (method === 'hexbot.sections.history' || method === 'hexbot.sections.open')
      return {
        ...(method === 'hexbot.sections.open' && { section: section(String(params.id)) }),
        messages: [said(`${install} ${params.id}`)],
        history_cursor: `${install}:1`,
        history_delta: false
      }
    return reply(method, params)
  }
  const historyReads = () => state.request.mock.calls.filter(([name]) => name === 'hexbot.sections.history')
  beforeEach(() => {
    install = 'first-daemon'
    state.request.mockImplementation(ahead)
  })

  it('reads only the first few chats ahead after a cold start, since each read is a whole history', async () => {
    const many = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(name => ({ name, display_name: name }) as Bot)
    state.request.mockImplementation(async (method: string, params: Record<string, unknown> = {}) =>
      method === 'hexbot.bots.list' ? { bots: many } : ahead(method, params))
    await connected()
    await vi.waitFor(() => expect(historyReads().length).toBe(5))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(historyReads().map(([, params]) => params.id)).toEqual(['a-chat', 'b-chat', 'c-chat', 'd-chat', 'e-chat'])
  })

  it('shows the chat at once and opens it with the cursor of what it holds', async () => {
    const hook = await connected()
    await vi.waitFor(() => expect(historyReads().length).toBe(2))
    const held = pause('hexbot.sections.open')
    let opening!: Promise<void>
    await act(async () => {
      opening = hook.result.current.openSection(bot)
      await held.called
    })
    // Shown while the bot starts; sending still waits for the open.
    expect(hook.result.current.chat.messages.map(m => m.text)).toEqual(['first-daemon owl-chat'])
    expect(hook.result.current.opening).toBe(true)
    expect(state.request).toHaveBeenCalledWith('hexbot.sections.open', {
      id: 'owl-chat',
      history_cursor: 'first-daemon:1'
    })
    await act(async () => {
      held.resolve({ section: section('owl-chat'), messages: [said('new')], history_cursor: 'c2', history_delta: true })
      await opening
    })
    expect(hook.result.current.chat.messages.map(m => m.text)).toEqual(['first-daemon owl-chat', 'new'])
  })

  it('reads what a chat missed when you leave it after it changed, and never draws the older rows', async () => {
    const hook = await connected()
    await vi.waitFor(() => expect(historyReads().length).toBe(2))
    await act(async () => { await hook.result.current.openSection(bot) })
    // The bot answers while the chat is open.
    await act(async () => {
      state.event({ type: 'message.complete', session_id: 'live-owl-chat', payload: { text: 'Answer' } })
    })
    const missed = pause('hexbot.sections.history', params => params.id === 'owl-chat')
    await act(async () => { await hook.result.current.openRoom(room) })
    await missed.called
    expect(state.request).toHaveBeenCalledWith('hexbot.sections.history', {
      id: 'owl-chat',
      history_cursor: 'first-daemon:1'
    })
    // Back before that read lands: the held rows lack the answer, so none are drawn.
    const opened = pause('hexbot.sections.open')
    let opening!: Promise<void>
    await act(async () => {
      opening = hook.result.current.openSection(bot)
      await opened.called
    })
    expect(hook.result.current.chat.messages).toEqual([])
    await act(async () => {
      opened.resolve({ section: section('owl-chat'), messages: [said('Answer')], history_cursor: 'c2', history_delta: true })
      await opening
    })
    expect(hook.result.current.chat.messages.map(m => m.text)).toEqual(['first-daemon owl-chat', 'Answer'])
  })

  it('never shows or sends what it held for another daemon at the same address', async () => {
    const hook = await connected()
    await vi.waitFor(() => expect(historyReads().length).toBe(2))
    install = 'second-daemon'
    const reconnected = deferred<void>()
    // The other daemon's own read ahead waits, so only the held rows could show.
    state.request.mockImplementation((method: string, params: Record<string, unknown> = {}) =>
      method === 'hexbot.sections.history' ? reconnected.promise : ahead(method, params))
    await act(async () => { await state.ready() })
    const held = pause('hexbot.sections.open')
    let opening!: Promise<void>
    await act(async () => {
      opening = hook.result.current.openSection(bot)
      await held.called
    })
    expect(hook.result.current.chat.messages).toEqual([])
    expect(state.request).toHaveBeenLastCalledWith('hexbot.sections.open', { id: 'owl-chat' })
    await act(async () => {
      held.resolve({ section: section('owl-chat'), messages: [said('second')], history_cursor: 's1', history_delta: false })
      await opening
    })
    expect(hook.result.current.chat.messages.map(m => m.text)).toEqual(['second'])
  })
})

describe('changes shown before the daemon answers', () => {
  it('pins and renames at once, and a list read before they settle keeps them', async () => {
    const hook = await connected()
    const pinned = pause('hexbot.bots.pin')
    let pinning!: Promise<unknown>
    await act(async () => {
      pinning = hook.result.current.change({ kind: 'bot', name: 'owl' }, { pinned_at: 5 }, () =>
        hook.result.current.rpc('hexbot.bots.pin', { name: 'owl', pinned: true })
      )
      await pinned.called
    })
    expect(hook.result.current.bots.find(b => b.name === 'owl')?.pinned_at).toBe(5)
    // An unrelated change refreshes the lists while the pin is on its way.
    await act(async () => {
      await hook.result.current.refresh()
    })
    expect(hook.result.current.bots.find(b => b.name === 'owl')?.pinned_at).toBe(5)
    state.request.mockImplementation(reply)
    await act(async () => {
      pinned.resolve({ bot: { ...bot, pinned_at: 5 } })
      await pinning
    })
    // The daemon's own list, read after it took the pin, has the last word.
    await act(async () => {
      await hook.result.current.refresh()
    })
    expect(hook.result.current.bots.find(b => b.name === 'owl')?.pinned_at).toBeUndefined()
  })
  it('puts the old name back when the daemon refuses it', async () => {
    const hook = await connected()
    state.request.mockImplementation((name: string, params: Record<string, unknown> = {}) =>
      name === 'hexbot.rooms.update' ? Promise.reject(new Error('Refused')) : reply(name, params)
    )
    let failure: unknown
    await act(async () => {
      failure = await hook.result.current
        .change({ kind: 'room', id: 'room' }, { name: 'Greenhouse' }, () =>
          hook.result.current.rpc('hexbot.rooms.update', { id: 'room', name: 'Greenhouse' })
        )
        .catch((e: unknown) => e)
    })
    expect(failure).toBeInstanceOf(Error)
    expect(hook.result.current.rooms.find(r => r.id === 'room')?.name).toBe('Room')
  })

  it('returns to the originating room when closing a peer thread opened from inside it', async () => {
    const hook = await connected()
    const peerThread = { ...section('th-peer'), peer_bot: 'fox', title: 'From Fox' }
    state.request.mockImplementation((name: string, params: Record<string, unknown> = {}) =>
      name === 'hexbot.sections.open' && params.id === 'th-peer'
        ? Promise.resolve({ section: peerThread, messages: [] })
        : reply(name, params)
    )
    await act(async () => {
      await hook.result.current.openRoom(room)
    })
    expect(hook.result.current.route).toMatchObject({ kind: 'room', room: { id: 'room' } })
    expect(hook.result.current.hasThreadReturn).toBe(false)

    await act(async () => {
      await hook.result.current.openSection(bot, peerThread)
    })
    expect(hook.result.current.route).toMatchObject({
      kind: 'section',
      section: { id: 'th-peer', peer_bot: 'fox' }
    })
    expect(hook.result.current.hasThreadReturn).toBe(true)

    // First back pops the peer thread and restores the originating room.
    await act(async () => {
      hook.result.current.back()
      await Promise.resolve()
    })
    expect(hook.result.current.route).toMatchObject({ kind: 'room', room: { id: 'room' } })
    expect(hook.result.current.hasThreadReturn).toBe(false)

    // Second back leaves the room back to the roster.
    act(() => {
      hook.result.current.back()
    })
    expect(hook.result.current.route).toBeNull()
  })

  it('honors an explicit archived sectionId without falling back, and cancels stale thread lookups on newer navigation', async () => {
    const archived = { ...section('saved-id'), archived_at: 100, peer_bot: 'other' }
    const replacement = { ...section('replacement-id'), archived_at: null, peer_bot: 'other' }
    sections = [archived, replacement]
    const hook = await connected()
    state.request.mockImplementation((name: string, params: Record<string, unknown> = {}) => {
      if (name === 'hexbot.sections.open' && params.id === 'saved-id') {
        return Promise.resolve({ section: archived, messages: [] })
      }
      if (name === 'hexbot.sections.open' && params.id === 'missing-id') {
        return Promise.reject(new Error('Section not found'))
      }
      return reply(name, params)
    })

    // 1. Explicit sectionId opens the archived section rather than replacement-id or owner chat.
    await act(async () => {
      await hook.result.current.openThread('owl', 'other', { sectionId: 'saved-id' })
    })
    expect(hook.result.current.route).toMatchObject({
      kind: 'section',
      section: { id: 'saved-id', archived_at: 100 }
    })

    // 2. Missing explicit sectionId sets an error and never falls back to replacement-id or owner chat.
    await act(async () => {
      await hook.result.current.openRoom(room)
    })
    await act(async () => {
      await hook.result.current.openThread('owl', 'other', { sectionId: 'missing-id' })
    })
    expect(hook.result.current.route).toMatchObject({ kind: 'room', room: { id: 'room' } })
    expect(hook.result.current.error).toBe('This conversation is no longer available.')

    // 3. A delayed uncached thread lookup yields to a newer room navigation and never corrupts returnStack.
    sections = []
    await act(async () => {
      await hook.result.current.refresh()
    })
    const held = pause('hexbot.sections.thread')
    let openingThread!: Promise<void>
    await act(async () => {
      openingThread = hook.result.current.openThread('owl', 'other')
      await held.called
    })
    const otherRoom = { ...room, id: 'room-2', name: 'Room 2' }
    state.request.mockImplementation((name: string, params: Record<string, unknown> = {}) =>
      name === 'hexbot.rooms.get' && params.id === 'room-2'
        ? Promise.resolve({ room: otherRoom })
        : reply(name, params)
    )
    await act(async () => {
      await hook.result.current.openRoom(otherRoom)
      held.resolve({ section: replacement })
      await openingThread
    })
    expect(hook.result.current.route).toMatchObject({ kind: 'room', room: { id: 'room-2' } })
    expect(hook.result.current.hasThreadReturn).toBe(false)
  })

  it('settles idle peer threads without looping, separates live exchanges, and preserves failed peer replies', async () => {
    const peerThread = { ...section('th-live-peer'), peer_bot: 'other', title: 'From Other' }
    sections = [peerThread]
    const exchange1 = [
      { role: 'user', content: '@other: First question', hidden: true, row_id: 'q1' },
      {
        role: 'assistant',
        content: 'First answer',
        row_id: 'a1',
        tool_calls: [{ id: 't1', name: 'message_bot', arguments: { to: 'gamma' } }]
      },
      { role: 'tool', tool_call_id: 't1', content: '{"reply":"ok","section_id":"th-g"}' }
    ]
    const exchange2 = [
      ...exchange1,
      { role: 'user', content: '@other: Second question', hidden: true, row_id: 'q2' },
      {
        role: 'assistant',
        content: 'Second answer',
        row_id: 'a2',
        tool_calls: [{ id: 't2', name: 'message_bot', arguments: { to: 'gamma', wait: false } }]
      },
      { role: 'tool', tool_call_id: 't2', content: '{"status":"sent","section_id":"th-g"}' }
    ]
    let openCalls = 0
    let markReadCalls = 0
    const hook = await connected()
    state.request.mockImplementation((name: string, params: Record<string, unknown> = {}) => {
      if (name === 'hexbot.sections.open' && params.id === 'th-live-peer') {
        openCalls += 1
        return Promise.resolve({
          section: peerThread,
          messages: exchange1
        })
      }
      if (name === 'hexbot.sections.mark_read' && params.id === 'th-live-peer') {
        markReadCalls += 1
        // Mirror the daemon (server.rs): mark_read broadcasts hexbot.sections.changed without reload.
        queueMicrotask(() => {
          state.event({
            type: 'hexbot.sections.changed',
            session_id: '',
            payload: { id: 'th-live-peer' }
          })
        })
        return Promise.resolve({})
      }
      return reply(name, params)
    })

    // 1. Opening an idle peer thread settles cleanly after one open and one mark_read (no RPC loop).
    await act(async () => {
      await hook.result.current.openSection(bot, peerThread)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(openCalls).toBe(1)
    expect(markReadCalls).toBe(1)
    expect(hook.result.current.chat.messages.map(m => m.text)).toEqual([
      'First question',
      'First answer'
    ])

    // 2. Live second exchange arrives while the peer thread stays open:
    // message.start arrives BEFORE the hidden question is persisted, then reload: true arrives
    // once persisted while the reply is still streaming.
    let busy = false
    let messagesStage: 'first' | 'question-only' | 'second-done' | 'recovered' = 'first'
    const questionOnly = [
      ...exchange1,
      { role: 'user', content: '@other: Second question', hidden: true, row_id: 'q2' }
    ]
    const recoveredRows = [
      ...exchange2,
      { role: 'user', content: '@other: Third question', hidden: true, row_id: 'q3' },
      { role: 'assistant', content: 'Recovered', row_id: 'a3' }
    ]
    let holdOpen: ReturnType<typeof deferred> | null = null
    state.request.mockImplementation((name: string, params: Record<string, unknown> = {}) => {
      if (name === 'hexbot.sections.open' && params.id === 'th-live-peer') {
        openCalls += 1
        if (holdOpen) {
          const pending = holdOpen
          holdOpen = null
          return pending.promise
        }
        const rows =
          messagesStage === 'first'
            ? exchange1
            : messagesStage === 'question-only'
              ? questionOnly
              : messagesStage === 'second-done'
                ? exchange2
                : recoveredRows
        return Promise.resolve({ section: peerThread, busy, messages: rows })
      }
      if (name === 'hexbot.sections.mark_read' && params.id === 'th-live-peer') {
        markReadCalls += 1
        queueMicrotask(() => {
          state.event({
            type: 'hexbot.sections.changed',
            session_id: '',
            payload: { id: 'th-live-peer' }
          })
        })
        return Promise.resolve({})
      }
      return reply(name, params)
    })

    // message.start lands before question persistence: does NOT trigger a premature read.
    const opensBeforeStart = openCalls
    await act(async () => {
      state.event({
        type: 'message.start',
        session_id: 'live-th-live-peer',
        payload: {}
      })
      await Promise.resolve()
    })
    expect(openCalls).toBe(opensBeforeStart)

    // Daemon persists the hidden question and emits reload: true while the reply streams.
    messagesStage = 'question-only'
    busy = true
    await act(async () => {
      state.event({
        type: 'hexbot.sections.changed',
        session_id: '',
        payload: { id: 'th-live-peer', reload: true }
      })
      state.event({
        type: 'message.delta',
        session_id: 'live-th-live-peer',
        payload: { text: 'Streaming second' }
      })
      await Promise.resolve()
      await Promise.resolve()
    })
    // The new question is visible ABOVE the still-streaming reply.
    expect(hook.result.current.chat.messages.map(m => [m.sender, m.text])).toEqual([
      ['other', 'First question'],
      [undefined, 'First answer'],
      ['other', 'Second question']
    ])
    expect(hook.result.current.chat.busy).toBe(true)
    expect(hook.result.current.chat.streaming).toBe('Streaming second')

    // Completion settles the second exchange cleanly.
    messagesStage = 'second-done'
    busy = false
    await act(async () => {
      state.event({
        type: 'message.complete',
        session_id: 'live-th-live-peer',
        payload: { text: 'Second answer' }
      })
      state.event({
        type: 'hexbot.sections.changed',
        session_id: '',
        payload: { id: 'th-live-peer' }
      })
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(hook.result.current.chat.messages.map(m => [m.sender, m.text])).toEqual([
      ['other', 'First question'],
      [undefined, 'First answer'],
      ['other', 'Second question'],
      [undefined, 'Second answer']
    ])

    // 3. A failed peer reply followed by hexbot.sections.changed keeps its error intact.
    await act(async () => {
      state.event({
        type: 'message.complete',
        session_id: 'live-th-live-peer',
        payload: { error: 'provider failed', text: '' }
      })
      state.event({
        type: 'hexbot.sections.changed',
        session_id: '',
        payload: { id: 'th-live-peer' }
      })
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(hook.result.current.chat.error).toBe('provider failed')

    // 4. Buffered failure followed by a recovered turn inside one history load clears the error.
    const firstLoad = deferred()
    holdOpen = firstLoad
    messagesStage = 'recovered'
    busy = false
    await act(async () => {
      state.event({
        type: 'hexbot.sections.changed',
        session_id: '',
        payload: { id: 'th-live-peer', reload: true }
      })
      state.event({
        type: 'message.complete',
        session_id: 'live-th-live-peer',
        payload: { error: 'provider failed', text: '' }
      })
      state.event({
        type: 'message.start',
        session_id: 'live-th-live-peer',
        payload: {}
      })
      state.event({
        type: 'message.complete',
        session_id: 'live-th-live-peer',
        payload: { text: 'Recovered' }
      })
      firstLoad.resolve({ section: peerThread, busy: true, messages: exchange2 })
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(hook.result.current.chat.error).toBeNull()
    expect(hook.result.current.chat.messages.at(-1)?.text).toBe('Recovered')

    // 5. History retry after a buffered completion preserves the start of a newer in-flight stream.
    const firstRetryLoad = deferred()
    const secondRetryLoad = deferred()
    let retryOpens = 0
    state.request.mockImplementation((name: string, params: Record<string, unknown> = {}) => {
      if (name === 'hexbot.sections.open' && params.id === 'th-live-peer') {
        retryOpens += 1
        return retryOpens === 1 ? firstRetryLoad.promise : secondRetryLoad.promise
      }
      if (name === 'hexbot.sections.mark_read' && params.id === 'th-live-peer') {
        return Promise.resolve({})
      }
      return reply(name, params)
    })
    await act(async () => {
      state.event({
        type: 'hexbot.sections.changed',
        session_id: '',
        payload: { id: 'th-live-peer', reload: true }
      })
      state.event({
        type: 'message.complete',
        session_id: 'live-th-live-peer',
        payload: { text: 'Recovered' }
      })
      state.event({
        type: 'message.start',
        session_id: 'live-th-live-peer',
        payload: {}
      })
      state.event({
        type: 'message.delta',
        session_id: 'live-th-live-peer',
        payload: { text: 'Prefix ' }
      })
      firstRetryLoad.resolve({ section: peerThread, busy: true, messages: exchange2 })
      await Promise.resolve()
      await Promise.resolve()
      state.event({
        type: 'message.delta',
        session_id: 'live-th-live-peer',
        payload: { text: 'suffix' }
      })
      secondRetryLoad.resolve({ section: peerThread, busy: true, messages: recoveredRows })
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(hook.result.current.chat.busy).toBe(true)
    expect(hook.result.current.chat.streaming).toBe('Prefix suffix')

    // 6. Delayed peer-question reload arriving AFTER the first delta preserves the pre-reload prefix.
    const delayedReload = deferred()
    state.request.mockImplementation((name: string, params: Record<string, unknown> = {}) => {
      if (name === 'hexbot.sections.open' && params.id === 'th-live-peer')
        return delayedReload.promise
      if (name === 'hexbot.sections.mark_read' && params.id === 'th-live-peer')
        return Promise.resolve({})
      return reply(name, params)
    })
    await act(async () => {
      state.event({
        type: 'message.start',
        session_id: 'live-th-live-peer',
        payload: {}
      })
      state.event({
        type: 'message.delta',
        session_id: 'live-th-live-peer',
        payload: { text: 'Prefix ' }
      })
      // Delayed reload arrives after Prefix already streamed, then suffix streams while open loads.
      state.event({
        type: 'hexbot.sections.changed',
        session_id: '',
        payload: { id: 'th-live-peer', reload: true }
      })
      state.event({
        type: 'message.delta',
        session_id: 'live-th-live-peer',
        payload: { text: 'suffix' }
      })
      delayedReload.resolve({ section: peerThread, busy: true, messages: questionOnly })
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(hook.result.current.chat.messages.at(-1)).toMatchObject({
      sender: 'other',
      text: 'Second question'
    })
    expect(hook.result.current.chat.busy).toBe(true)
    expect(hook.result.current.chat.streaming).toBe('Prefix suffix')

    // 7. A reload overlapping the INITIAL thread open (before liveId is bound) still preserves Prefix.
    const freshPeer = { ...section('th-initial-overlap'), peer_bot: 'other', title: 'From Other' }
    const initialOpen = deferred()
    const reloadOpen = deferred()
    let freshOpens = 0
    state.request.mockImplementation((name: string, params: Record<string, unknown> = {}) => {
      if (name === 'hexbot.sections.open' && params.id === 'th-initial-overlap') {
        freshOpens += 1
        return freshOpens === 1 ? initialOpen.promise : reloadOpen.promise
      }
      if (name === 'hexbot.sections.mark_read' && params.id === 'th-initial-overlap')
        return Promise.resolve({})
      return reply(name, params)
    })
    await act(async () => {
      const opening = hook.result.current.openSection(bot, freshPeer)
      await Promise.resolve()
      // Before initialOpen resolves (liveId is still null), Prefix streams and reload: true arrives.
      state.event({
        type: 'message.start',
        session_id: 'live-th-initial-overlap',
        payload: {}
      })
      state.event({
        type: 'message.delta',
        session_id: 'live-th-initial-overlap',
        payload: { text: 'Prefix ' }
      })
      state.event({
        type: 'hexbot.sections.changed',
        session_id: '',
        payload: { id: 'th-initial-overlap', reload: true }
      })
      state.event({
        type: 'message.delta',
        session_id: 'live-th-initial-overlap',
        payload: { text: 'suffix' }
      })
      initialOpen.resolve({ section: freshPeer, busy: true, messages: exchange1 })
      reloadOpen.resolve({ section: freshPeer, busy: true, messages: questionOnly })
      await opening
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(hook.result.current.chat.messages.at(-1)).toMatchObject({
      sender: 'other',
      text: 'Second question'
    })
    expect(hook.result.current.chat.busy).toBe(true)
    expect(hook.result.current.chat.streaming).toBe('Prefix suffix')

    // 8. A reload interrupting an initial history retry (while liveId is still null) preserves Prefix.
    const retryPeer = { ...section('th-retry-interrupt'), peer_bot: 'other', title: 'From Other' }
    const attempt0 = deferred()
    const attempt1 = deferred()
    const interruptReload = deferred()
    let retryPeerOpens = 0
    state.request.mockImplementation((name: string, params: Record<string, unknown> = {}) => {
      if (name === 'hexbot.sections.open' && params.id === 'th-retry-interrupt') {
        retryPeerOpens += 1
        return retryPeerOpens === 1
          ? attempt0.promise
          : retryPeerOpens === 2
            ? attempt1.promise
            : interruptReload.promise
      }
      if (name === 'hexbot.sections.mark_read' && params.id === 'th-retry-interrupt')
        return Promise.resolve({})
      return reply(name, params)
    })
    await act(async () => {
      const opening = hook.result.current.openSection(bot, retryPeer)
      await Promise.resolve()
      state.event({
        type: 'message.complete',
        session_id: 'live-th-retry-interrupt',
        payload: { text: 'First answer' }
      })
      state.event({
        type: 'message.start',
        session_id: 'live-th-retry-interrupt',
        payload: {}
      })
      state.event({
        type: 'message.delta',
        session_id: 'live-th-retry-interrupt',
        payload: { text: 'Prefix ' }
      })
      attempt0.resolve({ section: retryPeer, busy: true, messages: exchange1 })
      await Promise.resolve()
      await Promise.resolve()
      // attempt1 is now pending while liveId is still null; a reload interrupts it.
      state.event({
        type: 'hexbot.sections.changed',
        session_id: '',
        payload: { id: 'th-retry-interrupt', reload: true }
      })
      state.event({
        type: 'message.delta',
        session_id: 'live-th-retry-interrupt',
        payload: { text: 'suffix' }
      })
      attempt1.resolve({ section: retryPeer, busy: true, messages: exchange1 })
      interruptReload.resolve({ section: retryPeer, busy: true, messages: questionOnly })
      await opening
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(hook.result.current.chat.messages.at(-1)).toMatchObject({
      sender: 'other',
      text: 'Second question'
    })
    expect(hook.result.current.chat.busy).toBe(true)
    expect(hook.result.current.chat.streaming).toBe('Prefix suffix')

    // 9. Opening an uncached peer thread via openThread from a room buffers deltas during lookup and opens once.
    const uncachedPeer = { ...section('new-thread'), peer_bot: 'other', title: 'From Other' }
    const uncachedOpen = deferred()
    let uncachedOpenCalls = 0
    sections = []
    await act(async () => {
      await hook.result.current.openRoom(room)
    })
    state.request.mockImplementation((name: string, params: Record<string, unknown> = {}) => {
      if (name === 'hexbot.sections.open' && params.id === 'new-thread') {
        uncachedOpenCalls += 1
        return uncachedOpen.promise
      }
      if (name === 'hexbot.sections.mark_read' && params.id === 'new-thread')
        return Promise.resolve({})
      return reply(name, params)
    })
    await act(async () => {
      const opening = hook.result.current.openThread('owl', 'other', { sectionId: 'new-thread' })
      await Promise.resolve()
      // Peer reply starts streaming Prefix while the uncached openThread lookup is still pending.
      state.event({
        type: 'message.start',
        session_id: 'live-new-thread',
        payload: {}
      })
      state.event({
        type: 'message.delta',
        session_id: 'live-new-thread',
        payload: { text: 'Prefix ' }
      })
      uncachedOpen.resolve({ section: uncachedPeer, busy: true, messages: questionOnly })
      await opening
      state.event({
        type: 'message.delta',
        session_id: 'live-new-thread',
        payload: { text: 'suffix' }
      })
      await Promise.resolve()
    })
    expect(uncachedOpenCalls).toBe(1)
    expect(hook.result.current.route).toMatchObject({
      kind: 'section',
      section: { id: 'new-thread' }
    })
    expect(hook.result.current.chat.busy).toBe(true)
    expect(hook.result.current.chat.streaming).toBe('Prefix suffix')

    // 10. Tapping a running Messaging pill (no sectionId yet) captures Prefix during hexbot.sections.thread.
    const pairPeer = { ...section('pair-thread'), peer_bot: 'other', title: 'From Other' }
    const pairLookup = deferred()
    sections = []
    state.request.mockImplementation(reply)
    await act(async () => {
      await hook.result.current.refresh()
      await hook.result.current.openRoom(room)
    })
    state.request.mockImplementation((name: string, params: Record<string, unknown> = {}) => {
      if (name === 'hexbot.sections.thread') return pairLookup.promise
      if (name === 'hexbot.sections.open' && params.id === 'pair-thread')
        return Promise.resolve({ section: pairPeer, busy: true, messages: questionOnly })
      if (name === 'hexbot.sections.mark_read' && params.id === 'pair-thread')
        return Promise.resolve({})
      return reply(name, params)
    })
    await act(async () => {
      const opening = hook.result.current.openThread('owl', 'other')
      await Promise.resolve()
      state.event({
        type: 'message.start',
        session_id: 'live-pair-thread',
        payload: {}
      })
      state.event({
        type: 'message.delta',
        session_id: 'live-pair-thread',
        payload: { text: 'Prefix ' }
      })
      pairLookup.resolve({ section: pairPeer })
      await opening
      state.event({
        type: 'message.delta',
        session_id: 'live-pair-thread',
        payload: { text: 'suffix' }
      })
      await Promise.resolve()
    })
    expect(hook.result.current.route).toMatchObject({
      kind: 'section',
      section: { id: 'pair-thread' }
    })
    expect(hook.result.current.chat.busy).toBe(true)
    expect(hook.result.current.chat.streaming).toBe('Prefix suffix')

    // 11. A failed openThread lookup does not cancel the originating chat's in-flight load or drop its approval.
    const originChat = section('owl-chat')
    const originOpen = deferred()
    const originOpenCalled = deferred<void>()
    sections = [originChat]
    state.request.mockImplementation((name: string, params: Record<string, unknown> = {}) => {
      if (name === 'hexbot.sections.open' && params.id === 'owl-chat') {
        originOpenCalled.resolve()
        return originOpen.promise
      }
      if (name === 'hexbot.sections.open' && params.id === 'missing-peer')
        return Promise.reject(new Error('not found'))
      return reply(name, params)
    })
    await act(async () => {
      const openingOrigin = hook.result.current.openSection(bot, originChat)
      await originOpenCalled.promise
      state.event({
        type: 'approval.request',
        session_id: 'live-owl-chat',
        payload: { request_id: 'ap-origin', command: 'echo ok' }
      })
      await hook.result.current.openThread('owl', 'other', { sectionId: 'missing-peer' })
      originOpen.resolve({ section: originChat, busy: true, messages: [] })
      await openingOrigin
      await Promise.resolve()
    })
    expect(hook.result.current.route).toMatchObject({
      kind: 'section',
      section: { id: 'owl-chat' }
    })
    expect(hook.result.current.chat.approvals.map(a => a.requestId)).toEqual(['ap-origin'])

    // 12. Room reload replaying buffered events during a pending openThread does not duplicate deltas.
    const roomReload = deferred()
    const roomReloadCalled = deferred<void>()
    const overlapLookup = deferred()
    const overlapPeer = { ...section('overlap-peer'), peer_bot: 'other', title: 'From Other' }
    sections = []
    state.request.mockImplementation(reply)
    await act(async () => {
      await hook.result.current.refresh()
    })
    state.request.mockImplementation((name: string, params: Record<string, unknown> = {}) => {
      if (name === 'hexbot.rooms.log') {
        roomReloadCalled.resolve()
        return roomReload.promise
      }
      if (name === 'hexbot.sections.thread') return overlapLookup.promise
      if (name === 'hexbot.sections.open' && params.id === 'overlap-peer')
        return Promise.resolve({ section: overlapPeer, busy: true, messages: questionOnly })
      if (name === 'hexbot.sections.mark_read' && params.id === 'overlap-peer')
        return Promise.resolve({})
      return reply(name, params)
    })
    await act(async () => {
      const openingRoom = hook.result.current.openRoom(room)
      await roomReloadCalled.promise
      const openingPeer = hook.result.current.openThread('owl', 'other')
      await Promise.resolve()
      // One Prefix delta arrives while BOTH room reload and peer lookup are active.
      state.event({
        type: 'message.start',
        session_id: 'live-overlap-peer',
        payload: {}
      })
      state.event({
        type: 'message.delta',
        session_id: 'live-overlap-peer',
        payload: { text: 'Prefix ' }
      })
      // Room finishes first and replays its buffer through onEvent before peer lookup resolves.
      roomReload.resolve({ events: [] })
      await openingRoom
      overlapLookup.resolve({ section: overlapPeer })
      await openingPeer
      state.event({
        type: 'message.delta',
        session_id: 'live-overlap-peer',
        payload: { text: 'suffix' }
      })
      await Promise.resolve()
    })
    expect(hook.result.current.chat.streaming).toBe('Prefix suffix')

    // 13. A cached peer thread returning 4204 stays in the originating chat and keeps its approval.
    const cachedDeleted = { ...section('cached-deleted'), peer_bot: 'other', title: 'From Other' }
    sections = [originChat, cachedDeleted]
    state.request.mockImplementation(reply)
    await act(async () => {
      await hook.result.current.refresh()
      await hook.result.current.openSection(bot, originChat)
    })
    act(() => {
      state.event({
        type: 'approval.request',
        session_id: 'live-owl-chat',
        payload: { request_id: 'ap-cached-stay', command: 'echo stay' }
      })
    })
    state.request.mockImplementation((name: string, params: Record<string, unknown> = {}) =>
      name === 'hexbot.sections.open' && params.id === 'cached-deleted'
        ? Promise.reject(Object.assign(new Error('section not found'), { code: 4204 }))
        : reply(name, params)
    )
    await act(async () => {
      await hook.result.current.openThread('owl', 'other', { sectionId: 'cached-deleted' })
    })
    expect(hook.result.current.route).toMatchObject({
      kind: 'section',
      section: { id: 'owl-chat' }
    })
    expect(hook.result.current.chat.approvals.map(a => a.requestId)).toEqual(['ap-cached-stay'])
    expect(hook.result.current.error).toBe('This conversation is no longer available.')

    // 14. Superseding an explicit-ID lookup with an empty pair lookup clears loading instead of sticking true.
    const slowExplicit = deferred()
    sections = []
    state.request.mockImplementation(reply)
    await act(async () => {
      await hook.result.current.refresh()
    })
    state.request.mockImplementation((name: string, params: Record<string, unknown> = {}) => {
      if (name === 'hexbot.sections.open' && params.id === 'slow-id') return slowExplicit.promise
      if (name === 'hexbot.sections.thread') return Promise.resolve({ section: null })
      return reply(name, params)
    })
    await act(async () => {
      const first = hook.result.current.openThread('owl', 'other', { sectionId: 'slow-id' })
      await Promise.resolve()
      await hook.result.current.openThread('owl', 'other')
      slowExplicit.reject(new Error('cancelled'))
      await first
    })
    expect(hook.result.current.loading).toBe(false)
    expect(hook.result.current.error).toBe('This conversation is not available yet.')

    // 15. A failed pair lookup with allowReverse keeps the origin chat & approvals instead of opening owner chat.
    const otherBot = { name: 'other', display_name: 'Other', status: 'idle' } as Bot
    sections = [originChat]
    state.request.mockImplementation((name: string, params: Record<string, unknown> = {}) => {
      if (name === 'hexbot.bots.list') return Promise.resolve({ bots: [bot, otherBot] })
      return reply(name, params)
    })
    await act(async () => {
      await hook.result.current.refresh()
      await hook.result.current.openSection(bot, originChat)
    })
    act(() => {
      state.event({
        type: 'approval.request',
        session_id: 'live-owl-chat',
        payload: { request_id: 'ap-mention-stay', command: 'echo mention' }
      })
    })
    state.request.mockImplementation((name: string, params: Record<string, unknown> = {}) => {
      if (name === 'hexbot.sections.thread' && params.bot === 'other' && params.peer === 'owl')
        return Promise.reject(new Error('request timed out'))
      if (name === 'hexbot.sections.thread') return Promise.resolve({ section: null })
      return reply(name, params)
    })
    await act(async () => {
      await hook.result.current.openThread('other', 'owl', { allowReverse: true })
    })
    expect(hook.result.current.route).toMatchObject({
      kind: 'section',
      section: { id: 'owl-chat' }
    })
    expect(hook.result.current.chat.approvals.map(a => a.requestId)).toEqual(['ap-mention-stay'])
    expect(hook.result.current.error).toBe('request timed out')
    expect(hook.result.current.loading).toBe(false)

    // When both forward and reverse lookups succeed and confirm empty, allowReverse falls back to owner chat.
    const otherChat = { ...section('other-chat'), bot: 'other' }
    state.request.mockImplementation((name: string, params: Record<string, unknown> = {}) => {
      if (name === 'hexbot.sections.thread') return Promise.resolve({ section: null })
      if (name === 'hexbot.sections.create' && params.bot === 'other')
        return Promise.resolve({ section: otherChat })
      if (name === 'hexbot.sections.open' && params.id === 'other-chat')
        return Promise.resolve({ section: otherChat, messages: [] })
      return reply(name, params)
    })
    await act(async () => {
      await hook.result.current.openThread('other', 'owl', { allowReverse: true })
    })
    expect(hook.result.current.route).toMatchObject({
      kind: 'section',
      section: { id: 'other-chat' }
    })
  })

  it('clears the thread return stack when switching daemons so Back never requests the previous daemon’s room', async () => {
    const hook = await connected()
    const peerThread = { ...section('th-peer-d1'), peer_bot: 'fox', title: 'From Fox' }
    const secondPeer = { ...section('th-peer-d2'), peer_bot: 'fox', title: 'From Fox' }
    state.request.mockImplementation((name: string, params: Record<string, unknown> = {}) => {
      if (name === 'hexbot.sections.open' && params.id === 'th-peer-d1')
        return Promise.resolve({ section: peerThread, messages: [] })
      if (name === 'hexbot.sections.open' && params.id === 'th-peer-d2')
        return Promise.resolve({ section: secondPeer, messages: [] })
      return reply(name, params)
    })

    // Open a room, then a peer thread from inside it on daemon 1.
    await act(async () => {
      await hook.result.current.openRoom(room)
      await hook.result.current.openSection(bot, peerThread)
    })
    expect(hook.result.current.hasThreadReturn).toBe(true)

    // Switch to daemon 2: return stack clears immediately.
    const secondDaemon = { id: 'second', name: 'Second' } as SavedDaemon
    await act(async () => {
      await hook.result.current.activate(secondDaemon, 'token-2')
      await hook.result.current.refresh()
    })
    expect(hook.result.current.hasThreadReturn).toBe(false)

    // Opening a waiting peer thread on daemon 2 and pressing Back leaves to the roster instead of old room.
    state.request.mockClear()
    await act(async () => {
      await hook.result.current.openSection(bot, secondPeer)
    })
    expect(hook.result.current.hasThreadReturn).toBe(false)
    act(() => {
      hook.result.current.back()
    })
    expect(hook.result.current.route).toBeNull()
    expect(state.request).not.toHaveBeenCalledWith('hexbot.rooms.get', expect.anything())
  })

  it('keeps ordinary room tools non-duplicated and preserves ask order across repeated Back returns', async () => {
    const hook = await connected()
    const peerThread = { ...section('th-bio-back'), peer_bot: 'owl', title: 'From Owl' }
    const runningRoom = {
      ...room,
      turns: [
        {
          bot: 'owl',
          live_session_id: 'room-live-back',
          turn_id: 'T-back',
          asks: [
            {
              occurrence_id: 'occ-bio',
              tool_id: 'call_0',
              args: { to: 'bio', wait: true },
              context: 'bio',
              section_id: 'th-bio-back',
              status: 'running' as const,
              turn_id: 'T-back'
            },
            {
              occurrence_id: 'occ-chem',
              tool_id: 'call_1',
              args: { to: 'chem', wait: true },
              context: 'chem',
              status: 'running' as const,
              turn_id: 'T-back'
            }
          ]
        }
      ]
    }
    state.request.mockImplementation((name: string, params: Record<string, unknown> = {}) => {
      if (name === 'hexbot.rooms.get' && params.id === room.id)
        return Promise.resolve({ room: runningRoom })
      if (name === 'hexbot.rooms.log' && params.id === room.id) return Promise.resolve({ events: [] })
      if (name === 'hexbot.sections.open' && params.id === 'th-bio-back')
        return Promise.resolve({ section: peerThread, messages: [] })
      return reply(name, params)
    })

    await act(async () => {
      await hook.result.current.openRoom(room)
    })
    act(() => {
      state.event({
        type: 'tool.start',
        session_id: 'room-live-back',
        payload: { turn_id: 'T-back', tool_id: 'b1', name: 'bash', args: { command: 'ls' } }
      })
      state.event({
        type: 'tool.complete',
        session_id: 'room-live-back',
        payload: { turn_id: 'T-back', tool_id: 'b1', name: 'bash', result_text: 'ok' }
      })
    })
    for (let visit = 0; visit < 3; visit++) {
      await act(async () => {
        await hook.result.current.openSection(bot, peerThread)
      })
      await act(async () => {
        hook.result.current.back()
        await Promise.resolve()
        await Promise.resolve()
      })
      const liveTurn = hook.result.current.chat.turns['room-live-back']
      expect(liveTurn?.tools.filter(t => t.name === 'bash')).toHaveLength(1)
      expect(liveTurn?.asked?.map(t => t.action)).toEqual(['bio', 'chem'])
    }
  })
})
