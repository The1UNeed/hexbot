import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { setActiveRpc } from '../../lib/rpc'
import type { Bot, Message, ToolCall } from '../../lib/types'
import { useBots } from '../../stores/bots'
import { useTranscripts } from '../../stores/transcripts'
import { useUi } from '../../stores/ui'

import { AskingRow } from './asking-row'
import { askLabel, asks, runningLabel } from './steps'

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

/** The daemon answers the thread lookup with a section whose live session is `live`. */
const threadRpc = (live: null | string) => {
  const rpc = vi.fn((method: string) =>
    method === 'hexbot.sections.thread'
      ? Promise.resolve({ section: live ? { id: 'th1', live_session_id: live } : null })
      : Promise.reject(new Error(`unexpected ${method}`))
  )

  setActiveRpc({ call: rpc } as never)

  return rpc
}

describe('asks', () => {
  it('reads the target and the thread id off a finished call, live or restored', () => {
    expect(asks(message([call({})]))).toEqual([
      { sectionId: 'th1', sent: false, status: 'ok', target: 'writer' }
    ])
    // Live results arrive as Pi's {content, details}; the daemon's result is in details.
    expect(
      asks(
        message([call({ result: { content: [], details: { reply: 'ok', section_id: 'th3' } } })])
      )
    ).toEqual([{ sectionId: 'th3', sent: false, status: 'ok', target: 'writer' }])
    // Restored history keeps the result as a JSON string.
    expect(asks(message([call({ result: '{"reply":"ok","section_id":"th2"}' })]))).toEqual([
      { sectionId: 'th2', sent: false, status: 'ok', target: 'writer' }
    ])
    // Older transcripts carry only the reply: the view looks the thread up instead.
    expect(asks(message([call({ result: { reply: 'ok' } })]))).toEqual([
      { sectionId: null, sent: false, status: 'ok', target: 'writer' }
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
      { sectionId: 'th1', sent: false, status: 'running', target: 'writer' },
      { sectionId: 'th1', sent: false, status: 'ok', target: 'planner' }
    ])
  })

  it('knows a message sent without waiting, unless another ask to that bot did wait', () => {
    const sent = call({ result: { message_id: 'x', section_id: 'th1', status: 'sent' } })

    const serializedSent = call({
      result: JSON.stringify({
        content: [{ text: 'Sent', type: 'text' }],
        details: { message_id: 'x', section_id: 'th1', status: 'sent' }
      })
    })

    const failed = call({ result: { error: 'Timed out' }, status: 'error', toolId: 'fail' })
    const replied = call({ toolId: 'ok' })

    expect(asks(message([sent]))).toEqual([
      { sectionId: 'th1', sent: true, status: 'ok', target: 'writer' }
    ])
    expect(asks(message([serializedSent]))).toEqual([
      { sectionId: 'th1', sent: true, status: 'ok', target: 'writer' }
    ])
    // Mixed failed + wait:false send yields Messaged in either order, matching room SQL.
    expect(asks(message([failed, sent]))).toEqual([
      { sectionId: 'th1', sent: true, status: 'ok', target: 'writer' }
    ])
    expect(asks(message([sent, failed]))).toEqual([
      { sectionId: 'th1', sent: true, status: 'ok', target: 'writer' }
    ])
    // Mixed failed + reply yields Message from in either order.
    expect(asks(message([failed, replied]))).toEqual([
      { sectionId: 'th1', sent: false, status: 'ok', target: 'writer' }
    ])
    expect(asks(message([replied, failed]))).toEqual([
      { sectionId: 'th1', sent: false, status: 'ok', target: 'writer' }
    ])
    expect(asks(message([sent, call({ toolId: 'b' })]))[0]?.sent).toBe(false)
    expect(asks(message([call({ toolId: 'a' }), { ...sent, toolId: 'b' }]))[0]?.sent).toBe(false)
  })

  it('falls back to the context line, and to nothing for a stripped call', () => {
    expect(asks(message([call({ args: null })]))[0]?.target).toBe('writer')
    expect(asks(message([call({ args: null, result: null, summary: undefined })]))).toEqual([
      { sectionId: null, sent: false, status: 'ok', target: null }
    ])
  })

  it('keeps the ask out of the working line', () => {
    const running = message([call({ result: null, status: 'running' })], true)
    expect(runningLabel(running)).toBeUndefined()
  })
})

describe('askLabel', () => {
  it('uses a consistent prefix around the target bot pill across running and settled states', () => {
    expect(askLabel({ sent: false, status: 'running' }, 'Writer', 'Research')).toBe(
      'Messaging Writer'
    )
    expect(askLabel({ sent: false, status: 'running' }, 'Writer', null)).toBe('Messaging Writer')
    expect(askLabel({ sent: false, status: 'ok' }, 'Writer', 'Research')).toBe(
      'Message from Writer'
    )
    expect(askLabel({ sent: true, status: 'ok' }, 'Writer', 'Research')).toBe('Messaged Writer')
    expect(askLabel({ sent: false, status: 'error' }, 'Writer', 'Research')).toBe('Asked Writer')
  })

  it('says "a teammate" when a room member is not told the name', () => {
    expect(askLabel({ sent: false, status: 'running' }, null, 'Research')).toBe(
      'Messaging a teammate'
    )
    expect(askLabel({ sent: false, status: 'ok' }, null, 'Research')).toBe(
      'Message from a teammate'
    )
    expect(askLabel({ sent: true, status: 'ok' }, null, 'Research')).toBe('Messaged a teammate')
  })
})

describe('AskingRow', () => {
  beforeEach(() => {
    useBots.setState({ byName: { scout: bot('scout', 'Scout'), writer: bot('writer', 'Writer') } })
    useTranscripts.setState({ bySession: {} })
    useUi.setState({ thread: null })
    threadRpc(null)
  })

  it('renders nothing for a turn that asked nobody', () => {
    const { container } = render(<AskingRow message={message([])} sender="scout" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('keeps one persistent pill and face across running and done so the row settles smoothly', () => {
    const { rerender } = render(
      <AskingRow
        message={message([call({ result: null, status: 'running' })], true)}
        sender="scout"
      />
    )

    expect(screen.getByTestId('asking-row')).toHaveTextContent('Messaging Writer')
    expect(screen.getByRole('status', { name: 'Messaging Writer' })).toBeVisible()
    const face = screen.getByRole('img', { name: 'Writer' })
    expect(face).toHaveAttribute('data-mood', 'listening')
    expect(screen.queryByRole('img', { name: 'Scout' })).toBeNull()
    expect(screen.getByTestId('asking-row')).toHaveAttribute('data-status', 'running')

    rerender(<AskingRow message={message([call({})])} sender="scout" />)
    expect(screen.getByTestId('asking-row')).toHaveTextContent('Message from Writer')
    expect(screen.getByTestId('asking-row')).toHaveAttribute('data-status', 'done')
    // Same avatar node stays mounted and smoothly settles to idle without remounting.
    expect(screen.getByRole('img', { name: 'Writer' })).toBe(face)
    expect(face).toHaveAttribute('data-mood', 'idle')
    expect(screen.getByTestId('asking-row')).not.toHaveTextContent(/Messaging/)
  })

  it('keeps the streaming reply out of the row, and its face writes while it answers', async () => {
    const rpc = threadRpc('live-t')
    render(
      <AskingRow
        message={message([call({ result: null, status: 'running' })], true)}
        sender="scout"
      />
    )

    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith('hexbot.sections.thread', { bot: 'writer', peer: 'scout' })
    )

    const transcripts = useTranscripts.getState()
    act(() => {
      transcripts.messageStart('live-t')
      transcripts.messageDelta('live-t', '**Your bots** now work as a team.')
    })

    await waitFor(() =>
      expect(screen.getByRole('img', { name: 'Writer' })).toHaveAttribute('data-mood', 'writing')
    )
    expect(screen.getByTestId('asking-row')).toHaveTextContent(/^Messaging Writer$/)
    expect(rpc).toHaveBeenCalledTimes(1)

    act(() => transcripts.messageComplete('live-t', { text: 'Your bots now work as a team.' }))
    expect(screen.getByRole('img', { name: 'Writer' })).toHaveAttribute('data-mood', 'listening')
  })

  it('settles to "Message from <bot>" alone, with none of the reply under it', () => {
    render(<AskingRow message={message([call({})])} sender="scout" />)
    expect(screen.getByTestId('asking-row')).toHaveTextContent(/^Message from Writer$/)
  })

  it('marks a message sent without waiting for a reply', () => {
    render(
      <AskingRow
        message={message([call({ result: { section_id: 'th1', status: 'sent' } })])}
        sender="scout"
      />
    )
    expect(screen.getByTestId('asking-row')).toHaveTextContent('Messaged Writer')
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
    // The result lands: the open view learns the id without a second click.
    rerender(<AskingRow message={message([call({})])} sender="scout" />)
    expect(useUi.getState().thread).toEqual({ bot: 'writer', peer: 'scout', sectionId: 'th1' })
    fireEvent.click(screen.getByRole('button', { name: /Open the conversation/ }))
    expect(useUi.getState().thread).toEqual({ bot: 'writer', peer: 'scout', sectionId: 'th1' })
  })

  it('names the target by its handle when its profile is unknown', () => {
    render(<AskingRow message={message([call({ args: { to: 'planner' } })])} sender="scout" />)
    expect(screen.getByTestId('asking-row')).toHaveTextContent('Message from planner')
  })

  it('tells a room member only that a teammate was messaged, with nothing to open', () => {
    const rpc = threadRpc('live-t')

    const { rerender } = render(
      <AskingRow
        message={message(
          [call({ args: null, result: null, status: 'running', summary: undefined })],
          true
        )}
        sender="scout"
      />
    )

    expect(screen.getByTestId('asking-row')).toHaveTextContent('Messaging a teammate')
    expect(screen.getByRole('img', { name: 'Teammate' })).toBeVisible()
    expect(screen.queryByRole('button')).toBeNull()
    // Without a name there is no thread to look up.
    expect(rpc).not.toHaveBeenCalled()

    rerender(
      <AskingRow
        message={message([call({ args: null, result: null, summary: undefined })])}
        sender="scout"
      />
    )
    expect(screen.getByTestId('asking-row')).toHaveTextContent('Message from a teammate')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('draws settled history still, reserves prefix width, and fades the live ring via opacity', () => {
    const { rerender } = render(
      <AskingRow fresh={false} message={message([call({})])} sender="scout" />
    )

    const row = screen.getByTestId('asking-row')
    expect(row).not.toHaveClass('hex-ask-enter')
    expect(row.querySelector('.hex-ask-prefix')).not.toBeNull()
    expect(row.querySelector('.hex-ask-label')).toBeNull()
    expect(row.querySelector('.hex-ask-ring')).toHaveClass('opacity-0')
    expect(row.querySelector('.hex-ask-ring')).not.toHaveClass('hex-ask-ring-live')

    rerender(
      <AskingRow
        fresh
        message={message([call({ result: null, status: 'running' })], true)}
        sender="scout"
      />
    )
    expect(row).toHaveClass('hex-ask-enter')
    expect(row.querySelector('.hex-ask-label')).not.toBeNull()
    expect(row.querySelector('.hex-ask-ring')).toHaveClass('opacity-100', 'hex-ask-ring-live')

    // Settling after a live transition keeps the label transition animation cleanly.
    rerender(<AskingRow fresh={false} message={message([call({})])} sender="scout" />)
    expect(row.querySelector('.hex-ask-label')).not.toBeNull()
    expect(row.querySelector('.hex-ask-ring')).toHaveClass('opacity-0')
  })
})
