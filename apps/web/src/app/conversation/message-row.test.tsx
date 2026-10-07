import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { Message } from '../../lib/types'

import { MessageRow } from './index'

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
