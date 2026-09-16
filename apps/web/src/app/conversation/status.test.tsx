import { render, screen } from '@testing-library/react'

import type { Bot, RoomEvent } from '../../lib/types'
import { useBots } from '../../stores/bots'

import { ComposerShell } from './composer'
import { RoomEventRow } from './room'


describe('composer status', () => {
  it('draws the notice and colours the pill to match the bot dot', () => {
    const { rerender } = render(
      <ComposerShell canSend notice="Network down" onSend={vi.fn()} status="stopped" streaming={false}>
        <textarea />
      </ComposerShell>
    )

    expect(screen.getByRole('alert')).toHaveTextContent('Network down')
    expect(screen.getByRole('alert')).toHaveClass('text-danger')
    expect(document.querySelector('[data-status="stopped"]')).toHaveClass('border-danger/70')

    rerender(
      <ComposerShell canSend notice="Waiting on you" onSend={vi.fn()} status="needs_you" streaming={false}>
        <textarea />
      </ComposerShell>
    )
    expect(screen.getByRole('status')).toHaveClass('text-accent')
    expect(document.querySelector('[data-status="needs_you"]')).toHaveClass('border-accent/70')
  })
})

describe('room transcript', () => {
  it('shows a failed turn as a red banner naming the bot', () => {
    useBots.setState({ byName: { writer: { display_name: 'Writer', name: 'writer' } as Bot } })

    const event: RoomEvent = {
      actor_id: 'writer',
      actor_kind: 'bot',
      created_at: 1,
      kind: 'turn.failed',
      payload: { error: 'Network down' },
      room_id: 'r',
      seq: 1
    }

    render(<RoomEventRow event={event} />)
    expect(screen.getByRole('alert')).toHaveTextContent('Writer stopped · Network down')
    expect(screen.getByRole('alert')).toHaveClass('text-danger')
  })
})
