import { act, render, screen, waitFor } from '@testing-library/react'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'

import { RoomConversation } from '../app/conversation/room'
import { authorizeCache, resetDeviceCacheForTests } from '../lib/device-cache'
import { clearPersonalState, stopRosterWrites } from '../lib/roster-cache'
import { setActiveRpc } from '../lib/rpc'
import type { Room, RoomEvent } from '../lib/types'

import { useConnection } from './connection'
import { useRooms } from './rooms'

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({ room: 'x' })
}))

const scope = 'local:http://review.test'
const room = { id: 'x', members: [], name: 'Older room' } as unknown as Room

function deferred<T>() {
  let resolve!: (value: T) => void

  const promise = new Promise<T>(yes => {
    resolve = yes
  })

  return { promise, resolve }
}

const event = (seq: number) =>
  ({
    seq,
    room_id: 'x',
    actor_kind: 'human',
    actor_id: 'local',
    kind: 'message.user',
    created_at: seq,
    payload: { text: `m${seq}` }
  }) as unknown as RoomEvent

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
  Element.prototype.scrollIntoView = vi.fn()
  await authorizeCache(scope, 'daemon', () => true)
})
afterEach(async () => {
  stopRosterWrites()
  setActiveRpc(null)
  await resetDeviceCacheForTests()
  vi.unstubAllGlobals()
})

it('a read mark issued while a room opens does not discard the opened log', async () => {
  // A listed room without a startup log (not among the recent 20), opened by the user.
  useRooms.setState({ byId: { x: room }, order: ['x'], loaded: true })
  const get = deferred<{ room: Room }>()
  const log = deferred<{ events: RoomEvent[] }>()
  const mark = deferred<{ room: Room }>()
  setActiveRpc({
    call: vi.fn((method: string) => {
      if (method === 'hexbot.rooms.get') {
        return get.promise
      }

      if (method === 'hexbot.rooms.log') {
        return log.promise
      }

      if (method === 'hexbot.rooms.mark_read') {
        return mark.promise
      }

      return Promise.resolve({})
    })
  } as never)
  const opening = useRooms.getState().open('x')
  // A live message arrives while the view loads; the view marks it read (room.tsx effect).
  useRooms.getState().handleEvent('x', event(51))
  const marking = useRooms.getState().markRead('x', 51)
  get.resolve({ room })
  log.resolve({ events: Array.from({ length: 50 }, (_, i) => event(i + 1)) })
  const outcome = await opening
  mark.resolve({ room })
  await marking
  expect({
    outcome,
    events: useRooms.getState().eventsByRoom.x?.length,
    baseline: useRooms.getState().logBaseline.x
  }).toEqual({ outcome: 'present', events: 51, baseline: 1 })
})

it('a cached recent room view at startup still receives the newer log', async () => {
  // Cache restored room x with events 1..50; the daemon now has 1..60.
  useRooms
    .getState()
    .restore([room], { x: Array.from({ length: 50 }, (_, i) => event(i + 1)) }, { x: 1 })
  const after = deferred<{ events: RoomEvent[] }>()
  const get = deferred<{ room: Room }>()
  const mark = deferred<{ room: Room }>()
  const newer = Array.from({ length: 10 }, (_, i) => event(i + 51))
  let logs = 0
  setActiveRpc({
    call: vi.fn((method: string) => {
      if (method === 'hexbot.rooms.list') {
        return Promise.resolve({ rooms: [room] })
      }

      if (method === 'hexbot.rooms.get') {
        return get.promise
      }

      if (method === 'hexbot.rooms.log') {
        return logs++ === 0 ? after.promise : Promise.resolve({ events: newer })
      }

      if (method === 'hexbot.rooms.mark_read') {
        return mark.promise
      }

      return Promise.resolve({})
    })
  } as never)
  // Supervisor's roster refresh: its log read for x is in flight.
  const refreshing = useRooms.getState().refresh()
  await waitFor(() => expect(logs).toBe(1))
  // The mounted room view: useRoomOrLeave open, then room.tsx marks the cached tail read.
  const opening = useRooms.getState().open('x')
  const marking = useRooms.getState().markRead('x', 50)
  after.resolve({ events: newer })
  get.resolve({ room })
  await refreshing
  const outcome = await opening
  mark.resolve({ room })
  await marking
  expect({ outcome, last: useRooms.getState().eventsByRoom.x?.at(-1)?.seq }).toEqual({
    outcome: 'present',
    last: 60
  })
})

it.each(['live event', 'cached roster log'] as const)(
  'RoomConversation retains history with a held read acknowledgment during %s hydration',
  async source => {
    const get = deferred<{ room: Room }>()
    const log = deferred<{ events: RoomEvent[] }>()
    const mark = deferred<{ room: Room }>()
    const tail = Array.from({ length: 50 }, (_, i) => event(i + 1))

    const fresh =
      source === 'live event' ? tail : Array.from({ length: 10 }, (_, i) => event(i + 51))

    const call = vi.fn((method: string) => {
      if (method === 'hexbot.rooms.list') {
        return Promise.resolve({ rooms: [room] })
      }

      if (method === 'hexbot.rooms.get') {
        return get.promise
      }

      if (method === 'hexbot.rooms.log') {
        return log.promise
      }

      if (method === 'hexbot.rooms.mark_read') {
        return mark.promise
      }

      return Promise.resolve({})
    })

    setActiveRpc({ call } as never)
    useRooms.setState({ byId: { x: room }, order: ['x'] })
    let refreshing: Promise<void> | undefined

    if (source === 'cached roster log') {
      useRooms.getState().restore([room], { x: tail }, { x: 1 })
      refreshing = useRooms.getState().refresh()
      await waitFor(() =>
        expect(call).toHaveBeenCalledWith('hexbot.rooms.log', {
          id: 'x',
          after_seq: 50,
          limit: 1000
        })
      )
    }

    render(<RoomConversation />)
    await waitFor(() => expect(call).toHaveBeenCalledWith('hexbot.rooms.get', { id: 'x' }))

    if (source === 'live event') {
      act(() => useRooms.getState().handleEvent('x', event(51)))
    }

    const marked = source === 'live event' ? 51 : 50
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('hexbot.rooms.mark_read', { id: 'x', seq: marked })
    )

    try {
      await act(async () => {
        get.resolve({ room })
        log.resolve({ events: fresh })
        await refreshing
      })
      const last = source === 'live event' ? 51 : 60
      await waitFor(() => expect(useRooms.getState().eventsByRoom.x).toHaveLength(last))
      expect(useRooms.getState().logBaseline.x).toBe(1)
      expect(screen.getByText('m1')).toBeVisible()
      expect(screen.getByText(`m${last}`)).toBeVisible()
    } finally {
      await act(async () => {
        mark.resolve({ room })
      })
    }
  }
)

it.each(['success', 'permission error'] as const)(
  'a delayed read-mark %s cannot overwrite a newer open or membership lookup',
  async result => {
    useRooms.getState().restore([room], {})
    let reject!: (error: Error) => void
    let resolve!: (value: { room: Room }) => void

    const mark = new Promise<{ room: Room }>((yes, no) => {
      resolve = yes
      reject = no
    })

    const newer = { ...room, name: 'Current membership', archived_at: 123, members: [] }
    setActiveRpc({
      call: (method: string) =>
        method === 'hexbot.rooms.mark_read'
          ? mark
          : Promise.resolve(method === 'hexbot.rooms.log' ? { events: [] } : { room: newer })
    } as never)
    const marking = useRooms.getState().markRead('x', 50)
    await useRooms.getState().open('x')
    await useRooms.getState().refreshOne('x')

    if (result === 'success') {
      resolve({ room })
    } else {
      reject(Object.assign(new Error('Old membership error'), { code: 4302 }))
    }

    await marking
    expect(useRooms.getState().byId.x).toEqual(newer)
    expect(useRooms.getState().answers.x).toBe('present')
  }
)

it('read acknowledgments only advance existing member positions without becoming room authority', async () => {
  const member = {
    member_id: 'local',
    member_kind: 'human',
    last_read_seq: 5
  } as Room['members'][number]

  const current = { ...room, members: [member], name: 'Current name' }
  useRooms.getState().restore([current], {})
  setActiveRpc({
    call: async () => ({
      room: {
        ...room,
        name: 'Stale name',
        archived_at: 100,
        members: [
          { ...member, last_read_seq: 10 },
          { ...member, member_id: 'obsolete' }
        ]
      }
    })
  } as never)
  const answers = useRooms.getState().answers
  await useRooms.getState().markRead('x', 10)
  expect(useRooms.getState().byId.x).toEqual({
    ...current,
    members: [{ ...member, last_read_seq: 10 }]
  })
  expect(useRooms.getState().answers).toBe(answers)
})
