import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import { setActiveRpc } from '../../lib/rpc'
import type { Bot, Room } from '../../lib/types'
import { useBots } from '../../stores/bots'
import { useRooms } from '../../stores/rooms'

import { RoomSettingsPanel } from './index'

const navigate = vi.fn()

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))

const room = (members: string[]): Room => ({
  approval_mode: 'manual',
  archived_at: null,
  created_at: 0,
  id: 'r1',
  last_activity_at: 0,
  limits: { bot_turns_per_human_turn: 8, budget_tokens_per_human_turn: null },
  main_bot: members[0] ?? null,
  members: members.map(id => ({
    added_at: 0,
    added_by: 'local',
    last_read_seq: 0,
    left_at: null,
    member_id: id,
    member_kind: 'bot' as const,
    room_id: 'r1'
  })) as Room['members'],
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
