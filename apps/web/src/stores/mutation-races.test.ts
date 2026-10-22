import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'

import {
  authorizeCache,
  readCache,
  resetDeviceCacheForTests,
  writeCache
} from '../lib/device-cache'
import { clearPersonalState, keepRoster, stopRosterWrites } from '../lib/roster-cache'
import { setActiveRpc } from '../lib/rpc'
import type { Bot, DaemonInfo, Room, Section } from '../lib/types'

import { useBots } from './bots'
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
    status: 'connected',
    daemon: { install_id: 'daemon', one_chat: true } as DaemonInfo
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

it.each(['update', 'addMember', 'removeMember'] as const)(
  'late successful %s cannot restore a deleted room or its disk roster',
  async action => {
    const held = deferred<{ room: Room }>()
    useRooms.getState().restore([room], {})
    useRooms.setState({ loaded: true })
    setActiveRpc({ call: () => held.promise } as never)

    const pending =
      action === 'update'
        ? useRooms.getState().update('r', { name: 'Old rename' })
        : action === 'addMember'
          ? useRooms.getState().addMember('r', 'owl')
          : useRooms.getState().removeMember('r', 'owl', true)

    useRooms.getState().drop('r')
    held.resolve({ room: { ...room, name: 'Old rename' } })
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

it('late bot update cannot restore a bot omitted by a newer complete list', async () => {
  const held = deferred<{ bot: Bot }>()
  const bot = { name: 'writer' } as Bot
  useBots.setState({ byName: { writer: bot }, order: ['writer'] })
  setActiveRpc({
    call: (method: string) =>
      method === 'hexbot.bots.update' ? held.promise : Promise.resolve({ bots: [] })
  } as never)
  const updating = useBots.getState().update('writer', { display_name: 'Old name' })
  await useBots.getState().refresh()
  expect(useBots.getState().byName.writer).toBeUndefined()
  held.resolve({ bot })
  await updating
  expect(useBots.getState().byName.writer).toBeUndefined()
})

it('a list requested after deletion must defeat an older mutation reply even when list finishes last', async () => {
  const updated = deferred<{ room: Room }>()
  const listed = deferred<{ rooms: Room[] }>()
  useRooms.getState().restore([room], {})
  useRooms.setState({ loaded: true })
  setActiveRpc({
    call: (method: string) =>
      method === 'hexbot.rooms.update'
        ? updated.promise
        : method === 'hexbot.rooms.list'
          ? listed.promise
          : Promise.resolve({ events: [] })
  } as never)
  const mutation = useRooms.getState().update('r', { name: 'Obsolete rename' })
  useRooms.getState().drop('r')
  const listing = useRooms.getState().refresh()
  updated.resolve({ room: { ...room, name: 'Obsolete rename' } })
  await mutation
  listed.resolve({ rooms: [] })
  await listing
  expect(useRooms.getState().byId.r).toBeUndefined()
})

const mutateRoom = (action: string) =>
  action === 'create'
    ? useRooms.getState().create({ name: 'Created', members: [] })
    : action === 'addMember'
      ? useRooms.getState().addMember('r', 'owl')
      : action === 'removeMember'
        ? useRooms.getState().removeMember('r', 'owl', true)
        : useRooms.getState().update('r', { name: 'Renamed' })

it.each(['create', 'update', 'addMember', 'removeMember'])(
  'a %s reply keeps its original order against a newer empty list in either response order',
  async action => {
    for (const listFirst of [false, true]) {
      useRooms.getState().reset()

      if (action !== 'create') {
        useRooms.getState().restore([room], {})
      }

      const changed = deferred<{ room: Room }>()
      const listed = deferred<{ rooms: Room[] }>()
      setActiveRpc({
        call: (method: string) =>
          method === 'hexbot.rooms.list'
            ? listed.promise
            : method === 'hexbot.rooms.log'
              ? Promise.resolve({ events: [] })
              : changed.promise
      } as never)
      const mutation = mutateRoom(action)
      const listing = useRooms.getState().refresh()

      if (listFirst) {
        listed.resolve({ rooms: [] })
        await listing
      }

      changed.resolve({ room: { ...room, name: 'Delayed result' } })
      await mutation

      if (!listFirst) {
        listed.resolve({ rooms: [] })
        await listing
      }

      expect(useRooms.getState().byId.r).toBeUndefined()
    }
  }
)

it.each(['create', 'update', 'addMember', 'removeMember'])(
  'a genuinely newer %s survives an older empty list',
  async action => {
    const listed = deferred<{ rooms: Room[] }>()
    const changed = deferred<{ room: Room }>()
    setActiveRpc({
      call: (method: string) =>
        method === 'hexbot.rooms.list'
          ? listed.promise
          : method === 'hexbot.rooms.log'
            ? Promise.resolve({ events: [] })
            : changed.promise
    } as never)
    const listing = useRooms.getState().refresh()
    const mutation = mutateRoom(action)
    changed.resolve({ room })
    await mutation
    listed.resolve({ rooms: [] })
    await listing
    expect(useRooms.getState().byId.r).toEqual(room)
  }
)

it('a newer successful rename wins when mutation replies arrive out of order', async () => {
  const old = deferred<{ room: Room }>()
  let calls = 0
  const newer = { ...room, name: 'Current name' }
  setActiveRpc({
    call: () => (++calls === 1 ? old.promise : Promise.resolve({ room: newer }))
  } as never)
  const first = useRooms.getState().update('r', { name: 'Old name' })
  await useRooms.getState().update('r', { name: 'Current name' })
  old.resolve({ room: { ...room, name: 'Old name' } })
  await first
  expect(useRooms.getState().byId.r).toEqual(newer)
})

it('a delayed deletion cannot remove a room already re-listed by a newer lookup', async () => {
  const removed = deferred<{ deleted: boolean }>()
  setActiveRpc({
    call: (method: string) =>
      method === 'hexbot.rooms.delete' ? removed.promise : Promise.resolve({ room })
  } as never)
  const deleting = useRooms.getState().remove('r')
  await useRooms.getState().refreshOne('r')
  removed.resolve({ deleted: true })
  await deleting
  expect(useRooms.getState().byId.r).toEqual(room)
})

it.each(['create', 'update'] as const)(
  'an old bot %s cannot defeat a newer full list',
  async action => {
    const changed = deferred<{ bot: Bot; section: Section }>()
    setActiveRpc({
      call: (method: string) =>
        method === 'hexbot.bots.list' ? Promise.resolve({ bots: [] }) : changed.promise
    } as never)

    const mutation =
      action === 'create'
        ? useBots.getState().create({ name: 'writer' } as never)
        : useBots.getState().update('writer', { display_name: 'Old' })

    await useBots.getState().refresh()
    changed.resolve({ bot: { name: 'writer' } as Bot, section })
    await mutation
    expect(useBots.getState().byName.writer).toBeUndefined()
  }
)

it('an old bot deletion cannot remove a newly re-created bot with the same name', async () => {
  const removed = deferred<{ deleted: boolean }>()
  const bot = { name: 'writer', display_name: 'New Writer' } as Bot
  setActiveRpc({
    call: (method: string) =>
      method === 'hexbot.bots.delete' ? removed.promise : Promise.resolve({ bots: [bot] })
  } as never)
  const deleting = useBots.getState().remove('writer')
  await useBots.getState().refresh()
  removed.resolve({ deleted: true })
  await deleting
  expect(useBots.getState().byName.writer).toEqual(bot)
})

it('an old canonical section reply cannot undo a newer authoritative empty section list', async () => {
  const changed = deferred<{ section: Section }>()

  const call = vi.fn((method: string) =>
    method === 'hexbot.sections.create' ? changed.promise : Promise.resolve({ sections: [] })
  )

  setActiveRpc({ call } as never)
  const selecting = useSections.getState().chat('writer')
  await vi.waitFor(() =>
    expect(call).toHaveBeenCalledWith('hexbot.sections.create', { bot: 'writer' })
  )
  await useSections.getState().refresh()
  changed.resolve({ section })
  await selecting
  expect(useSections.getState().byId.s).toBeUndefined()
})

it.each(['optional log', 'read mark'] as const)(
  'an older %s permission failure cannot acquire newer authority than a pending list',
  async action => {
    useRooms.getState().restore([room], {})
    let reject!: (error: Error) => void

    const failed = new Promise<never>((_yes, no) => {
      reject = no
    })

    const listed = deferred<{ rooms: Room[] }>()
    let lists = 0
    let logs = 0

    const call = vi.fn((method: string) => {
      if (method === 'hexbot.rooms.list') {
        return ++lists === 1 && action === 'optional log'
          ? Promise.resolve({ rooms: [room] })
          : listed.promise
      }

      if (method === 'hexbot.rooms.log') {
        return ++logs === 1 && action === 'optional log' ? failed : Promise.resolve({ events: [] })
      }

      return failed
    })

    setActiveRpc({ call } as never)

    const old =
      action === 'optional log'
        ? useRooms.getState().refresh()
        : useRooms.getState().markRead('r', 1)

    if (action === 'optional log') {
      await vi.waitFor(() => expect(logs).toBe(1))
    }

    const latest = useRooms.getState().refresh()
    reject(Object.assign(new Error('Older permission error'), { code: 4302 }))
    await old
    listed.resolve({ rooms: [room] })
    await latest
    expect(useRooms.getState().byId.r).toEqual(room)
  }
)
