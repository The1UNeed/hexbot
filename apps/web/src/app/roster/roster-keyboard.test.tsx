import { fireEvent, render, screen } from '@testing-library/react'
import { vi } from 'vitest'

import type { Room } from '../../lib/types'
import { useRooms } from '../../stores/rooms'

import { RosterColumn } from './index'

const navigate = vi.hoisted(() => vi.fn())

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  useParams: () => ({})
}))

const room = {
  approval_mode: null,
  archived_at: null,
  created_at: 0,
  id: 'garden',
  last_activity_at: 0,
  limits: {},
  main_bot: null,
  members: [],
  name: 'Garden',
  owner_id: 'local',
  updated_at: 0
} as unknown as Room

describe('RosterColumn keyboard', () => {
  beforeEach(() => {
    navigate.mockClear()
    useRooms.setState({ byId: { [room.id]: room }, order: [room.id] })
  })

  it('opens the focused row from the search box', () => {
    render(<RosterColumn />)
    const search = screen.getByLabelText('Search bots and sections')

    fireEvent.keyDown(search, { key: 'ArrowDown' })
    fireEvent.keyDown(search, { key: 'Enter' })

    expect(navigate).toHaveBeenCalledWith({ params: { room: 'garden' }, to: '/r/$room' })
  })

  it('leaves Enter in a context menu to the menu', async () => {
    render(<RosterColumn />)
    const row = screen.getByRole('button', { name: /Garden/ })

    // Arrow keys focus the room row, so Enter there would open the room.
    fireEvent.keyDown(row, { key: 'ArrowDown' })
    fireEvent.contextMenu(row)
    fireEvent.keyDown(await screen.findByRole('menuitem', { name: 'Settings' }), { key: 'Enter' })

    expect(screen.queryByRole('menuitem')).toBeNull()
    expect(navigate).toHaveBeenCalledOnce()
    expect(navigate).toHaveBeenCalledWith({ params: { room: 'garden' }, to: '/r/$room/settings' })
  })

  it('leaves Enter on other sidebar buttons to the button', () => {
    render(<RosterColumn />)

    fireEvent.keyDown(screen.getByRole('button', { name: /Garden/ }), { key: 'ArrowDown' })
    const event = fireEvent.keyDown(screen.getByRole('button', { name: 'New' }), { key: 'Enter' })

    expect(event).toBe(true)
    expect(navigate).not.toHaveBeenCalled()
  })
})
