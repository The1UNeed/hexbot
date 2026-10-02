import { JsonRpcGatewayError } from '@hermes/shared'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { HistoryRow } from '../../lib/api'
import { setActiveRpc } from '../../lib/rpc'
import type { Bot, Section } from '../../lib/types'
import { useBots } from '../../stores/bots'
import { useSections } from '../../stores/sections'
import {
  resetTranscriptEffects,
  setTranscriptEffects,
  useTranscripts
} from '../../stores/transcripts'
import { useUi } from '../../stores/ui'

import { threadErrorText, ThreadPanel } from './thread'

const bot = (name: string, display_name: string) =>
  ({ avatar: null, display_name, name }) as unknown as Bot

const thread = {
  archived_at: null,
  bot: 'writer',
  id: 'th1',
  live_session_id: 'live-t',
  message_count: 2,
  peer_bot: 'scout',
  preview: '',
  title: 'From scout',
  title_by: null
} as unknown as Section

const history: HistoryRow[] = [
  { display_kind: 'hidden', role: 'user', row_id: 'u1', text: '@scout: Can you draft the intro?' },
  {
    display_kind: 'hidden',
    role: 'user',
    row_id: 'u2',
    text: '[reply from planner] Something else'
  },
  { role: 'assistant', row_id: 'a1', text: 'Sure. Here is a first intro.' }
]

const rpc = (answers: Partial<Record<string, (params: Record<string, unknown>) => unknown>>) => {
  const call = vi.fn((method: string, params: Record<string, unknown> = {}) => {
    const answer = answers[method]

    if (!answer) {
      return Promise.reject(new Error(`unexpected ${method}`))
    }

    try {
      return Promise.resolve(answer(params))
    } catch (error) {
      return Promise.reject(error)
    }
  })

  setActiveRpc({ call } as never)

  return call
}

describe('ThreadPanel', () => {
  beforeEach(() => {
    useBots.setState({ byName: { scout: bot('scout', 'Scout'), writer: bot('writer', 'Writer') } })
    useSections.setState({ byId: {}, idsByBot: {}, liveSessionId: {} })
    useTranscripts.setState({ bySession: {} })
    useUi.setState({ thread: { bot: 'writer', peer: 'scout' } })
    setTranscriptEffects({ ackApproval: vi.fn(), notify: vi.fn(), touchSection: vi.fn() })
  })
  afterEach(resetTranscriptEffects)

  it('looks the thread up, shows the asker and the reply, and keeps other hidden rows hidden', async () => {
    const call = rpc({
      'hexbot.sections.open': () => ({ messages: history, section: thread }),
      'hexbot.sections.thread': () => ({ section: thread })
    })

    render(<ThreadPanel thread={{ bot: 'writer', peer: 'scout' }} />)
    expect(screen.getByRole('status', { name: 'Loading conversation' })).toBeVisible()
    expect(await screen.findByText('Can you draft the intro?')).toBeVisible()
    expect(call).toHaveBeenCalledWith('hexbot.sections.thread', { bot: 'writer', peer: 'scout' })
    expect(screen.getByTestId('thread-question')).toHaveTextContent('Scout')
    expect(screen.getByTestId('thread-reply')).toHaveTextContent('Writer')
    expect(screen.getByText('Sure. Here is a first intro.')).toBeVisible()
    expect(screen.queryByText(/Something else/)).toBeNull()
    expect(screen.getByRole('heading', { name: 'Scout and Writer' })).toBeVisible()
    expect(screen.getByText('Private to Scout and Writer.')).toBeVisible()
    // The thread never joins the section lists.
    expect(useSections.getState().byId.th1).toBeUndefined()
  })

  it('opens the known section straight away and streams the reply in progress', async () => {
    const call = rpc({ 'hexbot.sections.open': () => ({ messages: history, section: thread }) })

    render(<ThreadPanel thread={{ bot: 'writer', peer: 'scout', sectionId: 'th1' }} />)
    expect(await screen.findByText('Can you draft the intro?')).toBeVisible()
    expect(call).not.toHaveBeenCalledWith('hexbot.sections.thread', expect.anything())

    const transcripts = useTranscripts.getState()
    act(() => {
      transcripts.messageStart('live-t')
      transcripts.messageDelta('live-t', 'Working on a second')
    })
    expect(screen.getByText('Working on a second')).toBeVisible()
    expect(screen.getAllByTestId('thread-reply')).toHaveLength(2)

    // Completion reads the history again, so the next question shows; the live bubble stays until then.
    call.mockImplementation((method: string) =>
      Promise.resolve(
        method === 'hexbot.sections.open'
          ? {
              messages: [
                ...history,
                { role: 'assistant', row_id: 'a2', text: 'Working on a second draft.' }
              ],
              section: thread
            }
          : {}
      )
    )
    act(() => transcripts.messageComplete('live-t', { text: 'Working on a second draft.' }))
    await waitFor(() => expect(screen.getAllByTestId('thread-reply')).toHaveLength(2))
    expect(screen.getByText('Working on a second draft.')).toBeVisible()
  })

  it('says so when the asker has not asked yet', async () => {
    rpc({ 'hexbot.sections.thread': () => ({ section: null }) })
    render(<ThreadPanel thread={{ bot: 'writer', peer: 'scout' }} />)
    expect(await screen.findByText('Scout has not asked Writer anything yet.')).toBeVisible()
  })

  it('tells a non-owner and a lost thread apart', async () => {
    rpc({
      'hexbot.sections.thread': () => {
        throw new JsonRpcGatewayError('not the owner', { code: 4302 })
      }
    })

    const { unmount } = render(<ThreadPanel thread={{ bot: 'writer', peer: 'scout' }} />)
    expect(await screen.findByText('Only the room owner can open this conversation.')).toBeVisible()
    unmount()
    rpc({
      'hexbot.sections.open': () => {
        throw new JsonRpcGatewayError('section not found: th1', { code: 4204 })
      }
    })
    render(<ThreadPanel thread={{ bot: 'writer', peer: 'scout', sectionId: 'th1' }} />)
    expect(await screen.findByText('This conversation is no longer available.')).toBeVisible()
    expect(threadErrorText(new Error('socket closed'))).toBe('socket closed')
  })

  it('closes from its button and from Escape', async () => {
    rpc({ 'hexbot.sections.open': () => ({ messages: history, section: thread }) })
    render(<ThreadPanel thread={{ bot: 'writer', peer: 'scout', sectionId: 'th1' }} />)
    await screen.findByText('Can you draft the intro?')
    fireEvent.click(screen.getByRole('button', { name: 'Close the conversation' }))
    expect(useUi.getState().thread).toBeNull()
    useUi.setState({ thread: { bot: 'writer', peer: 'scout', sectionId: 'th1' } })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(useUi.getState().thread).toBeNull()
  })
})
