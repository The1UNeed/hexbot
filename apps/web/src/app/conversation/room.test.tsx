import { fireEvent, render, screen } from '@testing-library/react'

import type { Bot, RoomMember } from '../../lib/types'

import { RoomMentionPopover } from './room'

describe('room composer mentions', () => {
  it('lists bot members, filters by the typed handle, and never offers user', () => {
    const select = vi.fn()

    const members = [
      { member_id: 'writer', member_kind: 'bot' },
      { member_id: 'planner', member_kind: 'bot' }
    ] as RoomMember[]

    const bots = {
      planner: { display_name: 'Planner' } as Bot,
      writer: { display_name: 'Writer' } as Bot
    }

    render(<RoomMentionPopover bots={bots} members={members} onSelect={select} query="wri" />)
    expect(screen.getByRole('button', { name: /@writer/ })).toBeVisible()
    expect(screen.queryByText('@user')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /@writer/ }))
    expect(select).toHaveBeenCalledWith('writer')
  })
})
