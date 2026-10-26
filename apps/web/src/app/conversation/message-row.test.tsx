import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { Message } from '../../lib/types'
import {
  resetTranscriptEffects,
  setTranscriptEffects,
  useTranscripts
} from '../../stores/transcripts'

import { CheckingRow, MessageRow } from './index'

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

const row = (partial: Partial<Message>) =>
  render(<MessageRow message={message(partial)} onImage={() => {}} onRetry={() => {}} />)

describe('MessageRow', () => {
  it('shows only finished messages while the turn runs', () => {
    row({ parts: ['I will check.'], streaming: true, text: 'Do' })
    expect(screen.getByText('I will check.')).toBeInTheDocument()
    expect(screen.queryByText('Do')).toBeNull()
    expect(screen.getByRole('status')).toBeInTheDocument()
  })

  it('draws each message of a finished turn as its own bubble', () => {
    row({ parts: ['I will check.'], text: 'Done.' })
    expect(screen.getByText('I will check.')).toBeInTheDocument()
    expect(screen.getByText('Done.')).toBeInTheDocument()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('shows a finished turn as its bubbles alone, past ones included', () => {
    row({
      createdAt: 1,
      text: 'I set my soul.',
      thinking: 'The user wants short answers.',
      toolCalls: [
        {
          args: { action: 'write', text: 'Warm but efficient.' },
          durationS: 1,
          name: 'hexbot_soul',
          result: '{"ok":true}',
          startedAt: 0,
          status: 'ok',
          toolId: 's1'
        },
        {
          args: { action: 'add', content: 'Files are local.' },
          durationS: 1,
          name: 'memory',
          result: '{"success":true}',
          startedAt: 0,
          status: 'ok',
          toolId: 'm1'
        },
        {
          args: null,
          durationS: 12,
          name: 'terminal',
          result: 'ok',
          startedAt: 0,
          status: 'ok',
          summary: 'ls',
          toolId: 't1'
        }
      ],
      workUntil: 13_000
    })

    expect(screen.getByTestId('bot-message')).toHaveTextContent(/^I set my soul\.$/)
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByText(/Soul updated|Memory updated|Thought for|Worked for/)).toBeNull()
    expect(screen.queryByText(/short answers|Warm but efficient|Files are local/)).toBeNull()
  })

  it('keeps Copy beside your own messages', () => {
    row({ role: 'user', text: 'Hi' })
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument()
  })

  it('draws a visual between what the bot said first and its final reply', () => {
    row({
      parts: ['Here are the costs.'],
      text: 'March doubled.',
      toolCalls: [
        {
          args: { html: '<p>chart</p>', title: 'Costs' },
          durationS: 0,
          name: 'hexbot_show_html',
          result: null,
          startedAt: 0,
          status: 'ok',
          toolId: 't1'
        }
      ]
    })

    const frame = screen.getByTitle('Costs')
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts')
    expect(frame).toHaveAttribute('src', '/visual-frame.html')
    const before = screen.getByText('Here are the costs.')
    const after = screen.getByText('March doubled.')
    expect(before.compareDocumentPosition(frame) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(frame.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('keeps the same frame when the final reply lands under it', () => {
    const toolCalls: Message['toolCalls'] = [
      {
        args: { html: '<p>chart</p>', title: 'Costs' },
        durationS: 0,
        name: 'hexbot_show_html',
        result: null,
        startedAt: 0,
        status: 'ok',
        toolId: 't1'
      }
    ]

    const view = row({ parts: ['Here are the costs.'], streaming: true, text: 'March', toolCalls })
    const frame = screen.getByTitle('Costs')

    view.rerender(
      <MessageRow
        message={message({ parts: ['Here are the costs.'], text: 'March doubled.', toolCalls })}
        onImage={() => {}}
        onRetry={() => {}}
      />
    )

    expect(screen.getByTitle('Costs')).toBe(frame)
    expect(frame.compareDocumentPosition(screen.getByText('March doubled.'))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
  })
})

describe('CheckingRow', () => {
  it('stays working after a card ends the message while a step is checked, until the clear', () => {
    useTranscripts.setState({ bySession: {} })
    setTranscriptEffects({ ackApproval: vi.fn(), notify: vi.fn(), touchSection: vi.fn() })
    const actions = useTranscripts.getState()
    const transcript = () => useTranscripts.getState().bySession.s
    actions.messageStart('s')
    actions.toolStart('s', { name: 'terminal', tool_id: 'a' })
    actions.toolStart('s', { name: 'terminal', tool_id: 'b' })
    actions.statusUpdate('s', { kind: 'checking', text: 'Checking this step' })
    // While a message streams, its own row shows the line.
    const { rerender } = render(<CheckingRow transcript={transcript()} />)
    expect(screen.queryByRole('status')).toBeNull()
    // Review A's card ends the message while review B still runs.
    actions.approvalRequest('s', { request_id: 'a' })
    resetTranscriptEffects()
    rerender(<CheckingRow transcript={transcript()} />)
    expect(screen.getByRole('status', { name: 'Bot is working' })).toBeVisible()
    actions.statusUpdate('s', { kind: 'checking', text: '' })
    rerender(<CheckingRow transcript={transcript()} />)
    expect(screen.queryByRole('status')).toBeNull()
  })
})
