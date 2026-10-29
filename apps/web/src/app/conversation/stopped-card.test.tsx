import { fireEvent, render, screen } from '@testing-library/react'

import type { Bot } from '../../lib/types'
import type { TranscriptMessage } from '../../stores/transcripts'

import { StoppedCard, stoppedCardFor } from './index'

const row = (detail?: TranscriptMessage['errorDetail']): TranscriptMessage => ({
  attachments: [],
  createdAt: 1_757_600_000,
  error: 'Notion refused the request: the token has expired.',
  ...(detail ? { errorDetail: detail } : {}),
  id: 'e1',
  role: 'system',
  streaming: false,
  text: '',
  toolCalls: []
})

describe('stopped card', () => {
  it('offers Fix only when the error names a connector, and always Retry', () => {
    const fix = vi.fn()
    const retry = vi.fn()

    const { rerender } = render(
      <StoppedCard message={row()} name="Scout" onFix={fix} onRetry={retry} />
    )

    expect(screen.getByRole('alert')).toHaveTextContent('Scout stopped')
    expect(screen.queryByRole('button', { name: /^Fix/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(retry).toHaveBeenCalled()
    rerender(
      <StoppedCard
        message={row({ connector: 'notion', connectorName: 'Notion' })}
        name="Scout"
        onFix={fix}
        onRetry={retry}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Fix Notion' }))
    expect(fix).toHaveBeenCalledWith('notion')
  })
})

describe('stopped card from the bot status', () => {
  const bot = {
    display_name: 'Scout',
    name: 'scout',
    status: 'stopped',
    status_detail: {
      action: { connector: 'notion', kind: 'fix_connector' },
      room_id: null,
      section_id: 'section-1',
      session_id: null,
      since: 1_757_600_000,
      text: 'Notion refused the request.'
    }
  } as unknown as Bot

  it('builds a card for the stopped section when the transcript has no error row', () => {
    const card = stoppedCardFor(bot, 'section-1', [])
    expect(card).toMatchObject({
      createdAt: 1_757_600_000,
      error: 'Notion refused the request.',
      errorDetail: { connector: 'notion' }
    })
    expect(stoppedCardFor(bot, 'section-2', [])).toBeNull()
    expect(stoppedCardFor(bot, 'section-1', [row()])).toBeNull()
    expect(stoppedCardFor({ ...bot, status: 'idle' } as Bot, 'section-1', [])).toBeNull()
  })

  it("shows a failure with nowhere else to show, such as a dream's, in the bot's chat", () => {
    const dream = {
      ...bot,
      status_detail: {
        action: { kind: 'retry' },
        in_chat: true,
        room_id: null,
        section_id: 'dream-1',
        session_id: 'live-1',
        since: 1_757_600_000,
        text: 'fetch failed'
      }
    } as unknown as Bot

    // The chat's own old error rows do not hide it.
    expect(stoppedCardFor(dream, 'chat', [row()], true)).toMatchObject({ error: 'fetch failed' })
    // A thread or Check-ins is not the bot's chat.
    expect(stoppedCardFor(dream, 'chat', [], false)).toBeNull()
    // A failure another conversation shows stays there.
    expect(
      stoppedCardFor(
        { ...dream, status_detail: { ...dream.status_detail, in_chat: false } } as Bot,
        'chat',
        [],
        true
      )
    ).toBeNull()
  })
})
