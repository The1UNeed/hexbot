import { JsonRpcGatewayError } from '@hermes/shared'
import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'

import { useRoomOrLeave } from '../../lib/room-or-leave'
import { setActiveRpc } from '../../lib/rpc'
import type { Bot, Room } from '../../lib/types'
import { useBots } from '../../stores/bots'
import { useConnection } from '../../stores/connection'
import { useRooms } from '../../stores/rooms'
import { useUsers } from '../../stores/users'

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
    useUsers.setState({ current: null, supported: false, users: [] })
    useBots.setState({
      byName: {
        scout: { avatar: null, display_name: 'Scout', name: 'scout', title: 'Research' } as Bot,
        writer: { avatar: null, display_name: 'Writer', name: 'writer', title: '' } as Bot
      }
    })
  })

  it('names bots from member rows when the member cannot read their profiles', () => {
    const shared = room(['scout'], ['local', 'bob'])
    shared.members[0]!.display_name = 'Scout'
    useBots.setState({ byName: {} })
    useUsers.setState({
      current: { display_name: 'Bob', id: 'bob', role: 'member' },
      supported: true
    })
    render(<RoomSettingsPanel room={shared} />)
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

  it('shows members without controls to a human member who is not the owner', () => {
    const two = room(['scout', 'writer'])
    useRooms.setState({ byId: { r1: two }, eventsByRoom: {}, liveTurnsByRoom: {}, order: ['r1'] })
    useUsers.setState({ current: { display_name: 'Bob', id: 'bob', role: 'member' } })
    const { unmount } = render(<RoomSettingsPanel room={two} />)
    expect(screen.getAllByTestId('room-member')).toHaveLength(2)
    expect(screen.getByRole('note')).toHaveTextContent(
      'Only the person who created this room can change its name, members and settings.'
    )

    for (const name of ['Remove', 'Make main', 'Add bot', 'Add person', 'Delete']) {
      expect(screen.queryByRole('button', { name })).toBeNull()
    }

    expect(screen.queryByLabelText('Room name')).toBeNull()
    expect(screen.queryByText('Approval mode')).toBeNull()
    unmount()
    useUsers.setState({ current: { display_name: 'Local', id: 'local', role: 'admin' } })
    render(<RoomSettingsPanel room={two} />)
    expect(screen.queryByRole('note')).toBeNull()
    expect(screen.getByRole('button', { name: 'Delete' })).toBeVisible()
    expect(screen.getByLabelText('Room name')).toBeVisible()
  })

  it('shows no owner controls and no note while the current user is unknown', () => {
    const two = room(['scout', 'writer'])
    useUsers.setState({ current: null, supported: null })
    render(<RoomSettingsPanel room={two} />)
    expect(screen.getAllByTestId('room-member')).toHaveLength(2)

    for (const name of ['Remove', 'Make main', 'Add bot', 'Add person', 'Delete', 'Leave']) {
      expect(screen.queryByRole('button', { name })).toBeNull()
    }

    expect(screen.queryByRole('note')).toBeNull()
    expect(screen.queryByLabelText('Room name')).toBeNull()
  })

  it('lets the owner remove a person after a second click, but not themselves', async () => {
    const shared = room(['scout'], ['local', 'bob'])
    useRooms.setState({
      byId: { r1: shared },
      eventsByRoom: {},
      liveTurnsByRoom: {},
      order: ['r1']
    })
    useUsers.setState({
      current: { display_name: 'Local', id: 'local', role: 'admin' },
      supported: true,
      users: [
        { display_name: 'Local', id: 'local', role: 'admin' },
        { display_name: 'Bob', id: 'bob', role: 'member' }
      ]
    })
    const call = vi.fn(() => Promise.resolve({ room: room(['scout'], ['local']) }))
    setActiveRpc({ call } as never)
    render(<RoomSettingsPanel room={shared} />)
    expect(screen.getByText('People')).toBeVisible()
    // One bot row, then the people.
    const rows = screen.getAllByTestId('room-member').slice(1)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent('Owner')
    expect(within(rows[0]!).queryByRole('button', { name: 'Remove' })).toBeNull()
    fireEvent.click(within(rows[1]!).getByRole('button', { name: 'Remove' }))
    expect(call).not.toHaveBeenCalled()
    const confirm = screen.getByRole('alertdialog')
    expect(confirm).toHaveTextContent(
      'Remove Bob from this room? They can no longer read or post in it.'
    )
    fireEvent.click(within(confirm).getByRole('button', { name: 'Remove' }))

    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('hexbot.rooms.remove_member', { id: 'r1', user: 'bob' })
    )
    expect(screen.queryByRole('button', { name: 'Leave' })).toBeNull()
  })

  it('lets the owner add a person back when only the owner remains', async () => {
    const alone = room(['scout'], ['local', 'bob'])
    alone.members.find(member => member.member_id === 'bob')!.left_at = 1
    const added = room(['scout'], ['local', 'bob'])
    useRooms.setState({ byId: { r1: alone }, order: ['r1'] })
    useUsers.setState({
      current: { display_name: 'Local', id: 'local', role: 'admin' },
      supported: true,
      users: [
        { display_name: 'Local', id: 'local', role: 'admin' },
        { display_name: 'Bob', id: 'bob', role: 'member' },
        { display_name: 'Disabled', id: 'disabled', role: 'member', disabled_at: 1 }
      ]
    })
    const call = vi.fn(() => Promise.resolve({ room: added }))
    setActiveRpc({ call } as never)
    const { rerender } = render(<RoomSettingsPanel room={alone} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add person' }))
    expect(screen.queryByRole('menuitem', { name: 'Local' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'Disabled' })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Bob' }))
    await waitFor(() => expect(useRooms.getState().byId.r1).toEqual(added))
    expect(call).toHaveBeenCalledWith('hexbot.rooms.add_member', { id: 'r1', user: 'bob' })
    rerender(<RoomSettingsPanel room={added} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add person' }))
    expect(screen.queryByRole('menuitem', { name: 'Bob' })).toBeNull()
    expect(screen.getByRole('menuitem', { name: 'Everyone is already a member' })).toHaveAttribute(
      'aria-disabled',
      'true'
    )
  })

  it('loads the people directory for an owner who is not an admin', async () => {
    const owned = { ...room(['scout'], ['bob']), owner_id: 'bob' }
    useUsers.setState({
      current: { display_name: 'Bob', id: 'bob', role: 'member' },
      supported: true,
      users: []
    })

    const call = vi.fn((method: string) =>
      Promise.resolve(
        method === 'hexbot.rooms.people'
          ? {
              users: [
                { id: 'local', display_name: 'Local' },
                { id: 'bob', display_name: 'Bob' }
              ]
            }
          : { room: { ...owned, members: room(['scout'], ['bob', 'local']).members } }
      )
    )

    setActiveRpc({ call } as never)
    render(<RoomSettingsPanel room={owned} />)
    await waitFor(() => expect(call).toHaveBeenCalledWith('hexbot.rooms.people', { id: 'r1' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Add person' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Local' }))
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('hexbot.rooms.add_member', { id: 'r1', user: 'local' })
    )
  })

  it('hides People on a daemon with one person, as without accounts', () => {
    const solo = room(['scout'], ['local'])
    useUsers.setState({
      current: { display_name: 'Local', id: 'local', role: 'admin' },
      supported: true,
      users: [{ display_name: 'Local', id: 'local', role: 'admin' }]
    })
    render(<RoomSettingsPanel room={solo} />)
    expect(screen.getByText('Bots')).toBeVisible()
    expect(screen.getByText('1 bot and you.')).toBeVisible()
    expect(screen.queryByText('People')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Add person' })).toBeNull()
  })

  it('names the people in the room for a member who cannot list users', () => {
    const shared = room(['scout'], ['local', 'bob'])
    shared.members = shared.members.map(member =>
      member.member_kind === 'human'
        ? { ...member, display_name: member.member_id === 'local' ? 'Alice' : 'Bob' }
        : member
    )
    useUsers.setState({
      current: { display_name: 'Bob', id: 'bob', role: 'member' },
      supported: true,
      users: []
    })
    render(<RoomSettingsPanel room={shared} />)
    expect(screen.getByText('1 bot and 2 people.')).toBeVisible()
    const rows = screen.getAllByTestId('room-member').slice(1)
    expect(rows[0]).toHaveTextContent('AliceOwner')
    expect(rows[1]).toHaveTextContent('BobYou')
  })

  it('lets a member leave the room and forgets it', async () => {
    const shared = room(['scout'], ['local', 'bob'])
    useRooms.setState({
      byId: { r1: shared },
      eventsByRoom: {},
      liveTurnsByRoom: {},
      order: ['r1']
    })
    useUsers.setState({
      current: { display_name: 'Bob', id: 'bob', role: 'member' },
      supported: true
    })
    const call = vi.fn(() => Promise.resolve({ room: room(['scout'], ['local']) }))
    setActiveRpc({ call } as never)
    render(<RoomSettingsPanel room={shared} />)
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Leave' }))
    expect(call).not.toHaveBeenCalled()
    expect(screen.getByText('Leave this room? You can no longer read or post in it.')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Leave room' }))

    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: '/' }))
    expect(call).toHaveBeenCalledWith('hexbot.rooms.remove_member', { id: 'r1', user: 'bob' })
    expect(useRooms.getState().byId.r1).toBeUndefined()
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
