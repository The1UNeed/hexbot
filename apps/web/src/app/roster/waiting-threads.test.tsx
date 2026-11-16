import { fireEvent, render, screen } from '@testing-library/react'

import type { Bot, BotStatusDetail } from '../../lib/types'

import { WaitingThreads } from './waiting-threads'

const detail = (fields: Partial<BotStatusDetail>): BotStatusDetail => ({
  action: null,
  room_id: null,
  section_id: null,
  session_id: 'live-1',
  since: 0,
  text: 'Waiting for you',
  ...fields
})

const bot = (name: string, status: Bot['status'], fields?: Partial<BotStatusDetail>) =>
  ({
    display_name: name === 'hexbot' ? 'HexBot' : name,
    name,
    status,
    status_detail: fields ? detail(fields) : null
  }) as Bot

describe('bots waiting in a thread', () => {
  it('lists only bots waiting on you in a thread', () => {
    render(
      <WaitingThreads
        bots={[
          bot('hexbot', 'needs_you', { peer_bot: 'vex', section_id: 'thread' }),
          bot('school', 'needs_you', { section_id: 'chat' }),
          bot('pico', 'working', { peer_bot: 'vex', section_id: 'other' }),
          bot('apc', 'idle')
        ]}
        onOpen={vi.fn()}
      />
    )

    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(screen.getByText('HexBot is waiting for you')).toBeInTheDocument()
  })

  it('opens the thread where the bot waits', () => {
    const onOpen = vi.fn()

    render(
      <WaitingThreads
        bots={[bot('hexbot', 'needs_you', { peer_bot: 'vex', section_id: 'thread' })]}
        onOpen={onOpen}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /HexBot is waiting for you/ }))
    expect(onOpen).toHaveBeenCalledWith('hexbot', 'thread')
  })

  it('draws nothing when no bot waits in a thread', () => {
    const { container } = render(<WaitingThreads bots={[bot('hexbot', 'idle')]} onOpen={vi.fn()} />)

    expect(container).toBeEmptyDOMElement()
  })
})
