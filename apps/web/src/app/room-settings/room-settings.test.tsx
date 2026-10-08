import { JsonRpcGatewayError } from '@hermes/shared'
import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'

import { useRoomOrLeave } from '../../lib/room-or-leave'
import { setActiveRpc } from '../../lib/rpc'
import type { Bot, Room } from '../../lib/types'
import { useBots } from '../../stores/bots'
import { useConnection } from '../../stores/connection'
import { useRooms } from '../../stores/rooms'

import { RoomSettingsPanel } from './index'

const navigate = vi.fn()

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))

const room = (members: string[], people: string[] = []): Room => ({
  approval_mode: 'manual',
  archived_at: null,
  created_at: 0,
  id: 'r1',
  last_activity_at: 0,
  limits: { bot_turns_per_human_turn: 8, budget_tokens_per_human_turn: null },
  main_bot: members[0] ?? null,
  members: [
    ...members.map(id => ({ id, kind: 'bot' as const })),
    ...people.map(id => ({ id, kind: 'human' as const }))
  ].map(({ id, kind }) => ({
    added_at: 0,
    added_by: 'local',
    last_read_seq: 0,
    left_at: null,
    member_id: id,
    member_kind: kind,
    room_id: 'r1'
  })),
  name: 'Lab',
  owner_id: 'local',
  updated_at: 0
})

describe('room settings', () => {
  beforeEach(() => {
    navigate.mockReset()
    useBots.setState({
      byName: {
        scout: { avatar: null, display_name: 'Scout', name: 'scout', title: 'Research' } as Bot,
        writer: { avatar: null, display_name: 'Writer', name: 'writer', title: '' } as Bot
      }
    })
  })

  it('names bots from member rows when their profiles are not loaded', () => {
    const one = room(['scout'])
    one.members[0]!.display_name = 'Scout'
    useBots.setState({ byName: {} })
    render(<RoomSettingsPanel room={one} />)
    expect(screen.getAllByTestId('room-member')[0]).toHaveTextContent('Scout')
  })

  it('removes a member only after a second click', async () => {
    const two = room(['scout', 'writer'])
    useRooms.setState({ byId: { r1: two }, eventsByRoom: {}, liveTurnsByRoom: {}, order: ['r1'] })

    const call = vi.fn((method: string) =>
      method === 'hexbot.rooms.remove_member'
        ? Promise.resolve({ room: room(['scout']) })
        : Promise.reject(new Error(`unexpected ${method}`))
    )

    setActiveRpc({ call } as never)
    render(<RoomSettingsPanel room={two} />)
    expect(screen.getAllByTestId('room-member')).toHaveLength(2)
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[1]!)
    expect(call).not.toHaveBeenCalled()
    const confirm = screen.getByRole('alertdialog')
    expect(confirm).toHaveTextContent('Remove Writer from this room?')
    fireEvent.click(within(confirm).getByRole('button', { name: 'Remove' }))

    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('hexbot.rooms.remove_member', { bot: 'writer', id: 'r1' })
    )
    expect(navigate).not.toHaveBeenCalled()
  })

  it('warns that removing the last bot deletes the room, then leaves it', async () => {
    const one = room(['scout'])
    useRooms.setState({ byId: { r1: one }, eventsByRoom: {}, liveTurnsByRoom: {}, order: ['r1'] })

    setActiveRpc({
      call: vi.fn(() => Promise.resolve({ room: { ...one, deleted: true } }))
    } as never)

    render(<RoomSettingsPanel room={one} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(screen.getByRole('alertdialog')).toHaveTextContent('deletes this room')
    expect(screen.getByRole('alertdialog')).toHaveTextContent('The bot itself stays')
    fireEvent.click(screen.getByRole('button', { name: 'Remove and delete room' }))

    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: '/' }))
    expect(useRooms.getState().byId.r1).toBeUndefined()
  })

  it('gives you every control, with no people or leave options', () => {
    const two = room(['scout', 'writer'], ['local'])
    useRooms.setState({ byId: { r1: two }, eventsByRoom: {}, liveTurnsByRoom: {}, order: ['r1'] })
    render(<RoomSettingsPanel room={two} />)
    expect(screen.getByText('2 bots and you.')).toBeVisible()
    expect(screen.getAllByTestId('room-member')).toHaveLength(2)
    expect(screen.getByLabelText('Room name')).toBeVisible()
    expect(screen.getByText('Approval mode')).toBeVisible()

    for (const name of ['Add bot', 'Delete']) {
      expect(screen.getByRole('button', { name })).toBeVisible()
    }

    for (const name of ['Add person', 'Leave']) {
      expect(screen.queryByRole('button', { name })).toBeNull()
    }

    expect(screen.queryByText('People')).toBeNull()
    expect(screen.queryByRole('note')).toBeNull()
  })

  it('deletes the room only after the name is typed back', async () => {
    const one = room(['scout'])
    useRooms.setState({ byId: { r1: one }, eventsByRoom: {}, liveTurnsByRoom: {}, order: ['r1'] })
    const call = vi.fn(() => Promise.resolve({ deleted: true }))
    setActiveRpc({ call } as never)

    render(<RoomSettingsPanel room={one} />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(screen.getByRole('button', { name: 'Delete permanently' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Confirm room name'), { target: { value: 'Lab' } })
    fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }))

    await waitFor(() => expect(call).toHaveBeenCalledWith('hexbot.rooms.delete', { id: 'r1' }))
    expect(navigate).toHaveBeenCalledWith({ to: '/' })
  })
})

describe('a room settings deep link', () => {
  beforeEach(() => {
    navigate.mockReset()
    useRooms.setState({ byId: {}, eventsByRoom: {}, liveTurnsByRoom: {}, order: [] })
  })

  it('stays while the daemon cannot be reached and loads the room on reconnect', async () => {
    let online = false

    const call = vi.fn((method: string) =>
      !online
        ? Promise.reject(new Error('socket closed'))
        : Promise.resolve(method === 'hexbot.rooms.get' ? { room: room(['scout']) } : {})
    )

    setActiveRpc({ call } as never)
    useConnection.setState({ status: 'reconnecting' })
    const { result } = renderHook(() => useRoomOrLeave('r1', 'refresh'))
    // Not gone, only unreachable: the fallback list refresh fails as well.
    await waitFor(() => expect(useRooms.getState().error).toBe('socket closed'))
    await act(async () => {})
    expect(navigate).not.toHaveBeenCalled()
    expect(result.current).toBeUndefined()
    online = true
    act(() => useConnection.setState({ status: 'connected' }))
    await waitFor(() => expect(result.current?.id).toBe('r1'))
    expect(navigate).not.toHaveBeenCalled()
  })

  it.each([4230, 4302])(
    'leaves for home once the daemon says the room is gone (%i)',
    async code => {
      setActiveRpc({
        call: vi.fn(() => Promise.reject(new JsonRpcGatewayError('gone', { code })))
      } as never)
      useConnection.setState({ status: 'connected' })
      renderHook(() => useRoomOrLeave('r1', 'refresh'))
      await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: '/' }))
    }
  )

  it('leaves for home when an open room is removed', async () => {
    useRooms.setState({ byId: { r1: room(['scout']) }, order: ['r1'] })
    renderHook(() => useRoomOrLeave('r1', 'refresh'))
    expect(navigate).not.toHaveBeenCalled()
    act(() => useRooms.getState().drop('r1'))
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: '/' }))
  })
})
