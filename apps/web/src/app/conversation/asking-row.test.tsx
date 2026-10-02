import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { Bot, Message, ToolCall } from '../../lib/types'
import { useBots } from '../../stores/bots'
import { useUi } from '../../stores/ui'

import { AskingRow } from './asking-row'
import { asks, runningLabel, visibleSteps } from './steps'

const call = (partial: Partial<ToolCall>): ToolCall => ({
  args: { text: 'Can you draft the intro?', to: 'writer', wait: true },
  durationS: 3,
  name: 'message_bot',
  result: { reply: 'Here it is.', section_id: 'th1' },
  startedAt: 0,
  status: 'ok',
  summary: 'writer',
  toolId: partial.toolId ?? 'tool',
  ...partial
})

const message = (toolCalls: ToolCall[], streaming = false): Message => ({
  attachments: [],
  createdAt: 0,
  id: 'm',
  role: 'assistant',
  streaming,
  text: '',
  toolCalls
})

const bot = (name: string, display_name: string) =>
  ({ avatar: null, display_name, name }) as unknown as Bot

describe('asks', () => {
  it('reads the target and the thread id off a finished call, live or restored', () => {
    expect(asks(message([call({})]))).toEqual([
      { sectionId: 'th1', status: 'ok', target: 'writer' }
    ])
    // Live results arrive as Pi's {content, details}; the daemon's result is in details.
    expect(
      asks(
        message([call({ result: { content: [], details: { reply: 'ok', section_id: 'th3' } } })])
      )
    ).toEqual([{ sectionId: 'th3', status: 'ok', target: 'writer' }])
    // Restored history keeps the result as a JSON string.
    expect(asks(message([call({ result: '{"reply":"ok","section_id":"th2"}' })]))).toEqual([
      { sectionId: 'th2', status: 'ok', target: 'writer' }
    ])
    // Older transcripts carry only the reply: the panel looks the thread up instead.
    expect(asks(message([call({ result: { reply: 'ok' } })]))).toEqual([
      { sectionId: null, status: 'ok', target: 'writer' }
    ])
  })

  it('is running while any ask to that bot runs, one row per bot', () => {
    const list = asks(
      message([
        call({ toolId: 'a' }),
        call({ result: null, status: 'running', toolId: 'b' }),
        call({ args: { to: 'planner' }, summary: 'planner', toolId: 'c' })
      ])
    )

    expect(list).toEqual([
      { sectionId: 'th1', status: 'running', target: 'writer' },
      { sectionId: 'th1', status: 'ok', target: 'planner' }
    ])
  })

  it('falls back to the context line, and to nothing for a stripped call', () => {
    expect(asks(message([call({ args: null })]))[0]?.target).toBe('writer')
    expect(asks(message([call({ args: null, result: null, summary: undefined })]))).toEqual([
      { sectionId: null, status: 'ok', target: null }
    ])
  })

  it('keeps the ask out of the step list and the working line', () => {
    const running = message([call({ result: null, status: 'running' })], true)
    expect(visibleSteps(running.toolCalls)).toEqual([])
    expect(runningLabel(running)).toBeUndefined()
  })
})

describe('AskingRow', () => {
  beforeEach(() => {
    useBots.setState({ byName: { scout: bot('scout', 'Scout'), writer: bot('writer', 'Writer') } })
    useUi.setState({ thread: null })
  })

  it('renders nothing for a turn that asked nobody', () => {
    const { container } = render(<AskingRow message={message([])} sender="scout" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the target working while the ask runs, then as asked', () => {
    const { rerender } = render(
      <AskingRow
        message={message([call({ result: null, status: 'running' })], true)}
        sender="scout"
      />
    )

    expect(screen.getByText('Asking Writer')).toBeVisible()
    expect(screen.getByRole('img', { name: 'Writer' })).toHaveClass('hex-think')
    rerender(<AskingRow message={message([call({})])} sender="scout" />)
    expect(screen.getByText('Asked Writer')).toBeVisible()
    expect(screen.getByRole('img', { name: 'Writer' })).not.toHaveClass('hex-think')
  })

  it('opens the conversation between the two bots, with the thread id once known', () => {
    const { rerender } = render(
      <AskingRow
        message={message([call({ result: null, status: 'running' })], true)}
        sender="scout"
      />
    )

    const button = screen.getByRole('button', {
      name: 'Open the conversation between Scout and Writer'
    })

    fireEvent.click(button)
    expect(useUi.getState().thread).toEqual({ bot: 'writer', peer: 'scout' })
    // The result lands: the open panel learns the id without a second click.
    rerender(<AskingRow message={message([call({})])} sender="scout" />)
    expect(useUi.getState().thread).toEqual({ bot: 'writer', peer: 'scout', sectionId: 'th1' })
    fireEvent.click(screen.getByRole('button', { name: /Open the conversation/ }))
    expect(useUi.getState().thread).toEqual({ bot: 'writer', peer: 'scout', sectionId: 'th1' })
  })

  it('names the target by its handle when its profile is unknown', () => {
    render(<AskingRow message={message([call({ args: { to: 'planner' } })])} sender="scout" />)
    expect(screen.getByText('Asked planner')).toBeVisible()
  })

  it('tells a room member only that a teammate was asked, with nothing to open', () => {
    render(
      <AskingRow
        message={message(
          [call({ args: null, result: null, status: 'running', summary: undefined })],
          true
        )}
        sender="scout"
      />
    )
    expect(screen.getByText('Asking a teammate')).toBeVisible()
    expect(screen.queryByRole('button')).toBeNull()
  })
})
