import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'

import {
  authorizeCache,
  readCache,
  resetDeviceCacheForTests,
  writeCache
} from '../lib/device-cache'
import * as deviceCache from '../lib/device-cache'
import {
  clearPersonalState,
  keepRoster,
  restoreRoster,
  stopRosterWrites
} from '../lib/roster-cache'
import { setActiveRpc } from '../lib/rpc'
import type { Bot, Room, Section } from '../lib/types'

import { botMissing, useBots } from './bots'
import { useConnection } from './connection'
import { useRooms } from './rooms'
import { useSections } from './sections'

const room = { id: 'r', members: [], name: 'Deleted room' } as unknown as Room
const section = { id: 's', bot: 'writer', live_session_id: null } as Section
const scope = 'local:http://review.test'

function deferred<T>() {
  let resolve!: (value: T) => void

  const promise = new Promise<T>(yes => {
    resolve = yes
  })

  return { promise, resolve }
}

beforeEach(async () => {
  await resetDeviceCacheForTests()
  vi.stubGlobal('indexedDB', new IDBFactory())
  vi.stubGlobal('IDBKeyRange', IDBKeyRange)
  useConnection.setState({
    target: { kind: 'local', origin: 'http://review.test' },
    epoch: 'same',
    status: 'connected'
  })
  clearPersonalState()
  await authorizeCache(scope, 'daemon', () => true)
})
afterEach(async () => {
  stopRosterWrites()
  vi.restoreAllMocks()
  vi.useRealTimers()
  setActiveRpc(null)
  await resetDeviceCacheForTests()
  vi.unstubAllGlobals()
})

it.each(['refreshOne', 'open'] as const)(
  'new empty roster invalidates an unlisted cold %s success',
  async action => {
    const held = deferred<{ room: Room }>()
    setActiveRpc({
      call: vi.fn((method: string) => {
        if (method === 'hexbot.rooms.get') {
          return held.promise
        }

        if (method === 'hexbot.rooms.list') {
          return Promise.resolve({ rooms: [] })
        }

        return Promise.resolve({ events: [] })
      })
    } as never)
    const pending = useRooms.getState()[action]('r')
    await useRooms.getState().refresh()
    expect(useRooms.getState().loaded).toBe(true)
    expect(useRooms.getState().byId.r).toBeUndefined()
    held.resolve({ room })
    await pending
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    keepRoster(scope)
    await vi.advanceTimersByTimeAsync(500)
    vi.useRealTimers()
    await writeCache(scope, 'barrier', true)
    const saved = await readCache<{ rooms: Room[] }>(scope, 'roster')
    expect({ memory: useRooms.getState().byId.r, disk: saved?.rooms }).toEqual({
      memory: undefined,
      disk: []
    })
  }
)

it('a successful empty section list supersedes a delayed roster cache read', async () => {
  await writeCache(scope, 'roster', {
    daemon: 'daemon',
    bots: [],
    me: null,
    rooms: [],
    sections: [section]
  })
  const held = deferred<void>()
  const reached = deferred<void>()
  const read = deviceCache.readCache
  vi.spyOn(deviceCache, 'readCache').mockImplementation(async (...args) => {
    const result = await read(...args)

    if (args[1] === 'roster') {
      reached.resolve()
      await held.promise
    }

    return result
  })
  setActiveRpc({ call: async () => ({ sections: [] }) } as never)
  const restoring = restoreRoster(scope)
  await reached.promise
  // Also invalidate an already-known section, as a live deletion refresh does.
  useSections.setState({ byId: { s: section } })
  await useSections.getState().refresh()
  held.resolve()
  await restoring
  useRooms.setState({ loaded: true })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  keepRoster(scope)
  await vi.advanceTimersByTimeAsync(500)
  vi.useRealTimers()
  await writeCache(scope, 'barrier', true)
  const saved = await readCache<{ sections: Section[] }>(scope, 'roster')
  expect({ memory: useSections.getState().byId.s, disk: saved?.sections }).toEqual({
    memory: undefined,
    disk: []
  })
})

it.each(['refreshOne', 'open'] as const)(
  'an empty list requested before a cold %s preserves the newer valid lookup',
  async action => {
    const listed = deferred<{ rooms: Room[] }>()
    const found = deferred<{ room: Room }>()
    setActiveRpc({
      call: vi.fn((method: string) => {
        if (method === 'hexbot.rooms.list') {
          return listed.promise
        }

        if (method === 'hexbot.rooms.get') {
          return found.promise
        }

        return Promise.resolve({ events: [] })
      })
    } as never)
    const listing = useRooms.getState().refresh()
    const lookup = useRooms.getState()[action]('r')
    listed.resolve({ rooms: [] })
    await listing
    expect(useRooms.getState().answers.r).toBe('discarded')
    found.resolve({ room })
    expect(await lookup).toBe('present')
    expect(useRooms.getState().byId.r).toEqual(room)
  }
)

it('a bot lookup started after a list request is unknown until its current answer', async () => {
  const listed = deferred<{ bots: Bot[] }>()
  const found = deferred<{ bot: Bot }>()
  const bot = { name: 'writer' } as Bot
  setActiveRpc({
    call: (method: string) => (method === 'hexbot.bots.list' ? listed.promise : found.promise)
  } as never)
  const listing = useBots.getState().refresh()
  const lookup = useBots.getState().refreshOne('writer')
  listed.resolve({ bots: [] })
  await listing
  expect(useBots.getState().loaded).toBe(true)
  expect(botMissing(useBots.getState(), 'writer')).toBe(false)
  found.resolve({ bot })
  await lookup
  expect(useBots.getState().byName.writer).toEqual(bot)
})

it('an older cold bot lookup cannot restore a bot omitted by a newer list', async () => {
  const found = deferred<{ bot: Bot }>()
  setActiveRpc({
    call: (method: string) =>
      method === 'hexbot.bots.list' ? Promise.resolve({ bots: [] }) : found.promise
  } as never)
  const lookup = useBots.getState().refreshOne('writer')
  await useBots.getState().refresh()
  found.resolve({ bot: { name: 'writer' } as Bot })
  await lookup
  expect(botMissing(useBots.getState(), 'writer')).toBe(true)
  expect(useBots.getState().byName.writer).toBeUndefined()
})

it('a delayed bot cache cannot restore metadata after an empty authoritative list', async () => {
  await writeCache(scope, 'roster', {
    daemon: 'daemon',
    bots: [{ name: 'writer' }],
    me: null,
    rooms: [],
    sections: []
  })
  const held = deferred<void>()
  const reached = deferred<void>()
  const read = deviceCache.readCache
  vi.spyOn(deviceCache, 'readCache').mockImplementation(async (...args) => {
    const result = await read(...args)

    if (args[1] === 'roster') {
      reached.resolve()
      await held.promise
    }

    return result
  })
  setActiveRpc({ call: async () => ({ bots: [] }) } as never)
  const restoring = restoreRoster(scope)
  await reached.promise
  await useBots.getState().refresh()
  held.resolve()
  await restoring
  expect(useBots.getState().byName.writer).toBeUndefined()
  expect(botMissing(useBots.getState(), 'writer')).toBe(true)
})
