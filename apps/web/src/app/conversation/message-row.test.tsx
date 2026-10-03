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
})
