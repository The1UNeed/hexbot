// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useMobile } from './useMobile'
import type { Bot, Room, SavedDaemon, Section } from './types'

const state = vi.hoisted(() => ({
  request: vi.fn(),
  revoked: () => {}
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
vi.mock('./session', () => ({
  MobileSession: class {
    client = { connectionState: 'open', request: state.request }
    constructor(_daemon: unknown, _token: string, changed: (state: string) => void) {
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
