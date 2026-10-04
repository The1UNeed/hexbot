import { fireEvent, render, screen } from '@testing-library/react'
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
  it('keeps the tool above an approval in present tense until tool.complete', () => {
    useTranscripts.setState({ bySession: {} })
    setTranscriptEffects({ ackApproval: vi.fn(), notify: vi.fn() })
    const actions = useTranscripts.getState()
    actions.toolStart('s', {
      context: 'rm -rf ./approval-probe',
      name: 'terminal',
      tool_id: 't'
    })
    useTranscripts.getState().bySession.s!.messages[0]!.createdAt = Date.now() - 5_000
    actions.approvalRequest('s', { request_id: 'a' })
    resetTranscriptEffects()
    const current = () => useTranscripts.getState().bySession.s!.messages[0]!
    expect(current().streaming).toBe(false)
    const { rerender } = render(<WorkStatus message={current()} name="Scout" />)
    expect(screen.getByRole('button', { name: 'Scout is running a command' })).toBeVisible()
    // The command itself waits behind a click.
    expect(screen.queryByText(/rm -rf/)).not.toBeInTheDocument()
    actions.resolveApproval('s', 'a', 'once')
    rerender(<WorkStatus message={current()} name="Scout" />)
    expect(screen.getByRole('button', { name: 'Scout is running a command' })).toBeVisible()
    actions.toolComplete('s', { result: 'ok', tool_id: 't' })
    rerender(<WorkStatus message={current()} name="Scout" />)
    fireEvent.click(screen.getByRole('button', { name: /^Worked for/ }))
    expect(screen.getByText('Ran rm -rf ./approval-probe')).toBeVisible()
  })
  it('shows the running step while streaming', () => {
    render(
      <WorkStatus
        message={message({ streaming: true, toolCalls: [call({ status: 'running' })] })}
        name="Scout"
      />
    )
    expect(screen.getByRole('status', { name: 'Scout is searching the web' })).toBeVisible()
    expect(screen.queryByText(/apple/)).toBeNull()
    expect(screen.queryByTestId('work-status')).toBeNull()
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

  it('opens the trace and the running step when the live status is clicked', () => {
    render(
      <WorkStatus
        message={message({
          createdAt: Date.now() - 5_000,
          streaming: true,
          thinking: 'The user wants apples.',
          toolCalls: [call({ status: 'running' })]
        })}
        name="Scout"
      />
    )

    // Closed until asked: the status is the plain-words line alone.
    expect(screen.queryByTestId('thinking-trace')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Scout is searching the web' }))

    expect(screen.getByTestId('thinking-trace')).toHaveTextContent('The user wants apples.')
    // The step is listed, its arguments one more click away.
    expect(screen.queryByText(/"q": "apple"/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Searching the web for apple' }))
    expect(screen.getByText(/"q": "apple"/)).toBeVisible()
  })

  it('says what the bot is doing and keeps the trace closed until clicked', () => {
    render(
      <WorkStatus
        message={message({ createdAt: Date.now(), streaming: true, thinking: 'Hmm.' })}
        name="Scout"
      />
    )
    expect(screen.getByRole('status', { name: 'Scout is thinking' })).toBeVisible()
    expect(screen.queryByTestId('thinking-trace')).toBeNull()
  })

  it('collapses a finished thinking turn into one line that opens on click', () => {
    const createdAt = Date.now() - 20_000
    render(
      <WorkStatus
        message={message({
          createdAt,
          thinking: 'The user wants apples.',
          toolCalls: [call({})],
          workUntil: createdAt + 12_000
        })}
        name="Scout"
      />
    )
    expect(screen.queryByTestId('thinking-trace')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Thought for 12s' }))
    expect(screen.getByTestId('thinking-trace')).toHaveTextContent('The user wants apples.')
  })

  it('renders nothing after work that was over quickly', () => {
    const createdAt = Date.now() - 5_000

    const { container } = render(
      <WorkStatus
        message={message({
          createdAt,
          thinking: 'Hmm.',
          toolCalls: [call({ durationS: 0.3 })],
          workUntil: createdAt + 800
        })}
        name="Scout"
      />
    )

    expect(container).toBeEmptyDOMElement()
  })

  it('collapses finished steps into one line that opens on click', () => {
    render(
      <WorkStatus
        message={message({ toolCalls: [call({}), call({ name: 'terminal', summary: 'date' })] })}
        name="Scout"
      />
    )
    expect(screen.queryByTestId('thinking')).toBeNull()
    expect(screen.queryByText('Ran date')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Worked for 2s' }))
    expect(screen.getByText('Searched the web for apple')).toBeVisible()
    expect(screen.getByText('Ran date')).toBeVisible()
  })

  it('renders nothing after housekeeping-only turns', () => {
    const { container } = render(
      <WorkStatus message={message({ toolCalls: [call({ name: 'memory' })] })} name="Scout" />
    )

    expect(container).toBeEmptyDOMElement()
  })
})
