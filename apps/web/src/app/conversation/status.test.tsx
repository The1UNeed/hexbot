import { render, screen } from '@testing-library/react'

import type { Bot, RoomEvent } from '../../lib/types'
import { useBots } from '../../stores/bots'
import { useMe } from '../../stores/me'
import { useRooms } from '../../stores/rooms'

import { ComposerShell } from './composer'
import { RoomEventRow } from './room'

describe('composer status', () => {
  it('draws the notice and colours the pill to match the bot dot', () => {
    const { rerender } = render(
      <ComposerShell
        canSend
        notice="Network down"
        onSend={vi.fn()}
        status="stopped"
        streaming={false}
      >
        <textarea />
      </ComposerShell>
    )

    expect(screen.getByRole('alert')).toHaveTextContent('Network down')
    expect(screen.getByRole('alert')).toHaveClass('text-danger')
    expect(document.querySelector('[data-status="stopped"]')).toHaveClass('border-danger/70')

    rerender(
      <ComposerShell
        canSend
        notice="Waiting on you"
        onSend={vi.fn()}
        status="needs_you"
        streaming={false}
      >
        <textarea />
      </ComposerShell>
    )
    expect(screen.getByRole('status')).toHaveClass('text-accent')
    expect(document.querySelector('[data-status="needs_you"]')).toHaveClass('border-accent/70')
  })
})

describe('room transcript', () => {
  it('names bots from member rows when their profiles are not loaded', () => {
    useBots.setState({ byName: {} })
    useMe.setState({ me: { display_name: 'Bob', id: 'bob' } })
    useRooms.setState({
      byId: {
        r: {
          id: 'r',
          members: [{ display_name: 'Writer', member_id: 'writer', member_kind: 'bot' }]
        } as never
      }
    })

    const event: RoomEvent = {
      actor_id: 'writer',
      actor_kind: 'bot',
      created_at: 1,
      kind: 'message.bot',
      payload: { text: 'Hello' },
      room_id: 'r',
      seq: 1
    }

    render(
      <>
        <RoomEventRow event={event} />
        <RoomEventRow
          event={{ ...event, kind: 'turn.failed', payload: { error: 'Network down' }, seq: 2 }}
        />
        <RoomEventRow
          event={{
            ...event,
            actor_id: 'alice',
            actor_kind: 'human',
            kind: 'member.added',
            payload: { bot: 'writer' },
            seq: 3
          }}
        />
      </>
    )
    expect(screen.getByText('Writer')).toBeVisible()
    expect(screen.getByRole('alert')).toHaveTextContent('Writer stopped · Network down')
    expect(screen.getByText('Writer joined the room')).toBeVisible()
  })
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

  it('names the person who left an earlier room, not whoever removed them', () => {
    useMe.setState({ me: { display_name: 'Alice', id: 'alice' } })
    useRooms.setState({
      byId: {
        r: {
          id: 'r',
          members: [{ display_name: 'Bob', member_id: 'bob', member_kind: 'human' }]
        } as never
      }
    })

    render(
      <RoomEventRow
        event={{
          actor_id: 'alice',
          actor_kind: 'human',
          created_at: 1,
          kind: 'member.left',
          payload: { user: 'bob' },
          room_id: 'r',
          seq: 2
        }}
      />
    )
    expect(screen.getByTestId('room-event')).toHaveTextContent('Bob left the room')
  })

  const message = (actor: string, seq: number): RoomEvent => ({
    actor_id: actor,
    actor_kind: 'human',
    created_at: seq,
    kind: 'message.user',
    payload: { text: `from ${actor}` },
    room_id: 'r',
    seq
  })

  it('names people from an earlier shared transcript, and keeps your own bubble', () => {
    useMe.setState({ me: { display_name: 'Bob', id: 'bob' } })
    useRooms.setState({
      byId: {
        r: {
          id: 'r',
          members: [
            { display_name: 'Alice', member_id: 'alice', member_kind: 'human' },
            { display_name: 'Carol', member_id: 'carol', member_kind: 'human' }
          ]
        } as never
      }
    })

    render(
      <>
        <RoomEventRow event={message('alice', 1)} />
        <RoomEventRow event={message('bob', 2)} />
        <RoomEventRow
          event={{ ...message('alice', 3), kind: 'member.added', payload: { user: 'carol' } }}
        />
      </>
    )
    const [alice, mine, joined] = screen.getAllByTestId('room-event')
    expect(alice).toHaveTextContent('Alicefrom alice')
    expect(alice).not.toHaveClass('flex-row-reverse')
    expect(mine).toHaveTextContent(/^from bob$/)
    expect(mine).toHaveClass('flex-row-reverse')
    expect(joined).toHaveTextContent('Carol joined the room')
  })

  it('shows every message as yours before your name loads', () => {
    useMe.setState({ me: null })
    render(<RoomEventRow event={message('local', 1)} />)
    expect(screen.getByTestId('room-event')).toHaveClass('flex-row-reverse')
    expect(screen.getByTestId('room-event')).toHaveTextContent(/^from local$/)
  })
})
