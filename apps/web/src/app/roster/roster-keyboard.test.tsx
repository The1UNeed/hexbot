import { fireEvent, render, screen } from '@testing-library/react'
import { vi } from 'vitest'

import type { Room } from '../../lib/types'
import { useRooms } from '../../stores/rooms'

import { RosterColumn } from './index'

// The ui store persists to localStorage, which Node shadows without a file; give it memory.
vi.hoisted(() => {
  const items = new Map<string, string>()

  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      clear: () => items.clear(),
      getItem: (key: string) => items.get(key) ?? null,
      key: (index: number) => [...items.keys()][index] ?? null,
      get length() {
        return items.size
      },
      removeItem: (key: string) => items.delete(key),
      setItem: (key: string, value: string) => items.set(key, String(value))
    }
  })
})

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
  it('leaves Enter in a context menu to the menu', async () => {
    useRooms.setState({ byId: { [room.id]: room }, order: [room.id] })
    render(<RosterColumn />)
    const row = screen.getByRole('button', { name: /Garden/ })

    // Arrow keys focus the room row, so Enter there would open the room.
    fireEvent.keyDown(row, { key: 'ArrowDown' })
    fireEvent.contextMenu(row)
    const item = await screen.findByRole('menuitem', { name: 'Settings' })
    fireEvent.keyDown(item, { key: 'Enter' })
    fireEvent.click(item)

    expect(navigate).toHaveBeenCalledOnce()
    expect(navigate).toHaveBeenCalledWith({ params: { room: 'garden' }, to: '/r/$room/settings' })
  })
})
