import { fireEvent, render, screen } from '@testing-library/react'

import type { Bot, BotStatusDetail } from '../../lib/types'
import { useUi } from '../../stores/ui'

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
  beforeEach(() => useUi.setState({ thread: null }))

  it('lists only bots waiting on you in a thread', () => {
    render(
      <WaitingThreads
        bots={[
          bot('hexbot', 'needs_you', { peer_bot: 'vex', section_id: 'thread' }),
          bot('school', 'needs_you', { section_id: 'chat' }),
          bot('pico', 'working', { peer_bot: 'vex', section_id: 'other' }),
          bot('apc', 'idle')
        ]}
      />
    )

    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(screen.getByText('HexBot is waiting for you')).toBeInTheDocument()
  })

  it('opens the thread where the bot waits', () => {
    render(
      <WaitingThreads
        bots={[bot('hexbot', 'needs_you', { peer_bot: 'vex', section_id: 'thread' })]}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /HexBot is waiting for you/ }))
    expect(useUi.getState().thread).toEqual({ bot: 'hexbot', peer: 'vex', sectionId: 'thread' })
  })

  it('draws nothing when no bot waits in a thread', () => {
    const { container } = render(<WaitingThreads bots={[bot('hexbot', 'idle')]} />)

    expect(container).toBeEmptyDOMElement()
  })
})
