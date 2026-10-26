import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { Message, ToolCall } from '../../lib/types'
import {
  resetTranscriptEffects,
  setTranscriptEffects,
  useTranscripts
} from '../../stores/transcripts'

import { WorkStatus } from './work-status'

const call = (partial: Partial<ToolCall>): ToolCall => ({
  args: { q: 'apple' },
  durationS: 1,
  name: 'web_search',
  result: 'ok',
  startedAt: 0,
  status: 'ok',
  summary: 'apple',
  toolId: partial.name ?? 'tool',
  ...partial
})

const message = (partial: Partial<Message>): Message => ({
  attachments: [],
  createdAt: 0,
  id: 'm',
  role: 'assistant',
  streaming: false,
  text: '',
  toolCalls: [],
  ...partial
})

describe('WorkStatus', () => {
  it('says the bot is working while an approved step runs, then shows nothing', () => {
    useTranscripts.setState({ bySession: {} })
    setTranscriptEffects({ ackApproval: vi.fn(), notify: vi.fn() })
    const actions = useTranscripts.getState()
    actions.toolStart('s', {
      context: 'rm -rf ./approval-probe',
      name: 'terminal',
      tool_id: 't'
    })
    actions.approvalRequest('s', { request_id: 'a' })
    resetTranscriptEffects()
    const current = () => useTranscripts.getState().bySession.s!.messages[0]!
    expect(current().streaming).toBe(false)
    const { container, rerender } = render(<WorkStatus message={current()} name="Scout" />)
    expect(screen.getByRole('status', { name: 'Scout is working' })).toBeVisible()
    expect(screen.queryByText(/rm -rf/)).not.toBeInTheDocument()
    actions.resolveApproval('s', 'a', 'once')
    rerender(<WorkStatus message={current()} name="Scout" />)
    expect(screen.getByRole('status', { name: 'Scout is working' })).toBeVisible()
    actions.toolComplete('s', { result: 'ok', tool_id: 't' })
    rerender(<WorkStatus message={current()} name="Scout" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('says only that the bot is working, with nothing to open', () => {
    render(
      <WorkStatus
        message={message({
          activity: 'waiting on the provider',
          streaming: true,
          thinking: 'The user wants apples.',
          toolCalls: [call({ status: 'running' })]
        })}
        name="Scout"
      />
    )
    expect(screen.getByRole('status', { name: 'Scout is working' })).toBeVisible()
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByText(/apple/)).toBeNull()
    expect(screen.queryByText(/provider/)).toBeNull()
  })

  it('keeps saying working while Auto mode checks a step', () => {
    render(<WorkStatus checking="Checking this step" message={message({})} name="Scout" />)
    expect(screen.getByRole('status', { name: 'Scout is working' })).toBeVisible()
    expect(screen.queryByText('Checking this step')).toBeNull()
  })

  it('leaves an ask in progress to its own row instead of an empty working line', () => {
    render(
      <WorkStatus
        message={message({
          createdAt: Date.now(),
          streaming: true,
          toolCalls: [call({ args: { to: 'writer' }, name: 'message_bot', status: 'running' })]
        })}
        name="Scout"
      />
    )
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('renders nothing for a finished turn, however long it thought or worked', () => {
    const createdAt = Date.now() - 20_000

    const { container } = render(
      <WorkStatus
        message={message({
          createdAt,
          thinking: 'The user wants apples.',
          toolCalls: [call({}), call({ name: 'hexbot_soul', summary: 'write' })],
          workUntil: createdAt + 12_000
        })}
        name="Scout"
      />
    )

    expect(container).toBeEmptyDOMElement()
  })
})
