import { act, render, screen, waitFor } from '@testing-library/react'

import { setActiveRpc } from '../../lib/rpc'
import type { Bot, Section } from '../../lib/types'
import { useBots } from '../../stores/bots'
import { useConnection } from '../../stores/connection'
import { useSections } from '../../stores/sections'
import {
  resetTranscriptEffects,
  setTranscriptEffects,
  useTranscripts
} from '../../stores/transcripts'

import { ConversationColumn } from './index'

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({ bot: 'hexbot', section: 'section' })
}))

const section = {
  id: 'section',
  bot: 'hexbot',
  title: 'General',
  live_session_id: 'live'
} as Section

const question = 'What do you mainly want help with?'

const call = vi.fn(async (method: string) =>
  method === 'hexbot.sections.open'
    ? {
        section,
        messages: [
          { role: 'assistant', text: question },
          {
            role: 'tool',
            name: 'clarify',
            tool_id: 'model-call',
            args: { question },
            text: 'Tech and software'
          },
          { role: 'assistant', text: 'Got it, tech and software.' }
        ]
      }
    : {}
)

beforeEach(() => {
  call.mockClear()
  Element.prototype.scrollIntoView = vi.fn()
  useConnection.setState({ status: 'connected' })
  useBots.setState({
    byName: { hexbot: { name: 'hexbot', display_name: 'HexBot', status: 'idle' } as Bot },
    loaded: true
  })
  useSections.setState({
    byId: { section },
    idsByBot: { hexbot: ['section'] },
    liveSessionId: { section: 'live' }
  })
  useTranscripts.getState().dropAll()
  setTranscriptEffects({ ackApproval: vi.fn(), notify: vi.fn(), touchSection: vi.fn() })
  useTranscripts.getState().open('live', 'section', [])
  setActiveRpc({ call } as never)
})

afterEach(() => {
  setActiveRpc(null)
  resetTranscriptEffects()
})

it.each(['visit', 'reconnect'] as const)(
  'reconciles the visible conversation after a %s even when its live session is cached',
  async boundary => {
    useTranscripts.getState().clarifyRequest('live', { request_id: 'old-question', question })

    if (boundary === 'reconnect') {
      useConnection.setState({ status: 'reconnecting' })
    }

    render(<ConversationColumn />)

    if (boundary === 'reconnect') {
      expect(screen.getByText('Waiting on you')).toBeVisible()
      expect(call).not.toHaveBeenCalledWith('hexbot.sections.open', expect.anything())
      act(() => useConnection.setState({ status: 'connected' }))
    }

    await screen.findByText('Got it, tech and software.')
    await waitFor(() => expect(screen.queryByText('Waiting on you')).not.toBeInTheDocument())
    expect(screen.getAllByTestId('clarify-card')).toHaveLength(1)
    expect(screen.queryByPlaceholderText('Type your own answer')).not.toBeInTheDocument()
    expect(call.mock.calls.filter(([method]) => method === 'hexbot.sections.open')).toHaveLength(1)
  }
)

it('retries a failed cached-history refresh after reconnecting', async () => {
  const open = vi
    .fn()
    .mockRejectedValueOnce(new Error('Disconnected'))
    .mockImplementation(() => call('hexbot.sections.open'))

  setActiveRpc({
    call: (method: string) => (method === 'hexbot.sections.open' ? open() : Promise.resolve({}))
  } as never)
  useTranscripts.getState().clarifyRequest('live', { request_id: 'old-question', question })
  render(<ConversationColumn />)
  await waitFor(() => expect(open).toHaveBeenCalledOnce())
  expect(screen.getByText('Waiting on you')).toBeVisible()
  act(() => useConnection.setState({ status: 'reconnecting' }))
  act(() => useConnection.setState({ status: 'connected' }))
  await screen.findByText('Got it, tech and software.')
  expect(open).toHaveBeenCalledTimes(2)
  expect(screen.queryByText('Waiting on you')).not.toBeInTheDocument()
})
