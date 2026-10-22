import { act, renderHook, waitFor } from '@testing-library/react'

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
