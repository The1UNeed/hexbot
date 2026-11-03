import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Bot } from '../../lib/types'
import type { TranscriptMessage } from '../../stores/transcripts'

import { SEND_TIMEOUT_MS } from './unsent'

import { MessageRow } from './index'

const sent = (
  status: NonNullable<TranscriptMessage['submission']>['status'],
  extra: Partial<NonNullable<TranscriptMessage['submission']>> = {},
  createdAt = Date.now()
): TranscriptMessage => ({
  attachments: [],
  createdAt,
  id: 'u1',
  inputId: '6f1c1f5e-3b0a-4c1e-9f5e-2a7d8f0c4b11',
  role: 'user',
  streaming: false,
  submission: {
    epoch: 'first',
    row: 'u1',
    since: Date.now(),
    status,
    target: { kind: 'local' },
    uploads: [],
    ...extra
  },
  text: 'hi',
  toolCalls: []
})

const row = (message: TranscriptMessage, onResend = vi.fn()) => {
  render(<MessageRow message={message} onImage={() => {}} onResend={onResend} />)

  return onResend
}

afterEach(() => vi.useRealTimers())

describe('a bubble before the daemon takes it', () => {
  it('greys while sending, with a spinner beside it and no Retry', () => {
    row(sent('sending'))
    expect(screen.getByRole('status', { name: 'Sending' })).toBeInTheDocument()
    expect(screen.getByText('hi').closest('.hex-pending')).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  })

  it('offers Retry once it has waited too long', () => {
    vi.useFakeTimers()
    const onResend = row(sent('sending'))
    act(() => vi.advanceTimersByTime(SEND_TIMEOUT_MS))
    expect(screen.getByText('Not sent')).toBeInTheDocument()
    expect(screen.queryByRole('status', { name: 'Sending' })).toBeNull()
    expect(screen.getByText('hi').closest('.hex-pending')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    fireEvent.click(screen.getByRole('button', { name: 'Retry sending' }))
    expect(onResend).toHaveBeenCalledTimes(2)
  })

  it('marks a refused send and leaves its line and Retry to its card', () => {
    const { container } = render(
      <MessageRow
        message={sent('rejected', { reason: 'session is already working' })}
        onImage={() => {}}
        onResend={vi.fn()}
      />
    )

    expect(container.querySelector('.text-danger svg')).not.toBeNull()
    expect(screen.queryByText('Not sent')).toBeNull()
    expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull()
    // Copy and Recall stay beside it.
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument()
  })

  it('draws nothing for a row history holds, whatever its last request said', () => {
    row(sent('unknown', {}, 0))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('status', { name: 'Sending' })).toBeNull()
  })
})

describe('a failure right after your message', () => {
  const card: TranscriptMessage = {
    attachments: [],
    createdAt: Date.now(),
    error: '400 {"error":{"message":"The requested model is not supported."}}',
    id: 'e1',
    role: 'system',
    streaming: false,
    text: '',
    toolCalls: []
  }

  it('leaves your bubble as sent and shows a Stopped card with the reason and Retry', () => {
    const retry = vi.fn()

    const { container } = render(
      <>
        <MessageRow lined message={sent('accepted')} onImage={() => {}} />
        <MessageRow
          bot={{ display_name: 'Owl' } as Bot}
          message={card}
          mine
          onImage={() => {}}
          onRetry={retry}
          retryMessage={sent('accepted')}
        />
      </>
    )

    expect(container.querySelector('[data-testid=user-message] .text-danger')).toBeNull()
    const stopped = screen.getByTestId('stopped-card')
    expect(stopped).toHaveTextContent('Owl stopped')
    expect(stopped).toHaveTextContent('The requested model is not supported.')
    expect(screen.queryByText('Not sent')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it('marks your bubble Not sent when the request itself failed, the reason on hover', () => {
    const retry = vi.fn()

    const { container } = render(
      <>
        <MessageRow failed lined message={sent('rejected')} onImage={() => {}} />
        <MessageRow
          message={{ ...card, request: true }}
          mine
          onImage={() => {}}
          onRetry={retry}
          retryMessage={sent('rejected')}
        />
      </>
    )

    expect(container.querySelector('[data-testid=user-message] .text-danger svg')).not.toBeNull()
    const line = screen.getByTestId('stopped-card')
    expect(line).toHaveTextContent('Not sent')
    expect(line).toHaveAttribute('title', 'The requested model is not supported.')
    expect(screen.getAllByText('Not sent')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it('sends your message again from the red mark too', () => {
    const retry = vi.fn()
    const input = sent('accepted')

    render(
      <MessageRow
        failed
        lined
        message={input}
        onImage={() => {}}
        onRetry={retry}
        retryMessage={input}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Retry sending' }))
    expect(retry).toHaveBeenCalledWith(input)
  })

  it('keeps a replaced line for screen readers only', () => {
    render(<MessageRow message={card} mine onImage={() => {}} quiet />)
    expect(screen.getByTestId('stopped-card')).toHaveClass('sr-only')
    expect(screen.queryByText('Not sent')).toBeNull()
  })
})
