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
import type { Room, Section } from '../lib/types'

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
        if (method === 'hexbot.rooms.get') {return held.promise}

        if (method === 'hexbot.rooms.list') {return Promise.resolve({ rooms: [] })}

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
