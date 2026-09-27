import { render, screen } from '@testing-library/react'

import type { Bot, Room } from '../../lib/types'

import { RoomCluster } from './room-cluster'
import { StatusDot, StatusTag } from './status-dot'

describe('status dot', () => {
  it('is blue while working, purple when it needs you, red when stopped, green when done, and gone when idle', () => {
    const { rerender } = render(<StatusDot status="working" />)
    expect(screen.getByRole('img', { name: 'Working' })).toHaveClass('bg-info', 'hex-pulse')
    rerender(<StatusDot status="needs_you" />)
    expect(screen.getByRole('img', { name: 'Needs you' })).toHaveClass('bg-accent')
    rerender(<StatusDot status="stopped" />)
    expect(screen.getByRole('img', { name: 'Stopped' })).toHaveClass('bg-danger')
    rerender(<StatusDot status="done" />)
    expect(screen.getByRole('img', { name: 'Done' })).toHaveClass('bg-success')
    rerender(<StatusDot status="idle" />)
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })
})

describe('status tag', () => {
  it('writes Waiting and Working and nothing for the other states', () => {
    const { rerender } = render(<StatusTag status="needs_you" />)
    expect(screen.getByTestId('status-tag')).toHaveTextContent('Waiting')
    expect(screen.getByTestId('status-tag')).toHaveClass('text-accent')

    rerender(<StatusTag status="working" />)
    expect(screen.getByTestId('status-tag')).toHaveTextContent('Working')

    for (const status of ['idle', 'done', 'stopped'] as const) {
      rerender(<StatusTag status={status} />)
      expect(screen.queryByTestId('status-tag')).toBeNull()
    }
  })
})

describe('room cluster', () => {
  const bots = {
    scout: { avatar: null, display_name: 'Scout', name: 'scout' } as Bot,
    writer: { avatar: null, display_name: 'Writer', name: 'writer' } as Bot
  }

  const room = (members: string[], left: string[] = []): Pick<Room, 'members' | 'name'> => ({
    members: members.map(id => ({
      added_at: 0,
      added_by: 'local',
      last_read_seq: 0,
      left_at: left.includes(id) ? 1 : null,
      member_id: id,
      member_kind: 'bot' as const,
      room_id: 'r'
    })) as Room['members'],
    name: 'Lab'
  })

  it('shows one face for one bot and a grid for more, skipping bots that left', () => {
    const { rerender } = render(<RoomCluster bots={bots} room={room(['scout'])} />)
    expect(screen.getByRole('img', { name: 'Scout' })).toBeInTheDocument()
    rerender(<RoomCluster bots={bots} room={room(['scout', 'writer'])} status="working" />)
    expect(screen.getByRole('img', { name: 'Writer' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Working' })).toBeInTheDocument()
    rerender(<RoomCluster bots={bots} room={room(['scout', 'writer'], ['writer'])} />)
    expect(screen.queryByRole('img', { name: 'Writer' })).not.toBeInTheDocument()
  })
})
