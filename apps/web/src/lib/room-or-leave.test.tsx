import { act, render, renderHook, waitFor } from '@testing-library/react'

import { invalidateConnectionReads, useConnection } from '../stores/connection'
import { useRooms } from '../stores/rooms'

import { useRoomOrLeave } from './room-or-leave'
import { setActiveRpc } from './rpc'
import type { Room } from './types'

const navigate = vi.fn()
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))

const room = { id: 'r', members: [], name: 'Room' } as unknown as Room

beforeEach(() => {
  navigate.mockReset()
  useConnection.setState({ target: { kind: 'local' }, epoch: null, status: 'connecting' })
  useRooms.getState().reset()
  setActiveRpc(null)
})
afterEach(() => setActiveRpc(null))

it.each(['open', 'refresh'] as const)(
  'keeps a cold %s deep link when the handshake invalidates its queued read',
  async load => {
    const { result } = renderHook(() => useRoomOrLeave('r', load))

    const call = vi.fn((method: string) =>
      Promise.resolve(method === 'hexbot.rooms.log' ? { events: [] } : { room })
    )

    await act(async () => {
      // Root startup resets the stores after the child mounted. The queued
      // request reaches this socket, but its pre-handshake epoch is obsolete.
      invalidateConnectionReads()
      useConnection.getState().setEpoch('ready')
      setActiveRpc({ call } as never)
      useConnection.getState().setStatus('connected')
    })

    await waitFor(() => expect(result.current?.id).toBe('r'))
    expect(navigate).not.toHaveBeenCalled()
  }
)

it.each(['open', 'refresh'] as const)(
  'does not treat a discarded %s read as proof that a room was deleted',
  async load => {
    let finish!: (value: { room: Room }) => void

    const held = new Promise<{ room: Room }>(resolve => {
      finish = resolve
    })

    setActiveRpc({
      call: vi.fn((method: string) =>
        method === 'hexbot.rooms.log' ? Promise.resolve({ events: [] }) : held
      )
    } as never)
    useConnection.setState({ status: 'connected', epoch: 'old' })
    renderHook(() => useRoomOrLeave('r', load))

    await act(async () => {
      invalidateConnectionReads()
      useConnection.getState().setEpoch('replacement')
      finish({ room })
    })
    expect(navigate).not.toHaveBeenCalled()
  }
)

it.each(['open', 'refresh'] as const)(
  'keeps a previously loaded %s room while reconnect clears personal state',
  async load => {
    setActiveRpc({
      call: vi.fn((method: string) =>
        Promise.resolve(method === 'hexbot.rooms.log' ? { events: [] } : { room })
      )
    } as never)
    useConnection.setState({ status: 'connected', epoch: 'ready' })
    const { result } = renderHook(() => useRoomOrLeave('r', load))
    await waitFor(() => expect(result.current?.id).toBe('r'))
    await act(async () => {})

    act(() => {
      invalidateConnectionReads()
      setActiveRpc(null)
      useConnection.getState().setStatus('reconnecting')
      useRooms.getState().reset()
    })
    expect(navigate).not.toHaveBeenCalled()
  }
)

it.each(['cache', 'list'] as const)(
  'leaves cold settings after a gone lookup crossed a %s restore',
  async source => {
    let reject!: (error: Error) => void

    const held = new Promise<{ room: Room }>((_yes, no) => {
      reject = no
    })

    const call = vi.fn((method: string): Promise<unknown> =>
      method === 'hexbot.rooms.get' ? held : Promise.resolve({ rooms: [] })
    )

    setActiveRpc({ call } as never)
    useConnection.setState({ status: 'connected', epoch: 'ready' })
    renderHook(() => useRoomOrLeave('r', 'refresh'))
    await act(async () => {
      if (source === 'cache') {
        useRooms.getState().restore([room], {})
      } else {
        call.mockImplementationOnce(() => Promise.resolve({ rooms: [room] }))
        call.mockImplementationOnce(() => Promise.resolve({ events: [] }))
        await useRooms.getState().refresh()
        await useRooms.getState().refresh()
      }

      reject(Object.assign(new Error('Room gone'), { code: 4230 }))
    })
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: '/' }))
    expect(useRooms.getState().byId.r).toBeUndefined()
  }
)

it('keeps valid cold settings when the authoritative list supersedes a stale gone lookup', async () => {
  let reject!: (error: Error) => void

  const held = new Promise<{ room: Room }>((_yes, no) => {
    reject = no
  })

  setActiveRpc({
    call: vi.fn((method: string) =>
      method === 'hexbot.rooms.get'
        ? held
        : Promise.resolve(method === 'hexbot.rooms.list' ? { rooms: [room] } : { events: [] })
    )
  } as never)
  useConnection.setState({ status: 'connected', epoch: 'ready' })
  const { result } = renderHook(() => useRoomOrLeave('r', 'refresh'))
  await act(async () => {
    await useRooms.getState().refresh()
    reject(Object.assign(new Error('Obsolete gone lookup'), { code: 4230 }))
  })
  expect(result.current).toEqual(room)
  expect(navigate).not.toHaveBeenCalled()
})

it('concurrent settings hooks do not turn a superseded open into missing membership', async () => {
  let first!: (value: { room: Room }) => void
  let second!: (value: { room: Room }) => void

  const old = new Promise<{ room: Room }>(yes => {
    first = yes
  })

  const latest = new Promise<{ room: Room }>(yes => {
    second = yes
  })

  let gets = 0
  setActiveRpc({
    call: vi.fn((method: string) =>
      method === 'hexbot.rooms.get'
        ? ++gets === 1
          ? old
          : latest
        : Promise.resolve({ events: [] })
    )
  } as never)
  useConnection.setState({ status: 'connected', epoch: 'ready' })

  function Shell() {
    useRoomOrLeave('r', 'open')

    return null
  }

  function Settings() {
    useRoomOrLeave('r', 'refresh')

    return <Shell />
  }

  render(<Settings />)
  await waitFor(() => expect(gets).toBe(2))

  try {
    await act(async () => {
      first({ room })
    })
    expect(navigate).not.toHaveBeenCalled()
  } finally {
    await act(async () => {
      second({ room })
    })
  }

  await waitFor(() => expect(useRooms.getState().byId.r).toEqual(room))
  expect(navigate).not.toHaveBeenCalled()
})

it('settings observes a newer gone open after its own lookup was discarded', async () => {
  let finish!: (value: { room: Room }) => void
  let reject!: (error: Error) => void

  const old = new Promise<{ room: Room }>(yes => {
    finish = yes
  })

  const latest = new Promise<{ room: Room }>((_yes, no) => {
    reject = no
  })

  let gets = 0
  setActiveRpc({
    call: (method: string) =>
      method === 'hexbot.rooms.get'
        ? ++gets === 1
          ? old
          : latest
        : Promise.resolve({ events: [] })
  } as never)
  useConnection.setState({ status: 'connected', epoch: 'ready' })
  renderHook(() => useRoomOrLeave('r', 'refresh'))
  let opening!: ReturnType<ReturnType<typeof useRooms.getState>['open']>
  act(() => {
    opening = useRooms.getState().open('r')
  })
  await act(async () => {
    finish({ room })
  })
  expect(navigate).not.toHaveBeenCalled()
  await act(async () => {
    reject(Object.assign(new Error('Gone'), { code: 4230 }))
    await opening
  })
  await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: '/' }))
  expect(useRooms.getState().byId.r).toBeUndefined()
})

it.each(['open', 'refresh'] as const)(
  'retries a %s when identity changes without a status transition',
  async load => {
    setActiveRpc({
      call: (method: string) =>
        Promise.resolve(method === 'hexbot.rooms.log' ? { events: [] } : { room })
    } as never)
    useConnection.setState({ status: 'connected', epoch: 'first' })
    const { result } = renderHook(() => useRoomOrLeave('r', load))
    await waitFor(() => expect(result.current?.id).toBe('r'))
    await act(async () => {
      invalidateConnectionReads()
      useRooms.getState().reset()
      useConnection.getState().setEpoch('replacement')
    })
    await waitFor(() => expect(result.current?.id).toBe('r'))
    expect(navigate).not.toHaveBeenCalled()
  }
)
