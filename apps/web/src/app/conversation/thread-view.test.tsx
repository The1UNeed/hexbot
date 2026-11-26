import { JsonRpcGatewayError } from '@hermes/shared'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { HistoryRow } from '../../lib/api'
import { asksOf } from '../../lib/asks'
import { setActiveRpc } from '../../lib/rpc'
import type { Bot, Message, Section } from '../../lib/types'
import { useBots } from '../../stores/bots'
import { useConnection } from '../../stores/connection'
import { useSections } from '../../stores/sections'
import {
  resetTranscriptEffects,
  setTranscriptEffects,
  useTranscripts
} from '../../stores/transcripts'
import { useUi } from '../../stores/ui'
import { fileTab, useVisuals, visualsActions } from '../../stores/visuals'

import { copyText, mergeThreadMessages, threadErrorText, ThreadView } from './thread-view'

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

describe('ThreadView', () => {
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

    render(<ThreadView thread={{ bot: 'writer', peer: 'scout' }} />)
    expect(screen.getByRole('status', { name: 'Loading conversation' })).toBeVisible()
    expect(await screen.findByText('Can you draft the intro?')).toBeVisible()
    expect(call).toHaveBeenCalledWith('hexbot.sections.thread', { bot: 'writer', peer: 'scout' })
    expect(screen.getByTestId('thread-question')).toHaveTextContent('Scout')
    expect(screen.getByTestId('thread-reply')).toHaveTextContent('Writer')
    expect(screen.getByText('Sure. Here is a first intro.')).toBeVisible()
    expect(screen.queryByText(/Something else/)).toBeNull()
    expect(screen.getByRole('heading', { name: 'Scout and Writer' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Close Chat' })).toBeVisible()
    // The thread never joins the section lists.
    expect(useSections.getState().byId.th1).toBeUndefined()
  })

  it('shows each message of a reply that spoke before and after a tool', async () => {
    rpc({
      'hexbot.sections.open': () => ({
        messages: [
          history[0],
          { role: 'assistant', row_id: 'a1', text: 'Let me look.' },
          { name: 'web_search', role: 'tool', row_id: 't1', text: 'ok' },
          { role: 'assistant', row_id: 'a2', text: 'Here is the intro.' }
        ],
        section: thread
      }),
      'hexbot.sections.thread': () => ({ section: thread })
    })

    render(<ThreadView thread={{ bot: 'writer', peer: 'scout' }} />)
    expect(await screen.findByText('Here is the intro.')).toBeVisible()
    expect(screen.getByText('Let me look.')).toBeVisible()
  })

  it('opens the known section straight away and streams the reply in progress', async () => {
    const call = rpc({ 'hexbot.sections.open': () => ({ messages: history, section: thread }) })

    render(<ThreadView thread={{ bot: 'writer', peer: 'scout', sectionId: 'th1' }} />)
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
    render(<ThreadView thread={{ bot: 'writer', peer: 'scout' }} />)
    expect(await screen.findByText('Scout has not asked Writer anything yet.')).toBeVisible()
  })

  it('tells a non-owner and a lost thread apart', async () => {
    rpc({
      'hexbot.sections.thread': () => {
        throw new JsonRpcGatewayError('not the owner', { code: 4302 })
      }
    })

    const { unmount } = render(<ThreadView thread={{ bot: 'writer', peer: 'scout' }} />)
    expect(await screen.findByText('Only the room owner can open this conversation.')).toBeVisible()
    unmount()
    rpc({
      'hexbot.sections.open': () => {
        throw new JsonRpcGatewayError('section not found: th1', { code: 4204 })
      }
    })
    render(<ThreadView thread={{ bot: 'writer', peer: 'scout', sectionId: 'th1' }} />)
    expect(await screen.findByText('This conversation is no longer available.')).toBeVisible()
    expect(threadErrorText(new Error('socket closed'))).toBe('socket closed')
  })

  it('lets the owner answer the asked bot: its questions and approvals show here', async () => {
    rpc({
      'hexbot.sections.open': () => ({
        messages: history,
        pending_clarify: { question: 'Which tone?', request_id: 'q1' },
        section: thread
      })
    })
    render(<ThreadView thread={{ bot: 'writer', peer: 'scout', sectionId: 'th1' }} />)
    expect(await screen.findByText('Which tone?')).toBeVisible()
    act(() =>
      useTranscripts
        .getState()
        .approvalRequest('live-t', { command: 'curl example.com', request_id: 'ap1' })
    )
    expect(screen.getByText('curl example.com')).toBeVisible()
  })

  it('shows a reply in progress once while preserving prior replies and earlier stored fragments', async () => {
    const transcripts = useTranscripts.getState()
    act(() => {
      transcripts.messageStart('live-t')
      transcripts.messageDelta('live-t', 'Drafting. Checking the style guide.')
    })
    rpc({
      'hexbot.sections.open': () => ({
        // The reply's first part is already stored while it streams on, after an earlier reply.
        messages: [...history, { role: 'assistant', row_id: 'a2', text: 'Drafting.' }],
        section: thread
      })
    })
    render(<ThreadView thread={{ bot: 'writer', peer: 'scout', sectionId: 'th1' }} />)
    expect(await screen.findByText('Drafting. Checking the style guide.')).toBeVisible()
    // Prior completed reply stays visible rather than being sliced away.
    expect(screen.getByText('Sure. Here is a first intro.')).toBeVisible()
    expect(screen.queryByText('Drafting.')).toBeNull()
  })

  it('keeps stored fragments a late-joining stream lacks and retains unconfirmed completed live replies', () => {
    const stored = [
      {
        attachments: [],
        createdAt: 0,
        id: 'u1',
        role: 'user' as const,
        streaming: false,
        text: 'Check both docs',
        toolCalls: []
      },
      {
        attachments: [],
        createdAt: 0,
        fragmentIds: ['f1'],
        id: 'f1',
        role: 'assistant' as const,
        streaming: false,
        text: 'First part stored.',
        textId: 'f1',
        toolCalls: [],
        turnId: 'turn-1'
      }
    ]

    const liveMidStream = [
      {
        attachments: [],
        createdAt: 100,
        fragmentIds: ['f2'],
        id: 'live-1',
        role: 'assistant' as const,
        streaming: true,
        text: 'Second part streaming.',
        textId: 'f2',
        toolCalls: [],
        turnId: 'turn-1'
      }
    ]

    const mergedMid = mergeThreadMessages(stored, liveMidStream)
    expect(mergedMid.map(item => item.text)).toEqual([
      'Check both docs',
      'First part stored.',
      'Second part streaming.'
    ])

    // Completed live fragment stays until snapshot includes its fragment id.
    const liveDone = [{ ...liveMidStream[0]!, streaming: false }]
    expect(mergeThreadMessages(stored, liveDone).map(item => item.text)).toEqual([
      'Check both docs',
      'First part stored.',
      'Second part streaming.'
    ])
    const confirmedStored = [...stored, { ...liveDone[0]!, createdAt: 0, id: 'f2' }]
    expect(mergeThreadMessages(confirmedStored, liveDone).map(item => item.text)).toEqual([
      'Check both docs',
      'First part stored.',
      'Second part streaming.'
    ])

    // Overlapping fragments preserve stored toolCalls (e.g. a nested message_bot ask)
    // that the late-joining live transcript lacks.
    const storedWithNestedAsk = [
      stored[0]!,
      {
        ...stored[1]!,
        fragmentIds: ['f1', 'f2'],
        toolCalls: [
          {
            args: { to: 'research' },
            durationS: 1,
            name: 'message_bot',
            result: { reply: 'Found it', section_id: 'th-nested' },
            startedAt: 0,
            status: 'ok' as const,
            summary: 'research',
            toolId: 'call-nested'
          }
        ]
      }
    ]

    const liveOverlapping = [
      {
        ...liveMidStream[0]!,
        fragmentIds: ['f2', 'f3'],
        text: 'Continuing with research.'
      }
    ]

    const mergedNested = mergeThreadMessages(storedWithNestedAsk, liveOverlapping)
    expect(mergedNested[1]?.toolCalls.map(call => call.name)).toEqual(['message_bot'])
    expect(mergedNested[1]?.fragmentIds).toEqual(['f1', 'f2', 'f3'])

    // An unmatched failed live reply stays anchored to its turn/time instead of jumping below a later exchange.
    const twoTurnsStored = [
      {
        attachments: [],
        createdAt: 1000,
        fragmentIds: ['u1'],
        id: 'u1',
        role: 'user' as const,
        streaming: false,
        text: 'First question',
        toolCalls: [],
        turnId: 't1'
      },
      {
        attachments: [],
        createdAt: 2000,
        fragmentIds: ['u2'],
        id: 'u2',
        role: 'user' as const,
        streaming: false,
        text: 'Second question',
        toolCalls: [],
        turnId: 't2'
      },
      {
        attachments: [],
        createdAt: 2500,
        fragmentIds: ['a2'],
        id: 'a2',
        role: 'assistant' as const,
        streaming: false,
        text: 'Second answer',
        toolCalls: [],
        turnId: 't2'
      }
    ]

    const earlierFailure = [
      {
        attachments: [],
        createdAt: 1500,
        error: 'Model overloaded',
        id: 'err-1',
        role: 'assistant' as const,
        streaming: false,
        text: '',
        toolCalls: [],
        turnId: 't1'
      }
    ]

    const mergedWithFailure = mergeThreadMessages(twoTurnsStored, earlierFailure)
    expect(mergedWithFailure.map(item => item.error ?? item.text)).toEqual([
      'First question',
      'Model overloaded',
      'Second question',
      'Second answer'
    ])

    // Even without turnId and with restored history rows (createdAt: 0, timestamp in sentAt),
    // chronological ordering keeps the failure before the second exchange.
    const mergedByTime = mergeThreadMessages(
      twoTurnsStored.map(({ createdAt, turnId: _turnId, ...rest }) => ({
        ...rest,
        createdAt: 0,
        sentAt: createdAt
      })),
      earlierFailure.map(({ turnId: _turnId, ...rest }) => rest)
    )

    expect(mergedByTime.map(item => item.error ?? item.text)).toEqual([
      'First question',
      'Model overloaded',
      'Second question',
      'Second answer'
    ])
  })

  it('shows StoppedCard from bot status_detail on a fresh load when history has no error row', async () => {
    useBots.setState({
      byName: {
        scout: { display_name: 'Scout', name: 'scout' } as never,
        writer: {
          display_name: 'Writer',
          name: 'writer',
          status: 'stopped',
          status_detail: { section_id: 'th1', since: 1700000010, text: 'Rate limited' }
        } as never
      }
    })
    rpc({
      'hexbot.sections.open': () => ({
        messages: [
          { display_kind: 'hidden', role: 'user', row_id: 'u1', text: '@scout: Check pricing' }
        ],
        section: thread
      })
    })
    render(<ThreadView thread={{ bot: 'writer', peer: 'scout', sectionId: 'th1' }} />)
    expect(await screen.findByText('Check pricing')).toBeVisible()
    expect(await screen.findByTestId('stopped-card')).toHaveTextContent('Rate limited')
  })

  it('renders StoppedCard for failed assistant replies even with no text, and ignores Escape when inactive', async () => {
    rpc({ 'hexbot.sections.open': () => ({ messages: history, section: thread }) })
    const underlyingClose = vi.fn()
    const overlayClose = vi.fn()

    render(
      <>
        <ThreadView
          active={false}
          onClose={underlyingClose}
          thread={{ bot: 'writer', peer: 'scout', sectionId: 'th1' }}
        />
        <ThreadView
          active
          onClose={overlayClose}
          thread={{ bot: 'writer', peer: 'scout', sectionId: 'th1' }}
        />
      </>
    )

    expect(await screen.findAllByText('Can you draft the intro?')).toHaveLength(2)

    // Only the active top ThreadView handles Escape; the underlying direct peer route stays open.
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(overlayClose).toHaveBeenCalledTimes(1)
    expect(underlyingClose).not.toHaveBeenCalled()

    // An assistant turn that fails with empty text still renders StoppedCard.
    act(() => {
      useTranscripts.getState().messageStart('live-t')
      useTranscripts.getState().messageComplete('live-t', { error: 'Model overloaded' })
    })
    expect(screen.getAllByTestId('stopped-card')[0]).toHaveTextContent('Model overloaded')
  })

  it('retires stale cards settled elsewhere, renders stored approvals, and keeps duplicate-worded clarifies distinct', async () => {
    const call = rpc({
      'hexbot.sections.open': () => ({
        busy: false,
        messages: [
          history[0],
          {
            role: 'assistant',
            row_id: 'a1',
            text: 'Checking permission.',
            tool_calls: [
              {
                function: {
                  arguments: JSON.stringify({
                    action: 'enable',
                    bot: 'writer',
                    id: 'connector:notion',
                    name: 'Notion'
                  }),
                  name: 'hexbot_plugins'
                },
                id: 'tool-ap-1'
              }
            ]
          },
          {
            args: { action: 'enable', bot: 'writer', id: 'connector:notion', name: 'Notion' },
            name: 'hexbot_plugins',
            role: 'tool',
            row_id: 'tr1',
            text: JSON.stringify({ status: 'enabled', plugin: 'Notion' }),
            tool_call_id: 'tool-ap-1'
          },
          { role: 'assistant', row_id: 'a2', text: 'Done after check.' }
        ],
        pending_requests: [],
        section: thread
      }),
      'clarify.respond': () => ({ status: 'answered' }),
      'approval.respond': () => ({ resolved: true })
    })

    // A stale approval arrived before reconnect and was answered on another client.
    useTranscripts.setState({
      bySession: {
        'live-t': {
          approvals: [
            {
              choices: ['once', 'deny'],
              command: 'stale-cmd',
              receivedAt: Date.now() - 10_000,
              requestId: 'stale-ap',
              sessionId: 'live-t'
            }
          ],
          clarifies: [],
          context: null,
          error: null,
          info: null,
          messages: [],
          sectionId: 'th1',
          sessionId: 'live-t',
          status: null,
          streamingMessageId: null,
          usage: null
        }
      }
    })

    render(<ThreadView thread={{ bot: 'writer', peer: 'scout', sectionId: 'th1' }} />)
    expect(await screen.findByText('Done after check.')).toBeVisible()
    // Stale pending approval was retired by snapshot reconciliation.
    expect(screen.queryByText('stale-cmd')).toBeNull()

    // Two distinct clarifies with identical wording both stay visible and answer independently.
    act(() => {
      useTranscripts.getState().clarifyRequest('live-t', {
        choices: ['Yes', 'No'],
        message_id: 'a1',
        question: 'Proceed?',
        request_id: 'cl-1'
      })
      useTranscripts.getState().clarifyRequest('live-t', {
        choices: ['Yes', 'No'],
        message_id: 'a2',
        question: 'Proceed?',
        request_id: 'cl-2'
      })
    })
    expect(screen.getAllByText('Proceed?')).toHaveLength(2)

    // Answering the first card sends clarify.respond and leaves the second actionable.
    fireEvent.click(screen.getAllByRole('option', { name: /Yes/ })[0]!)
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'clarify.respond',
        expect.objectContaining({ answer: 'Yes', request_id: 'cl-1', session_id: 'live-t' })
      )
    )
    expect(screen.getAllByText('Proceed?')).toHaveLength(2)
  })

  it('does not auto-scroll when scrolled up and keeps the speaker label after a hidden tool row', async () => {
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView

    rpc({
      'hexbot.sections.open': () => ({
        messages: [
          history[0],
          { name: 'web_search', role: 'tool', row_id: 't1', text: 'ok' },
          { role: 'assistant', row_id: 'a1', text: 'Answer after hidden tool.' }
        ],
        section: thread
      })
    })

    const { container } = render(
      <ThreadView thread={{ bot: 'writer', peer: 'scout', sectionId: 'th1' }} />
    )

    expect(await screen.findByText('Answer after hidden tool.')).toBeVisible()
    // Speaker label is still rendered even though a hidden tool-only row preceded it.
    expect(screen.getByTestId('thread-reply')).toHaveTextContent('Writer')

    // Scroll away from the bottom; new streaming deltas must not yank the viewport back down.
    const scroller = container.querySelector('.overflow-y-auto') as HTMLDivElement
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 1000 })
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 300 })
    scroller.scrollTop = 100
    fireEvent.scroll(scroller)
    scrollIntoView.mockClear()

    act(() => {
      useTranscripts.getState().messageStart('live-t')
      useTranscripts.getState().messageDelta('live-t', 'Streaming while reading earlier')
    })
    expect(screen.getByText('Streaming while reading earlier')).toBeVisible()
    expect(scrollIntoView).not.toHaveBeenCalled()
  })

  it('respects defaultPrevented on Escape and falls back when Clipboard API is unavailable', async () => {
    rpc({ 'hexbot.sections.open': () => ({ messages: history, section: thread }) })
    render(<ThreadView thread={{ bot: 'writer', peer: 'scout', sectionId: 'th1' }} />)
    await screen.findByText('Can you draft the intro?')

    // A menu or dialog that already handled Escape prevents ThreadView from closing.
    const prevented = new KeyboardEvent('keydown', { cancelable: true, key: 'Escape' })
    prevented.preventDefault()
    window.dispatchEvent(prevented)
    expect(useUi.getState().thread).not.toBeNull()

    // Fallback copy path works cleanly when navigator.clipboard is missing.
    const origClipboard = navigator.clipboard
    const execCommand = vi.fn(() => true)
    document.execCommand = execCommand
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })

    try {
      copyText('hello fallback')
      expect(execCommand).toHaveBeenCalledWith('copy')
    } finally {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: origClipboard })
    }
  })

  it('reads the thread again when the daemon says it changed', async () => {
    const call = rpc({ 'hexbot.sections.thread': () => ({ section: null }) })
    render(<ThreadView thread={{ bot: 'writer', peer: 'scout' }} />)
    expect(await screen.findByText('Scout has not asked Writer anything yet.')).toBeVisible()
    call.mockImplementation((method: string) =>
      Promise.resolve(
        method === 'hexbot.sections.thread'
          ? { section: thread }
          : { messages: history, section: thread }
      )
    )
    act(() => useUi.getState().touchThread())
    expect(await screen.findByText('Can you draft the intro?')).toBeVisible()
  })

  it('refreshes a direct peer route on section changes and binds a replacement live session', async () => {
    useUi.setState({ peerRoute: 'th1', thread: null })
    let openCount = 0

    const call = rpc({
      'clarify.respond': () => ({ status: 'answered' }),
      'hexbot.sections.open': () => {
        openCount += 1

        return openCount === 1
          ? { messages: history, section: { ...thread, live_session_id: 'live-old' } }
          : {
              messages: history,
              pending_clarify: {
                choices: ['Yes', 'No'],
                question: 'Continue on replacement session?',
                request_id: 'cl-new'
              },
              pending_requests: ['cl-new'],
              section: { ...thread, live_session_id: 'live-new' }
            }
      }
    })

    render(
      <ThreadView onClose={() => {}} thread={{ bot: 'writer', peer: 'scout', sectionId: 'th1' }} />
    )
    expect(await screen.findByText('Can you draft the intro?')).toBeVisible()
    expect(screen.queryByText('Continue on replacement session?')).toBeNull()

    // A sections.changed notification for this direct peer route re-opens and picks up live-new.
    act(() => useUi.getState().touchThread('th1'))
    expect(await screen.findByText('Continue on replacement session?')).toBeVisible()

    fireEvent.click(screen.getByRole('option', { name: /Yes/ }))
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'clarify.respond',
        expect.objectContaining({ answer: 'Yes', request_id: 'cl-new', session_id: 'live-new' })
      )
    )
    useUi.setState({ peerRoute: null })
  })

  it('hides the previous section and its approval card immediately when switching sectionId for the same bot pair', async () => {
    let resolveSecond!: (value: { messages: HistoryRow[]; section: Section }) => void

    const secondOpen = new Promise<{ messages: HistoryRow[]; section: Section }>(resolve => {
      resolveSecond = resolve
    })

    const secondThread = {
      ...thread,
      id: 'th2',
      live_session_id: 'live-t2'
    } as unknown as Section

    rpc({
      'hexbot.sections.open': params =>
        params.id === 'th1' ? { messages: history, section: thread } : secondOpen
    })

    const { rerender } = render(
      <ThreadView thread={{ bot: 'writer', peer: 'scout', sectionId: 'th1' }} />
    )

    expect(await screen.findByText('Can you draft the intro?')).toBeVisible()
    act(() =>
      useTranscripts
        .getState()
        .approvalRequest('live-t', { command: 'rm -rf /tmp/old', request_id: 'ap-th1' })
    )
    expect(screen.getByText('rm -rf /tmp/old')).toBeVisible()

    // Switching sectionId for the same bot pair immediately drops th1's history and approval while th2 loads.
    rerender(<ThreadView thread={{ bot: 'writer', peer: 'scout', sectionId: 'th2' }} />)
    expect(screen.getByRole('status', { name: 'Loading conversation' })).toBeVisible()
    expect(screen.queryByText('Can you draft the intro?')).toBeNull()
    expect(screen.queryByText('rm -rf /tmp/old')).toBeNull()

    await act(async () => {
      resolveSecond({
        messages: [
          {
            display_kind: 'hidden',
            role: 'user',
            row_id: 'u2-1',
            text: '@scout: Second thread question'
          },
          { role: 'assistant', row_id: 'a2-1', text: 'Second thread answer.' }
        ],
        section: secondThread
      })
      await secondOpen
    })

    expect(await screen.findByText('Second thread question')).toBeVisible()
    expect(screen.getByText('Second thread answer.')).toBeVisible()
    expect(screen.queryByText('rm -rf /tmp/old')).toBeNull()
  })

  it('opens file links beside the thread without quick tools, distinct from an open owner-chat tab, and recovers on same-daemon reconnect', async () => {
    visualsActions().closeAll()
    useConnection.setState({ connects: 1, epoch: 'daemon-1', status: 'connected' })

    // Pre-open the same path in the underlying owner chat with quick tools enabled.
    visualsActions().open(
      fileTab('plan.md', {
        askable: true,
        mime: 'text/markdown',
        path: '/work/plan.md',
        sectionId: 'owner-chat',
        sessionId: 'owner-live'
      })
    )

    let attempt = 0
    rpc({
      'hexbot.sections.open': () => {
        attempt += 1

        if (attempt === 1) {
          throw new Error('socket closed')
        }

        return {
          messages: [
            {
              display_kind: 'hidden',
              role: 'user',
              row_id: 'u-file',
              text: '@scout: Check [plan.md](/work/plan.md)'
            }
          ],
          section: thread
        }
      }
    })

    render(<ThreadView thread={{ bot: 'writer', peer: 'scout', sectionId: 'th1' }} />)
    expect(await screen.findByText('socket closed')).toBeVisible()

    // Reconnecting to the same daemon keeps the same epoch but increments connects, retrying the read.
    act(() => {
      useConnection.getState().setStatus('reconnecting')
      useConnection.getState().setStatus('connected')
    })

    const fileLink = await screen.findByRole('button', { name: /plan\.md/ })
    fireEvent.click(fileLink)

    // Clicking the peer thread's link opens a distinct tab bound to the peer session (askable: false),
    // never activating the covered owner chat's askable: true tab.
    const { active, tabs } = useVisuals.getState()
    expect(tabs).toHaveLength(2)
    const opened = tabs.find(tab => tab.toolId === active)
    expect(opened && 'file' in opened).toBe(true)

    if (opened && 'file' in opened) {
      expect(opened.file.path).toBe('/work/plan.md')
      expect(opened.file.askable).toBe(false)
      expect(opened.file.sessionId).toBe('live-t')
      expect(opened.file.sectionId).toBe('th1')
    }

    visualsActions().closeAll()
  })

  it('renders generated media from tool results without text and keeps playback mounted across reloads', async () => {
    const mediaMessages: HistoryRow[] = [
      history[0]!,
      {
        role: 'assistant',
        row_id: 'a-tts',
        text: '',
        tool_calls: [
          {
            function: { arguments: '{"text":"Hello"}', name: 'text_to_speech' },
            id: 'tts-1'
          }
        ]
      },
      {
        name: 'text_to_speech',
        role: 'tool',
        row_id: 'tr-tts',
        text: JSON.stringify({ file: 'MEDIA:/work/reply.mp3' }),
        tool_call_id: 'tts-1'
      }
    ]

    let reloadOpen: ((value: { messages: HistoryRow[]; section: Section }) => void) | null = null
    let openCount = 0

    rpc({
      'hexbot.files.read': () => ({
        media_path: '/api/media/0123456789abcdef0123456789abcdef',
        mime: 'audio/mpeg',
        name: 'reply.mp3',
        path: '/work/reply.mp3',
        size: 5
      }),
      'hexbot.sections.open': () => {
        openCount += 1

        if (openCount === 1) {
          return { messages: mediaMessages, section: thread }
        }

        return new Promise<{ messages: HistoryRow[]; section: Section }>(resolve => {
          reloadOpen = resolve
        })
      }
    })

    render(<ThreadView thread={{ bot: 'writer', peer: 'scout', sectionId: 'th1' }} />)
    expect(await screen.findByText('Can you draft the intro?')).toBeVisible()
    const replyArticle = await screen.findByTestId('thread-reply')
    expect(replyArticle).toHaveTextContent('Writer')
    fireEvent.click(screen.getByRole('button', { name: 'Load reply.mp3' }))
    await waitFor(() => expect(replyArticle.querySelector('audio')).not.toBeNull())
    const audioBefore = replyArticle.querySelector('audio')!

    // A peer-question reload calls forgetLive + touchThread while re-reading history.
    act(() => {
      useSections.getState().forgetLive('th1')
      useUi.getState().touchThread('th1')
    })
    // Playback stays mounted during the reload instead of collapsing to a file card or Load button.
    expect(replyArticle.querySelector('audio')).toBe(audioBefore)

    await act(async () => {
      reloadOpen?.({
        messages: [
          ...mediaMessages,
          { display_kind: 'hidden', role: 'user', row_id: 'u-next', text: '@scout: Follow-up' }
        ],
        section: thread
      })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(await screen.findByText('Follow-up')).toBeVisible()
    expect(screen.getByTestId('thread-reply').querySelector('audio')).toBe(audioBefore)

    // A transient background reload failure keeps the loaded conversation and audio mounted.
    rpc({
      'hexbot.sections.open': () => {
        throw new Error('request timed out')
      }
    })
    act(() => useUi.getState().touchThread('th1'))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.queryByText('request timed out')).toBeNull()
    expect(screen.getByTestId('thread-reply').querySelector('audio')).toBe(audioBefore)

    // A definitive 4204 (deleted thread) on reload replaces the stale conversation with the unavailable message.
    rpc({
      'hexbot.sections.open': () => {
        throw new JsonRpcGatewayError('section not found: th1', { code: 4204 })
      }
    })
    act(() => useUi.getState().touchThread('th1'))
    expect(await screen.findByText('This conversation is no longer available.')).toBeVisible()
  })

  it('keeps media playback mounted when a live reply transitions into stored history with an earlier tool call filled in', async () => {
    let phase: 'live' | 'stored' = 'live'
    rpc({
      'hexbot.files.read': () => ({
        media_path: '/api/media/0123456789abcdef0123456789abcdef',
        mime: 'audio/mpeg',
        name: 'live-reply.mp3',
        path: '/work/live-reply.mp3',
        size: 5
      }),
      'hexbot.sections.open': () => ({
        messages:
          phase === 'live'
            ? [history[0]!]
            : [
                history[0]!,
                {
                  role: 'assistant',
                  row_id: 'pi-reply',
                  text: 'Here is the clip.',
                  tool_calls: [
                    {
                      function: { arguments: '{"query":"tone"}', name: 'web_search' },
                      id: 'earlier-tool'
                    },
                    {
                      function: { arguments: '{"text":"Hello"}', name: 'text_to_speech' },
                      id: 'tts-live-1'
                    }
                  ]
                },
                {
                  name: 'web_search',
                  role: 'tool',
                  row_id: 'tr-earlier',
                  text: 'ok',
                  tool_call_id: 'earlier-tool'
                },
                {
                  name: 'text_to_speech',
                  role: 'tool',
                  row_id: 'tr-tts-live-1',
                  text: JSON.stringify({ file: 'MEDIA:/work/live-reply.mp3' }),
                  tool_call_id: 'tts-live-1'
                }
              ],
        section: thread
      })
    })

    render(<ThreadView thread={{ bot: 'writer', peer: 'scout', sectionId: 'th1' }} />)
    expect(await screen.findByText('Can you draft the intro?')).toBeVisible()

    const transcripts = useTranscripts.getState()
    act(() => {
      transcripts.messageStart('live-t')
      transcripts.toolStart('live-t', { name: 'text_to_speech', tool_id: 'tts-live-1' })
      transcripts.toolComplete('live-t', {
        name: 'text_to_speech',
        result: { file: 'MEDIA:/work/live-reply.mp3' },
        tool_id: 'tts-live-1'
      })
      transcripts.messageDelta('live-t', 'Here is the clip.')
    })

    const replyArticle = await screen.findByTestId('thread-reply')
    fireEvent.click(screen.getByRole('button', { name: 'Load live-reply.mp3' }))
    await waitFor(() => expect(replyArticle.querySelector('audio')).not.toBeNull())
    const audioBefore = replyArticle.querySelector('audio')!

    // Reply completes and history reloads with durable row_id 'pi-reply'; audio stays mounted.
    phase = 'stored'
    act(() => {
      transcripts.messageComplete('live-t', { text: 'Here is the clip.' })
    })
    await waitFor(() => expect(screen.getByText('Here is the clip.')).toBeVisible())
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.getByTestId('thread-reply').querySelector('audio')).toBe(audioBefore)
  })

  it('keeps live playback mounted when the peer question reload resolves after playback begins', async () => {
    let resolveQuestionReload: ((value: { messages: HistoryRow[]; section: Section }) => void) | null =
      null

    let openCount = 0

    const firstExchange: HistoryRow[] = [
      {
        display_kind: 'hidden',
        role: 'user',
        row_id: 'u1',
        text: '@scout: First question',
        turn_id: 'turn-1'
      },
      { role: 'assistant', row_id: 'a1', text: 'First answer.', turn_id: 'turn-1' }
    ]

    const secondQuestion: HistoryRow = {
      display_kind: 'hidden',
      role: 'user',
      row_id: 'u2',
      text: '@scout: Late question',
      turn_id: 'turn-2'
    }

    rpc({
      'hexbot.files.read': () => ({
        media_path: '/api/media/0123456789abcdef0123456789abcdef',
        mime: 'audio/mpeg',
        name: 'late-q.mp3',
        path: '/work/late-q.mp3',
        size: 5
      }),
      'hexbot.sections.open': () => {
        openCount += 1

        if (openCount === 1) {
          return { messages: firstExchange, section: thread }
        }

        if (openCount === 2) {
          return new Promise<{ messages: HistoryRow[]; section: Section }>(resolve => {
            resolveQuestionReload = resolve
          })
        }

        return {
          messages: [
            ...firstExchange,
            secondQuestion,
            {
              role: 'assistant',
              row_id: 'a2',
              text: 'Second answer.',
              tool_calls: [
                {
                  function: { arguments: '{"text":"Second"}', name: 'text_to_speech' },
                  id: 'tts-turn-2'
                }
              ],
              turn_id: 'turn-2'
            },
            {
              name: 'text_to_speech',
              role: 'tool',
              row_id: 'tr-tts-turn-2',
              text: JSON.stringify({ file: 'MEDIA:/work/late-q.mp3' }),
              tool_call_id: 'tts-turn-2',
              turn_id: 'turn-2'
            }
          ],
          section: thread
        }
      }
    })

    render(<ThreadView thread={{ bot: 'writer', peer: 'scout', sectionId: 'th1' }} />)
    expect(await screen.findByText('First answer.')).toBeVisible()

    // Second turn starts streaming and produces audio while the question reload is still pending.
    const transcripts = useTranscripts.getState()
    act(() => {
      transcripts.eventIdentity('live-t', { turnId: 'turn-2' })
      transcripts.messageStart('live-t')
      transcripts.toolStart('live-t', { name: 'text_to_speech', tool_id: 'tts-turn-2' })
      transcripts.toolComplete('live-t', {
        name: 'text_to_speech',
        result: { file: 'MEDIA:/work/late-q.mp3' },
        tool_id: 'tts-turn-2'
      })
      transcripts.messageDelta('live-t', 'Second answer.')
    })

    fireEvent.click(await screen.findByRole('button', { name: 'Load late-q.mp3' }))
    await waitFor(() => expect(document.querySelector('audio')).not.toBeNull())
    const audioBefore = document.querySelector('audio')!

    // Now the late peer question arrives in history: playback stays mounted.
    await act(async () => {
      resolveQuestionReload?.({
        messages: [...firstExchange, secondQuestion],
        section: thread
      })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(await screen.findByText('Late question')).toBeVisible()
    expect(document.querySelector('audio')).toBe(audioBefore)

    // Turn finishes and stored history loads: playback still stays mounted.
    act(() => {
      transcripts.eventIdentity('live-t', { turnId: 'turn-2' })
      transcripts.messageComplete('live-t', { text: 'Second answer.' })
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(document.querySelector('audio')).toBe(audioBefore)
  })

  it('dismisses an open image lightbox on definitive reload errors while preserving it on transient failures', async () => {
    const imageMessages: HistoryRow[] = [
      history[0]!,
      {
        role: 'assistant',
        row_id: 'a-img',
        text: 'See chart.',
        tool_calls: [
          {
            function: { arguments: '{"prompt":"chart"}', name: 'image_generate' },
            id: 'img-1'
          }
        ]
      },
      {
        name: 'image_generate',
        role: 'tool',
        row_id: 'tr-img-1',
        text: JSON.stringify({ file: 'MEDIA:/work/chart.png' }),
        tool_call_id: 'img-1'
      }
    ]

    rpc({
      'hexbot.files.read': () => ({
        media_path: '/api/media/fedcba9876543210fedcba9876543210',
        mime: 'image/png',
        name: 'chart.png',
        path: '/work/chart.png',
        size: 12
      }),
      'hexbot.sections.open': () => ({ messages: imageMessages, section: thread })
    })

    const { rerender } = render(
      <ThreadView thread={{ bot: 'writer', peer: 'scout', sectionId: 'th1' }} />
    )

    const thumb = await screen.findByRole('button', { name: 'Open chart.png' })
    fireEvent.click(thumb)
    expect(await screen.findByAltText('Attachment preview')).toBeVisible()

    // Transient reload failure keeps the open image preview mounted.
    rpc({
      'hexbot.sections.open': () => {
        throw new Error('request timed out')
      }
    })
    act(() => useUi.getState().touchThread('th1'))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.getByAltText('Attachment preview')).toBeVisible()

    // Definitive 4204 deletion dismisses the image preview so the error state is unobstructed.
    rpc({
      'hexbot.sections.open': () => {
        throw new JsonRpcGatewayError('section not found: th1', { code: 4204 })
      }
    })
    act(() => useUi.getState().touchThread('th1'))
    expect(await screen.findByText('This conversation is no longer available.')).toBeVisible()
    expect(screen.queryByAltText('Attachment preview')).toBeNull()

    // Recovering via Try again does not unexpectedly reopen the dismissed lightbox.
    rpc({
      'hexbot.files.read': () => ({
        media_path: '/api/media/fedcba9876543210fedcba9876543210',
        mime: 'image/png',
        name: 'chart.png',
        path: '/work/chart.png',
        size: 12
      }),
      'hexbot.sections.open': () => ({ messages: imageMessages, section: thread })
    })
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('See chart.')).toBeVisible()
    expect(screen.queryByAltText('Attachment preview')).toBeNull()

    // Opening the preview again and switching to another section dismisses it immediately,
    // keeps Escape working in the second section, and never reopens the old preview on return.
    fireEvent.click(await screen.findByRole('button', { name: 'Open chart.png' }))
    expect(await screen.findByAltText('Attachment preview')).toBeVisible()
    const secondThread = { ...thread, id: 'th2', live_session_id: 'live-t2' } as unknown as Section
    rpc({
      'hexbot.files.read': () => ({
        media_path: '/api/media/fedcba9876543210fedcba9876543210',
        mime: 'image/png',
        name: 'chart.png',
        path: '/work/chart.png',
        size: 12
      }),
      'hexbot.sections.open': params =>
        params.id === 'th2'
          ? {
              messages: [{ role: 'assistant', row_id: 'a2', text: 'Second section ready.' }],
              section: secondThread
            }
          : { messages: imageMessages, section: thread }
    })
    useUi.setState({ thread: { bot: 'writer', peer: 'scout', sectionId: 'th2' } })
    rerender(<ThreadView thread={{ bot: 'writer', peer: 'scout', sectionId: 'th2' }} />)
    expect(screen.queryByAltText('Attachment preview')).toBeNull()
    expect(await screen.findByText('Second section ready.')).toBeVisible()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(useUi.getState().thread).toBeNull()

    // Returning to th1 does not bring back the dismissed image preview.
    useUi.setState({ thread: { bot: 'writer', peer: 'scout', sectionId: 'th1' } })
    rerender(<ThreadView thread={{ bot: 'writer', peer: 'scout', sectionId: 'th1' }} />)
    expect(await screen.findByText('See chart.')).toBeVisible()
    expect(screen.queryByAltText('Attachment preview')).toBeNull()
  })

  it('groups same-turn asks across stored and live fragments after a mid-turn reconnect', async () => {
    useBots.setState({
      byName: {
        ...useBots.getState().byName,
        biology: bot('biology', 'Biology')
      }
    })

    const storedMidTurn: HistoryRow[] = [
      {
        display_kind: 'hidden',
        role: 'user',
        row_id: 'u-mid',
        text: '@scout: Check Biology twice',
        turn_id: 'turn-mid'
      },
      {
        role: 'assistant',
        row_id: 'frag-1',
        text: 'First check done.',
        tool_calls: [
          {
            function: { arguments: '{"to":"biology"}', name: 'message_bot' },
            id: 'call-1'
          }
        ],
        turn_id: 'turn-mid'
      },
      {
        name: 'message_bot',
        role: 'tool',
        row_id: 'tr-1',
        text: JSON.stringify({ section_id: 'th-bio' }),
        tool_call_id: 'call-1',
        turn_id: 'turn-mid'
      }
    ]

    let phase: 'mid' | 'done' = 'mid'
    rpc({
      'hexbot.sections.open': () => ({
        messages:
          phase === 'mid'
            ? storedMidTurn
            : [
                ...storedMidTurn,
                {
                  role: 'assistant',
                  row_id: 'frag-2',
                  text: 'Second check done.',
                  tool_calls: [
                    {
                      function: { arguments: '{"to":"biology"}', name: 'message_bot' },
                      id: 'call-2'
                    }
                  ],
                  turn_id: 'turn-mid'
                },
                {
                  name: 'message_bot',
                  role: 'tool',
                  row_id: 'tr-2',
                  text: JSON.stringify({ section_id: 'th-bio' }),
                  tool_call_id: 'call-2',
                  turn_id: 'turn-mid'
                }
              ],
        section: thread
      }),
      'hexbot.sections.thread': () => ({ section: null })
    })

    render(<ThreadView thread={{ bot: 'writer', peer: 'scout', sectionId: 'th1' }} />)
    expect(await screen.findByText('First check done.')).toBeVisible()
    expect(screen.getAllByTestId('asking-row')).toHaveLength(1)
    expect(screen.getByTestId('asking-row')).toHaveTextContent('Message from Biology')

    // Live transcript joins on a different fragment (frag-2) of the same turn and asks Biology again.
    const transcripts = useTranscripts.getState()
    act(() => {
      transcripts.eventIdentity('live-t', { messageId: 'frag-2', turnId: 'turn-mid' })
      transcripts.messageStart('live-t')
      transcripts.toolStart('live-t', {
        args: { to: 'biology' },
        name: 'message_bot',
        tool_id: 'call-2'
      })
      transcripts.messageDelta('live-t', 'Checking again...')
    })

    expect(await screen.findByText('Checking again...')).toBeVisible()
    // Exactly one ask chip renders for Biology in this turn, updating to Messaging rather than duplicating.
    expect(screen.getAllByTestId('asking-row')).toHaveLength(1)
    expect(screen.getByTestId('asking-row')).toHaveTextContent('Messaging Biology')

    // Once the turn settles and history catches up, still one settled ask chip remains.
    phase = 'done'
    act(() => {
      transcripts.eventIdentity('live-t', { messageId: 'frag-2', turnId: 'turn-mid' })
      transcripts.toolComplete('live-t', {
        name: 'message_bot',
        result: { section_id: 'th-bio' },
        tool_id: 'call-2'
      })
      transcripts.messageComplete('live-t', { text: 'Second check done.' })
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    await waitFor(() => expect(screen.getByText('Second check done.')).toBeVisible())
    expect(screen.getAllByTestId('asking-row')).toHaveLength(1)
    expect(screen.getByTestId('asking-row')).toHaveTextContent('Message from Biology')
  })

  it('settles unfinished asks as failed on error completion, keeps distinct reused tool IDs across fragments, and retains asks until stored history confirms them', async () => {
    useBots.setState({
      byName: {
        ...useBots.getState().byName,
        biology: bot('biology', 'Biology'),
        chemistry: bot('chemistry', 'Chemistry')
      }
    })

    // 1. Two fragments in the same turn reusing call_0 for different bots keep both chips.
    const storedFrag1: HistoryRow[] = [
      {
        display_kind: 'hidden',
        role: 'user',
        row_id: 'u-dup',
        text: '@scout: Ask both',
        turn_id: 'turn-dup'
      },
      {
        role: 'assistant',
        row_id: 'frag-a',
        text: 'Asked Biology.',
        tool_calls: [
          {
            function: { arguments: '{"to":"biology"}', name: 'message_bot' },
            id: 'call_0'
          }
        ],
        turn_id: 'turn-dup'
      },
      {
        context: 'biology',
        name: 'message_bot',
        role: 'tool',
        row_id: 'tr-a',
        text: JSON.stringify({ section_id: 'th-bio' }),
        tool_call_id: 'call_0',
        turn_id: 'turn-dup'
      }
    ]

    let openReply: () => { messages: HistoryRow[]; section: Section } = () => ({
      messages: storedFrag1,
      section: thread
    })

    rpc({
      'hexbot.sections.open': () => openReply(),
      'hexbot.sections.thread': () => ({ section: null })
    })

    render(<ThreadView thread={{ bot: 'writer', peer: 'scout', sectionId: 'th1' }} />)
    expect(await screen.findByText('Asked Biology.')).toBeVisible()

    const transcripts = useTranscripts.getState()
    act(() => {
      transcripts.eventIdentity('live-t', { messageId: 'frag-b', turnId: 'turn-dup' })
      transcripts.messageStart('live-t')
      transcripts.toolStart('live-t', {
        args: { to: 'chemistry' },
        name: 'message_bot',
        tool_id: 'call_0'
      })
      transcripts.messageDelta('live-t', 'Asking Chemistry...')
    })

    expect(await screen.findByText('Asking Chemistry...')).toBeVisible()
    const rows = screen.getAllByTestId('asking-row')
    expect(rows).toHaveLength(2)
    expect(rows.map(row => row.textContent)).toEqual([
      'Message from Biology',
      'Messaging Chemistry'
    ])

    // 2. Completing with status: 'error' settles the unfinished Chemistry ask as Asked, keeping Biology's reply.
    // frag-b declares call_0 for Chemistry while its tool result is still pending, making api.ts leave
    // Biology's stored result messageId unset; Chemistry's live ask must NOT be falsely confirmed by it.
    openReply = () => ({
      messages: [
        ...storedFrag1,
        {
          role: 'assistant',
          row_id: 'frag-b',
          text: 'Stopped early.',
          tool_calls: [
            {
              function: { arguments: '{"to":"chemistry"}', name: 'message_bot' },
              id: 'call_0'
            }
          ],
          turn_id: 'turn-dup'
        }
      ],
      section: thread
    })
    act(() => {
      transcripts.eventIdentity('live-t', { messageId: 'frag-b', turnId: 'turn-dup' })
      transcripts.messageComplete('live-t', { status: 'error', text: 'Stopped early.' })
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    // 3. History already has frag-b's text but omits Chemistry's tool row: live ask stays retained without duplicating text.
    const settledRows = screen.getAllByTestId('asking-row')
    expect(settledRows).toHaveLength(2)
    expect(settledRows.map(row => row.textContent)).toEqual([
      'Message from Biology',
      'Asked Chemistry'
    ])
    expect(screen.getAllByText('Stopped early.')).toHaveLength(1)
  })

  it('retains both asks in the legacy merge path without fragment IDs when identical text reuses call_0 for a different bot', () => {
    const storedMsg: Message = {
      attachments: [],
      createdAt: 1,
      id: 'stored-1',
      role: 'assistant',
      streaming: false,
      text: 'Checking now.',
      toolCalls: [
        {
          args: { to: 'biology' },
          durationS: null,
          name: 'message_bot',
          result: { section_id: 'th-bio' },
          startedAt: 0,
          status: 'ok',
          toolId: 'call_0'
        }
      ]
    }

    const liveMsg: Message = {
      attachments: [],
      createdAt: 2,
      id: 'live-1',
      role: 'assistant',
      streaming: true,
      text: 'Checking now.',
      toolCalls: [
        {
          args: { to: 'chemistry' },
          durationS: null,
          name: 'message_bot',
          result: null,
          startedAt: 0,
          status: 'running',
          toolId: 'call_0'
        }
      ]
    }

    const merged = mergeThreadMessages([storedMsg], [liveMsg])
    expect(merged).toHaveLength(1)
    expect(merged[0]!.toolCalls.map(call => (call.args as { to?: string })?.to)).toEqual([
      'biology',
      'chemistry'
    ])
  })

  it('retires an older retained legacy reply instead of folding its ask into a newer exchange with identical text', () => {
    const userMsg = (id: string, text: string): Message => ({
      attachments: [],
      createdAt: 1,
      id,
      role: 'user',
      streaming: false,
      text,
      toolCalls: []
    })

    const askMsg = (id: string, to: string, sectionId: string, streaming = false): Message => ({
      attachments: [],
      createdAt: 2,
      id,
      role: 'assistant',
      streaming,
      text: 'Done.',
      toolCalls: [
        {
          args: { to },
          durationS: null,
          name: 'message_bot',
          result: { section_id: sectionId },
          startedAt: 0,
          status: 'ok',
          toolId: 'call_0'
        }
      ]
    })

    const stored = [
      userMsg('u1', 'First q'),
      askMsg('a1', 'biology', 'th-bio'),
      userMsg('u2', 'Second q'),
      askMsg('a2', 'chemistry', 'th-chem')
    ]

    const retainedFirst = askMsg('live-1', 'biology', 'th-bio', false)
    const merged = mergeThreadMessages(stored, [retainedFirst])

    const assistantAsks = merged
      .filter(message => message.role === 'assistant')
      .map(message => message.toolCalls.map(call => (call.args as { to?: string })?.to))

    expect(assistantAsks).toEqual([['biology'], ['chemistry']])

    // An unpersisted second reply after a new user question with no stored reply yet is NOT retired by Exchange 1.
    const pendingSecond = mergeThreadMessages(
      [userMsg('u1', 'First q'), askMsg('a1', 'biology', 'th-bio'), userMsg('u2', 'Second q')],
      [askMsg('live-2', 'biology', 'th-bio', false)]
    )

    expect(
      pendingSecond
        .filter(message => message.role === 'assistant')
        .map(message => message.toolCalls.map(call => (call.args as { to?: string })?.to))
    ).toEqual([['biology'], ['biology']])

    // When Q2 only has an interim/partial fragment stored ("Checking." or "I will check."),
    // Q1 must NEVER retire Q2's completed live reply or its Biology ask.
    const interimReply = (id: string, text: string): Message => ({
      attachments: [],
      createdAt: 3,
      id,
      role: 'assistant',
      streaming: false,
      text,
      toolCalls: []
    })

    const multiPartFirst: Message = {
      ...askMsg('a1-multi', 'biology', 'th-bio'),
      parts: ['Checking.']
    }

    const multiPartSecondLive: Message = {
      ...askMsg('live-2-multi', 'biology', 'th-bio'),
      parts: ['Checking.']
    }

    const mergedPartial = mergeThreadMessages(
      [
        userMsg('u1', 'First check'),
        multiPartFirst,
        userMsg('u2', 'Second check'),
        interimReply('a2-partial', 'Checking.')
      ],
      [multiPartSecondLive]
    )

    expect(
      mergedPartial
        .filter(message => message.role === 'assistant')
        .map(message => ({
          asks: message.toolCalls.map(call => (call.args as { to?: string })?.to),
          text: message.text
        }))
    ).toEqual([
      { asks: ['biology'], text: 'Done.' },
      { asks: ['biology'], text: 'Done.' }
    ])

    const mergedInterim = mergeThreadMessages(
      [
        userMsg('u1', 'First q'),
        askMsg('a1', 'biology', 'th-bio'),
        userMsg('u2', 'Second q'),
        interimReply('a2-interim', 'I will check.')
      ],
      [{ ...askMsg('live-2-done', 'biology', 'th-bio'), createdAt: 4 }]
    )

    expect(
      mergedInterim
        .filter(message => message.role === 'assistant')
        .map(message => ({
          asks: message.toolCalls.map(call => (call.args as { to?: string })?.to),
          text: message.text
        }))
    ).toEqual([
      { asks: ['biology'], text: 'Done.' },
      { asks: [], text: 'I will check.' },
      { asks: ['biology'], text: 'Done.' }
    ])

    // Even when Q2's partial stored reply already says "Done." with zero asks,
    // Q1 must NOT retire Q2's completed live "Done." + Biology ask.
    const mergedSameTextNoAsk = mergeThreadMessages(
      [
        { ...userMsg('u1', 'First q'), sentAt: 10 },
        { ...askMsg('a1', 'biology', 'th-bio'), sentAt: 20 },
        { ...userMsg('u2', 'Second q'), sentAt: 30 },
        { ...interimReply('a2-done-no-ask', 'Done.'), sentAt: 40 }
      ],
      [{ ...askMsg('live-2-same-text', 'biology', 'th-bio'), sentAt: 45 }]
    )

    expect(
      mergedSameTextNoAsk
        .filter(message => message.role === 'assistant')
        .map(message => ({
          asks: message.toolCalls.map(call => (call.args as { to?: string })?.to),
          text: message.text
        }))
    ).toEqual([
      { asks: ['biology'], text: 'Done.' },
      { asks: ['biology'], text: 'Done.' }
    ])

    // When both exchanges ask Chemistry and Biology and Q2's partial snapshot already holds
    // "Done." + Chemistry (while Biology is still unpersisted), Q1 must NOT retire Q2's reply.
    const twoAskMsg = (id: string, sentAtValue?: number): Message => ({
      attachments: [],
      createdAt: 2,
      id,
      role: 'assistant',
      ...(sentAtValue !== undefined && { sentAt: sentAtValue }),
      streaming: false,
      text: 'Done.',
      toolCalls: [
        {
          args: { to: 'chemistry' },
          durationS: null,
          name: 'message_bot',
          result: { section_id: 'th-chem' },
          startedAt: 0,
          status: 'ok',
          toolId: 'call_0'
        },
        {
          args: { to: 'biology' },
          durationS: null,
          name: 'message_bot',
          result: { section_id: 'th-bio' },
          startedAt: 0,
          status: 'ok',
          toolId: 'call_1'
        }
      ]
    })

    const mergedPartialSecondAsk = mergeThreadMessages(
      [
        { ...userMsg('u1', 'First q'), sentAt: 10 },
        twoAskMsg('a1-both', 20),
        { ...userMsg('u2', 'Second q'), sentAt: 30 },
        { ...askMsg('a2-only-chem', 'chemistry', 'th-chem'), sentAt: 40 }
      ],
      [twoAskMsg('live-2-both', 45)]
    )

    expect(
      mergedPartialSecondAsk
        .filter(message => message.role === 'assistant')
        .map(message => message.toolCalls.map(call => (call.args as { to?: string })?.to))
    ).toEqual([
      ['chemistry', 'biology'],
      ['chemistry', 'biology']
    ])
  })

  it('shows Messaging Biology when opening a busy thread mid-call before tool.complete arrives', async () => {
    useBots.setState({
      byName: {
        biology: bot('biology', 'Biology'),
        scout: bot('scout', 'Scout'),
        writer: bot('writer', 'Writer')
      },
      loaded: true,
      order: ['writer', 'scout', 'biology']
    })

    rpc({
      'hexbot.sections.open': () => ({
        busy: true,
        messages: [
          {
            display_kind: 'hidden',
            role: 'user',
            row_id: 'u1',
            text: '@scout: Ask Biology',
            turn_id: 'T1'
          },
          {
            role: 'assistant',
            row_id: 'a1',
            text: 'Checking.',
            tool_calls: [
              {
                function: { arguments: '{"to":"biology"}', name: 'message_bot' },
                id: 'call_0',
                type: 'function'
              }
            ],
            turn_id: 'T1'
          }
        ],
        section: thread
      })
    })

    render(<ThreadView thread={{ bot: 'writer', peer: 'scout', sectionId: 'th1' }} />)
    await screen.findByText('Checking.')
    expect(screen.getByTestId('asking-row').textContent).toBe('Messaging Biology')

    act(() => {
      const actions = useTranscripts.getState()
      actions.eventIdentity('live-t', { messageId: 'a1', turnId: 'T1' })
      actions.toolComplete('live-t', {
        context: 'biology',
        name: 'message_bot',
        result: { details: { section_id: 'th-bio', status: 'replied' } },
        tool_id: 'call_0'
      })
    })
    await waitFor(() => {
      expect(screen.getByTestId('asking-row').textContent).toBe('Message from Biology')
    })
    // Stored fragment text ("Checking.") must remain visible after tool.complete settles the chip.
    expect(screen.getByText('Checking.')).toBeVisible()
  })

  it('keeps stored terminal results over stale live running calls and settles untagged reused call_0 completions', () => {
    // 1. Reconnecting past tool.complete: stored terminal result wins over stale live running call.
    const storedSettled: Message = {
      attachments: [],
      createdAt: 0,
      fragmentIds: ['a1'],
      id: 'a1',
      role: 'assistant',
      streaming: false,
      text: 'Done.',
      textId: 'a1',
      toolCalls: [
        {
          args: { to: 'biology' },
          durationS: null,
          messageId: 'a1',
          name: 'message_bot',
          result: { section_id: 'th-bio' },
          startedAt: 0,
          status: 'ok',
          toolId: 'call_0'
        }
      ],
      turnId: 'T1'
    }

    const staleLiveRunning: Message = {
      attachments: [],
      createdAt: 2,
      fragmentIds: ['a1'],
      id: 'live-1',
      role: 'assistant',
      streaming: true,
      text: '',
      toolCalls: [
        {
          args: { to: 'biology' },
          durationS: null,
          messageId: 'a1',
          name: 'message_bot',
          result: null,
          startedAt: 100,
          status: 'running',
          toolId: 'call_0'
        }
      ],
      turnId: 'T1'
    }

    const reconnected = mergeThreadMessages([storedSettled], [staleLiveRunning])
    expect(reconnected).toHaveLength(1)
    expect(reconnected[0]!.text).toBe('Done.')
    expect(reconnected[0]!.toolCalls).toMatchObject([
      { name: 'message_bot', result: { section_id: 'th-bio' }, status: 'ok', toolId: 'call_0' }
    ])

    // 2. Ambiguous reused call_0 completion without messageId settles the sole running hydrated ask.
    const storedChemDone: Message = {
      attachments: [],
      createdAt: 0,
      fragmentIds: ['a1'],
      id: 'a1',
      role: 'assistant',
      streaming: false,
      text: 'Asked Chem.',
      textId: 'a1',
      toolCalls: [
        {
          args: { to: 'chemistry' },
          durationS: null,
          messageId: 'a1',
          name: 'message_bot',
          result: { section_id: 'th-chem' },
          startedAt: 0,
          status: 'ok',
          toolId: 'call_0'
        }
      ],
      turnId: 'T2'
    }

    const storedBioRunning: Message = {
      attachments: [],
      createdAt: 0,
      fragmentIds: ['a2'],
      id: 'a2',
      role: 'assistant',
      streaming: false,
      text: 'Asking Bio.',
      textId: 'a2',
      toolCalls: [
        {
          args: { to: 'biology' },
          durationS: null,
          messageId: 'a2',
          name: 'message_bot',
          result: null,
          startedAt: 0,
          status: 'running',
          toolId: 'call_0'
        }
      ],
      turnId: 'T2'
    }

    const untaggedBioComplete: Message = {
      attachments: [],
      createdAt: 5,
      id: 'live-2',
      role: 'assistant',
      streaming: true,
      text: '',
      toolCalls: [
        {
          args: null,
          durationS: null,
          name: 'message_bot',
          result: { details: { section_id: 'th-bio', status: 'replied' } },
          startedAt: 200,
          status: 'ok',
          summary: 'biology',
          toolId: 'call_0'
        }
      ],
      turnId: 'T2'
    }

    const settled = mergeThreadMessages([storedChemDone, storedBioRunning], [untaggedBioComplete])
    expect(settled.flatMap(m => m.toolCalls)).toMatchObject([
      { args: { to: 'chemistry' }, status: 'ok', toolId: 'call_0' },
      {
        args: { to: 'biology' },
        messageId: 'a2',
        result: { details: { section_id: 'th-bio', status: 'replied' } },
        status: 'ok',
        toolId: 'call_0'
      }
    ])

    // 3. Untagged completion stays settled even after a later text delta gives the live message
    //    fragment a3, OR when the live message shares fragment a1 with earlier streamed text.
    const liveWithLaterFragment: Message = {
      ...untaggedBioComplete,
      fragmentIds: ['a3'],
      text: 'Continuing.',
      textId: 'a3'
    }

    const afterLaterDelta = mergeThreadMessages(
      [storedChemDone, storedBioRunning],
      [liveWithLaterFragment]
    )

    expect(afterLaterDelta.flatMap(m => m.toolCalls)).toMatchObject([
      { args: { to: 'chemistry' }, status: 'ok', toolId: 'call_0' },
      {
        args: { to: 'biology' },
        messageId: 'a2',
        result: { details: { section_id: 'th-bio', status: 'replied' } },
        status: 'ok',
        toolId: 'call_0'
      }
    ])
    expect(afterLaterDelta.map(m => m.text)).toEqual(['Asked Chem.', 'Asking Bio.', 'Continuing.'])

    const liveSharingA1: Message = {
      ...untaggedBioComplete,
      fragmentIds: ['a1'],
      text: 'Asked Chem.',
      textId: 'a1'
    }

    const afterSharedA1 = mergeThreadMessages([storedChemDone, storedBioRunning], [liveSharingA1])
    expect(afterSharedA1.flatMap(m => m.toolCalls)).toMatchObject([
      { args: { to: 'chemistry' }, status: 'ok', toolId: 'call_0' },
      {
        args: { to: 'biology' },
        messageId: 'a2',
        result: { details: { section_id: 'th-bio', status: 'replied' } },
        status: 'ok',
        toolId: 'call_0'
      }
    ])

    // 4. Stale live prefix ("Check") after reconnect must never truncate fuller stored text ("Checking Biology.").
    const storedFuller: Message = {
      attachments: [],
      createdAt: 0,
      fragmentIds: ['a1'],
      id: 'a1',
      role: 'assistant',
      streaming: false,
      text: 'Checking Biology.',
      textId: 'a1',
      toolCalls: [],
      turnId: 'T3'
    }

    const stalePrefixLive: Message = {
      attachments: [],
      createdAt: 10,
      fragmentIds: ['a1'],
      id: 'live-prefix',
      role: 'assistant',
      streaming: true,
      text: 'Check',
      textId: 'a1',
      toolCalls: [],
      turnId: 'T3'
    }

    const upgraded = mergeThreadMessages([storedFuller], [stalePrefixLive])
    expect(upgraded).toHaveLength(1)
    expect(upgraded[0]!.text).toBe('Checking Biology.')
    expect(upgraded[0]!.parts).toBeUndefined()

    // 5. Merging a stale live copy carrying only an earlier fragment (a1="Fir") onto a stored
    //    multi-fragment reply (a1="First.", a2="Second.") keeps ["First.", "Second."] in order.
    const storedMulti: Message = {
      attachments: [],
      createdAt: 0,
      fragmentIds: ['a1', 'a2'],
      id: 'a1',
      partIds: ['a1'],
      parts: ['First.'],
      role: 'assistant',
      streaming: false,
      text: 'Second.',
      textId: 'a2',
      toolCalls: [],
      turnId: 'T4'
    }

    const staleEarlierLive: Message = {
      attachments: [],
      createdAt: 11,
      fragmentIds: ['a1'],
      id: 'live-earlier',
      role: 'assistant',
      streaming: true,
      text: 'Fir',
      textId: 'a1',
      toolCalls: [],
      turnId: 'T4'
    }

    const preservedOrder = mergeThreadMessages([storedMulti], [staleEarlierLive])
    expect(preservedOrder).toHaveLength(1)
    expect([...(preservedOrder[0]!.parts ?? []), preservedOrder[0]!.text]).toEqual([
      'First.',
      'Second.'
    ])

    // 6. Stored wait:false send on call_0 must NOT retire a completed untagged wait:true reply
    //    on the same target/section (either alone or alongside a running a2 ask in the same turn).
    const storedBioSent: Message = {
      attachments: [],
      createdAt: 0,
      fragmentIds: ['a1'],
      id: 'a1',
      role: 'assistant',
      streaming: false,
      text: '',
      toolCalls: [
        {
          args: { to: 'biology', wait: false },
          durationS: null,
          messageId: 'a1',
          name: 'message_bot',
          result: { section_id: 'th-bio', status: 'sent' },
          startedAt: 0,
          status: 'ok',
          toolId: 'call_0'
        }
      ],
      turnId: 'T5'
    }

    const settledUntaggedReply: Message = {
      attachments: [],
      createdAt: 12,
      id: 'live-reply-only',
      role: 'assistant',
      streaming: false,
      text: '',
      toolCalls: [
        {
          args: null,
          durationS: null,
          name: 'message_bot',
          result: { details: { section_id: 'th-bio', status: 'replied' } },
          startedAt: 300,
          status: 'ok',
          summary: 'biology',
          toolId: 'call_0'
        }
      ],
      turnId: 'T5'
    }

    const mergedSendAndReply = mergeThreadMessages([storedBioSent], [settledUntaggedReply])
    expect(asksOf(mergedSendAndReply.flatMap(m => m.toolCalls))).toEqual([
      { sectionId: 'th-bio', sent: false, status: 'ok', target: 'biology' }
    ])

    // Same when history also carries the pending running a2 ask and the settled live message
    // carries fragmentIds: ['a2'] with an untagged tool result (both send+reply and reply+reply).
    const storedBioRunningA2: Message = {
      attachments: [],
      createdAt: 0,
      fragmentIds: ['a2'],
      id: 'a2',
      role: 'assistant',
      streaming: false,
      text: '',
      toolCalls: [
        {
          args: { to: 'biology', wait: true },
          durationS: null,
          messageId: 'a2',
          name: 'message_bot',
          result: null,
          startedAt: 0,
          status: 'running',
          toolId: 'call_0'
        }
      ],
      turnId: 'T5'
    }

    const settledA2Live: Message = {
      ...settledUntaggedReply,
      fragmentIds: ['a2'],
      id: 'live-a2-settled'
    }

    const settledFromSend = mergeThreadMessages([storedBioSent, storedBioRunningA2], [settledA2Live])
    expect(asksOf(settledFromSend.flatMap(m => m.toolCalls))).toEqual([
      { sectionId: 'th-bio', sent: false, status: 'ok', target: 'biology' }
    ])

    const storedBioRepliedA1: Message = {
      ...storedBioSent,
      toolCalls: [
        {
          ...storedBioSent.toolCalls[0]!,
          args: { to: 'biology', wait: true },
          result: { reply: 'First answer.', section_id: 'th-bio' }
        }
      ]
    }

    const settledFromReply = mergeThreadMessages(
      [storedBioRepliedA1, storedBioRunningA2],
      [settledA2Live]
    )

    expect(asksOf(settledFromReply.flatMap(m => m.toolCalls))).toEqual([
      { sectionId: 'th-bio', sent: false, status: 'ok', target: 'biology' }
    ])
    expect(settledFromReply.flatMap(m => m.toolCalls).every(c => c.status === 'ok')).toBe(true)

    // 7. When a turn already has a settled Biology #1 reply (a2) and a later running Biology #2
    //    ask (a3) reusing call_0, a live message carrying only Biology #1's untagged completion
    //    must NOT settle a3 while Biology #2 is still working.
    const storedChemA1: Message = {
      attachments: [],
      createdAt: 0,
      fragmentIds: ['a1'],
      id: 'a1',
      role: 'assistant',
      streaming: false,
      text: 'Asked Chem.',
      toolCalls: [
        {
          args: { to: 'chemistry', wait: true },
          durationS: null,
          messageId: 'a1',
          name: 'message_bot',
          result: { reply: 'Chem ok', section_id: 'th-chem' },
          startedAt: 0,
          status: 'ok',
          toolId: 'call_0'
        }
      ],
      turnId: 'T6'
    }

    const storedBio1A2: Message = {
      attachments: [],
      createdAt: 0,
      fragmentIds: ['a2'],
      id: 'a2',
      role: 'assistant',
      streaming: false,
      text: 'Asked Bio 1.',
      toolCalls: [
        {
          args: { text: 'first question', to: 'biology', wait: true },
          durationS: null,
          messageId: 'a2',
          name: 'message_bot',
          result: { reply: 'First answer', section_id: 'th-bio' },
          startedAt: 0,
          status: 'ok',
          toolId: 'call_0'
        }
      ],
      turnId: 'T6'
    }

    const storedBio2A3Running: Message = {
      attachments: [],
      createdAt: 0,
      fragmentIds: ['a3'],
      id: 'a3',
      role: 'assistant',
      streaming: false,
      text: 'Asked Bio 2.',
      toolCalls: [
        {
          args: { text: 'follow-up question', to: 'biology', wait: true },
          durationS: null,
          messageId: 'a3',
          name: 'message_bot',
          result: null,
          startedAt: 0,
          status: 'running',
          toolId: 'call_0'
        }
      ],
      turnId: 'T6'
    }

    const liveStillHoldingFirstBio: Message = {
      attachments: [],
      createdAt: 20,
      id: 'live-bio-1-only',
      role: 'assistant',
      streaming: true,
      text: '',
      toolCalls: [
        {
          args: null,
          durationS: null,
          name: 'message_bot',
          result: { details: { section_id: 'th-bio', status: 'replied' } },
          startedAt: 400,
          status: 'ok',
          summary: 'biology',
          toolId: 'call_0'
        }
      ],
      turnId: 'T6'
    }

    const stillWorking = mergeThreadMessages(
      [storedChemA1, storedBio1A2, storedBio2A3Running],
      [liveStillHoldingFirstBio]
    )

    expect(stillWorking.find(m => m.id === 'a3')?.toolCalls[0]?.status).toBe('running')
    expect(asksOf(stillWorking.flatMap(m => m.toolCalls))).toEqual([
      { sectionId: 'th-chem', sent: false, status: 'ok', target: 'chemistry' },
      { sectionId: 'th-bio', sent: false, status: 'running', target: 'biology' }
    ])

    // 8. Cold web thread opened during Biology #2 (a3 running): once Biology #2 answers with a
    //    distinct reply (even without messageId or args on tool.complete), a3 settles cleanly.
    const liveSecondBioAnswered: Message = {
      attachments: [],
      createdAt: 25,
      id: 'live-bio-2-done',
      role: 'assistant',
      streaming: true,
      text: '',
      toolCalls: [
        {
          args: null,
          durationS: null,
          name: 'message_bot',
          result: { details: { reply: 'Second answer', section_id: 'th-bio' } },
          startedAt: 500,
          status: 'ok',
          summary: 'biology',
          toolId: 'call_0'
        }
      ],
      turnId: 'T6'
    }

    const followUpSettled = mergeThreadMessages(
      [storedChemA1, storedBio1A2, storedBio2A3Running],
      [liveSecondBioAnswered]
    )

    expect(followUpSettled.find(m => m.id === 'a3')?.toolCalls[0]?.status).toBe('ok')
    expect(asksOf(followUpSettled.flatMap(m => m.toolCalls))).toEqual([
      { sectionId: 'th-chem', sent: false, status: 'ok', target: 'chemistry' },
      { sectionId: 'th-bio', sent: false, status: 'ok', target: 'biology' }
    ])

    // 9. Two completely identical synchronous Biology asks reusing call_0 and both returning "OK"
    //    stay unambiguously distinct via occurrenceId even when messageId is omitted.
    const identicalBio1: Message = {
      ...storedBio1A2,
      toolCalls: [
        {
          ...storedBio1A2.toolCalls[0]!,
          args: { text: 'Ping', to: 'biology', wait: true },
          occurrenceId: 'occ-bio-1',
          result: { reply: 'OK', section_id: 'th-bio' }
        }
      ]
    }

    const identicalBio2Running: Message = {
      ...storedBio2A3Running,
      toolCalls: [
        {
          ...storedBio2A3Running.toolCalls[0]!,
          args: { text: 'Ping', to: 'biology', wait: true },
          occurrenceId: 'occ-bio-2'
        }
      ]
    }

    const identicalBio2Complete: Message = {
      attachments: [],
      createdAt: 30,
      id: 'live-bio-2-identical',
      role: 'assistant',
      streaming: true,
      text: '',
      toolCalls: [
        {
          args: { text: 'Ping', to: 'biology', wait: true },
          durationS: null,
          name: 'message_bot',
          occurrenceId: 'occ-bio-2',
          result: { details: { reply: 'OK', section_id: 'th-bio' } },
          startedAt: 600,
          status: 'ok',
          summary: 'biology',
          toolId: 'call_0'
        }
      ],
      turnId: 'T6'
    }

    const identicalSettled = mergeThreadMessages(
      [identicalBio1, identicalBio2Running],
      [identicalBio2Complete]
    )

    expect(identicalSettled.find(m => m.id === 'a3')?.toolCalls[0]?.status).toBe('ok')
    expect(asksOf(identicalSettled.flatMap(m => m.toolCalls))).toEqual([
      { sectionId: 'th-bio', sent: false, status: 'ok', target: 'biology' }
    ])

    // Same-fragment call_0 asks with different wait/text or targets stay distinct across merge.
    const storedWaitFalse: Message = {
      attachments: [],
      createdAt: 0,
      fragmentIds: ['a1'],
      id: 'a1',
      role: 'assistant',
      streaming: false,
      text: '',
      toolCalls: [
        {
          args: { text: 'FYI', to: 'writer', wait: false },
          durationS: null,
          messageId: 'a1',
          name: 'message_bot',
          result: { status: 'sent', section_id: 'th-w' },
          startedAt: 0,
          status: 'ok',
          summary: 'writer',
          toolId: 'call_0'
        }
      ],
      turnId: 'T7'
    }

    const liveWaitTrue: Message = {
      attachments: [],
      createdAt: 50,
      fragmentIds: ['a1'],
      id: 'live-a1',
      role: 'assistant',
      streaming: true,
      text: '',
      toolCalls: [
        {
          args: { text: 'Need reply', to: 'writer', wait: true },
          durationS: null,
          messageId: 'a1',
          name: 'message_bot',
          result: null,
          startedAt: 50,
          status: 'running',
          summary: 'writer',
          toolId: 'call_0'
        }
      ],
      turnId: 'T7'
    }

    const mergedDistinctWait = mergeThreadMessages([storedWaitFalse], [liveWaitTrue])

    expect(mergedDistinctWait.flatMap(m => m.toolCalls)).toHaveLength(2)
    expect(asksOf(mergedDistinctWait.flatMap(m => m.toolCalls))).toEqual([
      { sectionId: 'th-w', sent: false, status: 'running', target: 'writer' }
    ])

    // Two hydrated same-fragment asks (Biology + Chemistry) merged with live Chemistry-only
    // keep Biology intact instead of overwriting it with Chemistry.
    const storedPar: Message = {
      attachments: [],
      createdAt: 0,
      fragmentIds: ['a1'],
      id: 'a1-par',
      role: 'assistant',
      streaming: false,
      text: '',
      toolCalls: [
        {
          args: { text: 'Q1', to: 'biology', wait: true },
          durationS: null,
          messageId: 'a1',
          name: 'message_bot',
          result: null,
          startedAt: 0,
          status: 'running',
          summary: 'biology',
          toolId: 'call_0'
        },
        {
          args: { text: 'Q2', to: 'chemistry', wait: true },
          durationS: null,
          messageId: 'a1',
          name: 'message_bot',
          result: null,
          startedAt: 0,
          status: 'running',
          summary: 'chemistry',
          toolId: 'call_0'
        }
      ],
      turnId: 'T8'
    }

    const liveChemOnly: Message = {
      attachments: [],
      createdAt: 60,
      fragmentIds: ['a1'],
      id: 'live-par',
      role: 'assistant',
      streaming: true,
      text: '',
      toolCalls: [
        {
          args: { text: 'Q2', to: 'chemistry', wait: true },
          durationS: null,
          messageId: 'a1',
          name: 'message_bot',
          result: null,
          startedAt: 60,
          status: 'running',
          summary: 'chemistry',
          toolId: 'call_0'
        }
      ],
      turnId: 'T8'
    }

    const mergedPar = mergeThreadMessages([storedPar], [liveChemOnly])

    expect(
      mergedPar.flatMap(m => m.toolCalls).map(call => (call.args as { to?: string } | null)?.to)
    ).toEqual(['biology', 'chemistry'])
  })

  it('keeps distinct same-fragment call_0 asks when grouping multiple fragments in one turn', async () => {
    useBots.setState({
      byName: {
        biology: bot('biology', 'Biology'),
        scout: bot('scout', 'Scout'),
        writer: bot('writer', 'Writer')
      }
    })
    rpc({
      'hexbot.sections.open': () => ({
        busy: true,
        messages: [
          { role: 'user', display_kind: 'hidden', text: '@scout: Check both' },
          {
            role: 'assistant',
            row_id: 'a1',
            turn_id: 'T-group',
            text: 'Part one.',
            tool_calls: [
              {
                id: 'call_0',
                function: { name: 'message_bot', arguments: '{"to":"biology","text":"Q1","wait":true}' }
              },
              {
                id: 'call_0',
                function: { name: 'message_bot', arguments: '{"to":"writer","text":"Q2","wait":true}' }
              }
            ]
          },
          {
            role: 'tool',
            row_id: 't1',
            turn_id: 'T-group',
            message_id: 'a1',
            tool_call_id: 'call_0',
            name: 'message_bot',
            context: 'writer',
            is_error: true,
            args: { to: 'writer', text: 'Q2', wait: true },
            text: '{"error":"failed"}'
          },
          {
            role: 'assistant',
            row_id: 'a2',
            turn_id: 'T-group',
            text: 'Part two.'
          }
        ],
        section: thread
      })
    })

    render(<ThreadView thread={{ bot: 'writer', peer: 'scout', sectionId: 'th1' }} />)
    await screen.findByText('Part two.')
    expect(screen.getByText('Messaging')).toBeInTheDocument()
    expect(screen.getByText('Asked')).toBeInTheDocument()
  })

  it('merges a settled stored nested codemode ask over a stale running live copy without messageId', () => {
    const stored: Message[] = [
      {
        attachments: [],
        createdAt: 0,
        fragmentIds: ['a-code'],
        id: 'm-stored',
        role: 'assistant',
        streaming: false,
        text: '',
        toolCalls: [
          {
            args: { to: 'fox', text: 'Nested question', wait: true },
            durationS: null,
            messageId: 'a-code',
            name: 'message_bot',
            parentToolCallId: 'code',
            result: { reply: 'Fox replied.', section_id: 'th-fox' },
            startedAt: 0,
            status: 'ok',
            summary: 'fox',
            toolId: 'code/1'
          }
        ],
        turnId: 'T-nested-merge'
      }
    ]

    // Case 1: overlapping fragment IDs (`mergeToolCalls`).
    const liveSameFrag: Message[] = [
      {
        attachments: [],
        createdAt: 0,
        fragmentIds: ['a-code'],
        id: 'm-live-1',
        role: 'assistant',
        streaming: true,
        text: '',
        toolCalls: [
          {
            args: { to: 'fox', text: 'Nested question', wait: true },
            durationS: null,
            name: 'message_bot',
            parentToolCallId: 'code',
            result: null,
            startedAt: 1,
            status: 'running',
            summary: 'fox',
            toolId: 'code/1'
          }
        ],
        turnId: 'T-nested-merge'
      }
    ]

    const mergedOverlap = mergeThreadMessages(stored, liveSameFrag)
    expect(mergedOverlap.flatMap(m => m.toolCalls).map(c => c.status)).toEqual(['ok'])

    // Case 2: live nested ask on a streaming bubble without overlapping fragmentIds (`reconcileRunningStoredAsks`).
    const liveSeparate: Message[] = [
      {
        attachments: [],
        createdAt: 0,
        id: 'm-live-2',
        role: 'assistant',
        streaming: true,
        text: 'Continuing...',
        toolCalls: [
          {
            args: { to: 'fox', text: 'Nested question', wait: true },
            durationS: null,
            name: 'message_bot',
            parentToolCallId: 'code',
            result: null,
            startedAt: 1,
            status: 'running',
            summary: 'fox',
            toolId: 'code/1'
          }
        ],
        turnId: 'T-nested-merge'
      }
    ]

    const mergedSeparate = mergeThreadMessages(stored, liveSeparate)
    expect(mergedSeparate.flatMap(m => m.toolCalls).map(c => c.status)).toEqual(['ok'])

    // Case 3: a second `codemode` invocation in the same turn with a distinct parent occurrenceId
    // repeating the exact same nested question must keep BOTH parents and BOTH children.
    const storedFirstParent: Message[] = [
      {
        attachments: [],
        createdAt: 0,
        fragmentIds: ['a1'],
        id: 'm-p1',
        role: 'assistant',
        streaming: false,
        text: '',
        toolCalls: [
          {
            args: { code: '1' },
            durationS: 1,
            messageId: 'a1',
            name: 'codemode',
            occurrenceId: 'p1',
            result: 'ok',
            startedAt: 0,
            status: 'ok',
            toolId: 'call_0'
          },
          {
            args: { to: 'fox', text: 'Same question', wait: true },
            durationS: null,
            messageId: 'a1',
            name: 'message_bot',
            parentToolCallId: 'call_0',
            result: { reply: 'First reply', section_id: 'th-fox' },
            startedAt: 0,
            status: 'ok',
            summary: 'fox',
            toolId: 'call_0/1'
          }
        ],
        turnId: 'T-repeat-code'
      }
    ]

    const liveSecondParent: Message[] = [
      {
        attachments: [],
        createdAt: 0,
        fragmentIds: ['a2'],
        id: 'm-p2',
        role: 'assistant',
        streaming: true,
        text: '',
        toolCalls: [
          {
            args: { code: '2' },
            durationS: null,
            messageId: 'a2',
            name: 'codemode',
            occurrenceId: 'p2',
            result: null,
            startedAt: 2,
            status: 'running',
            toolId: 'call_0'
          },
          {
            args: { to: 'fox', text: 'Same question', wait: true },
            durationS: null,
            name: 'message_bot',
            parentToolCallId: 'call_0',
            result: null,
            startedAt: 2,
            status: 'running',
            summary: 'fox',
            toolId: 'call_0/1'
          }
        ],
        turnId: 'T-repeat-code'
      }
    ]

    const mergedRepeat = mergeThreadMessages(storedFirstParent, liveSecondParent)
    expect(
      mergedRepeat
        .flatMap(m => m.toolCalls)
        .filter(c => c.name === 'message_bot')
        .map(c => c.status)
    ).toEqual(['ok', 'running'])

    // Same-bubble repeated codemode runs reusing call_0 + call_0/1 keep the second running ask
    // even when both parent calls share one live bubble (with or without occurrence IDs).
    const sameBubbleLive: Message[] = [
      {
        attachments: [],
        createdAt: 0,
        fragmentIds: ['a1', 'a2'],
        id: 'live-both-parents',
        role: 'assistant',
        streaming: true,
        text: '',
        toolCalls: [
          {
            args: { code: '1' },
            durationS: null,
            messageId: 'a1',
            name: 'codemode',
            occurrenceId: 'p1',
            result: 'ok',
            startedAt: 1,
            status: 'ok',
            toolId: 'call_0'
          },
          {
            args: { to: 'fox', text: 'Same question', wait: true },
            durationS: null,
            messageId: 'a1',
            name: 'message_bot',
            parentOccurrenceId: 'p1',
            parentToolCallId: 'call_0',
            result: { reply: 'First reply', section_id: 'th-fox' },
            startedAt: 1,
            status: 'ok',
            summary: 'fox',
            toolId: 'call_0/1'
          },
          {
            args: { code: '2' },
            durationS: null,
            name: 'codemode',
            occurrenceId: 'p2',
            result: null,
            startedAt: 2,
            status: 'running',
            toolId: 'call_0'
          },
          {
            args: { to: 'fox', text: 'Same question', wait: true },
            durationS: null,
            name: 'message_bot',
            parentOccurrenceId: 'p2',
            parentToolCallId: 'call_0',
            result: null,
            startedAt: 2,
            status: 'running',
            summary: 'fox',
            toolId: 'call_0/1'
          }
        ],
        turnId: 'T-repeat-code'
      }
    ]

    const mergedSameBubble = mergeThreadMessages(storedFirstParent, sameBubbleLive)
    expect(
      mergedSameBubble
        .flatMap(m => m.toolCalls)
        .filter(c => c.name === 'message_bot')
        .map(c => c.status)
    ).toEqual(['ok', 'running'])

    // Also verify when occurrenceId/parentOccurrenceId and the first live child are omitted.
    const untaggedSameBubble: Message[] = [
      {
        ...sameBubbleLive[0]!,
        toolCalls: [
          {
            args: { code: '1' },
            durationS: null,
            messageId: 'a1',
            name: 'codemode',
            result: 'ok',
            startedAt: 1,
            status: 'ok',
            toolId: 'call_0'
          },
          {
            args: { code: '2' },
            durationS: null,
            name: 'codemode',
            result: null,
            startedAt: 2,
            status: 'running',
            toolId: 'call_0'
          },
          {
            args: { to: 'fox', text: 'Same question', wait: true },
            durationS: null,
            name: 'message_bot',
            parentToolCallId: 'call_0',
            result: null,
            startedAt: 2,
            status: 'running',
            summary: 'fox',
            toolId: 'call_0/1'
          }
        ]
      }
    ]

    const mergedUntaggedSameBubble = mergeThreadMessages(storedFirstParent, untaggedSameBubble)
    expect(
      mergedUntaggedSameBubble
        .flatMap(m => m.toolCalls)
        .filter(c => c.name === 'message_bot')
        .map(c => c.status)
    ).toEqual(['ok', 'running'])

    // Distinct parentOccurrenceId on reused codemode call IDs prevents settled-live
    // reconciliation from settling a different parent's still-running nested ask,
    // and prevents an earlier persisted parent from falsely confirming a later live parent.
    const storedRunningSecondParent: Message[] = [
      {
        attachments: [],
        createdAt: 0,
        id: 'm-p2-running',
        role: 'assistant',
        streaming: false,
        text: '',
        toolCalls: [
          {
            args: { text: 'Same question', to: 'fox', wait: true },
            durationS: null,
            name: 'message_bot',
            parentOccurrenceId: 'occ-p2',
            parentToolCallId: 'call_0',
            result: null,
            startedAt: 0,
            status: 'running',
            summary: 'fox',
            toolId: 'call_0/1'
          }
        ],
        turnId: 'T-po'
      }
    ]

    const liveFailedFirstParent: Message[] = [
      {
        attachments: [],
        createdAt: 1,
        id: 'live-p1-err',
        role: 'assistant',
        streaming: false,
        text: '',
        toolCalls: [
          {
            args: { text: 'Same question', to: 'fox', wait: true },
            durationS: null,
            name: 'message_bot',
            parentOccurrenceId: 'occ-p1',
            parentToolCallId: 'call_0',
            result: { error: 'first failed' },
            startedAt: 1,
            status: 'error',
            summary: 'fox',
            toolId: 'call_0/1'
          }
        ],
        turnId: 'T-po'
      }
    ]

    const mergedCrossParentError = mergeThreadMessages(
      storedRunningSecondParent,
      liveFailedFirstParent
    )

    expect(
      mergedCrossParentError
        .flatMap(m => m.toolCalls)
        .map(c => [c.parentOccurrenceId, c.status])
    ).toEqual([
      ['occ-p2', 'running'],
      ['occ-p1', 'error']
    ])

    const storedOkFirstParent: Message[] = [
      {
        attachments: [],
        createdAt: 0,
        id: 'm-p1-ok',
        role: 'assistant',
        streaming: false,
        text: '',
        toolCalls: [
          {
            args: { text: 'Same question', to: 'fox', wait: true },
            durationS: null,
            name: 'message_bot',
            parentOccurrenceId: 'occ-p1',
            parentToolCallId: 'call_0',
            result: { section_id: 'th-fox' },
            startedAt: 0,
            status: 'ok',
            summary: 'fox',
            toolId: 'call_0/1'
          }
        ],
        turnId: 'T-po'
      }
    ]

    const liveOkSecondParent: Message[] = [
      {
        attachments: [],
        createdAt: 2,
        id: 'live-p2-ok',
        role: 'assistant',
        streaming: false,
        text: '',
        toolCalls: [
          {
            args: { text: 'Same question', to: 'fox', wait: true },
            durationS: null,
            name: 'message_bot',
            parentOccurrenceId: 'occ-p2',
            parentToolCallId: 'call_0',
            result: { section_id: 'th-fox' },
            startedAt: 2,
            status: 'ok',
            summary: 'fox',
            toolId: 'call_0/1'
          }
        ],
        turnId: 'T-po'
      }
    ]

    const mergedCrossParentConfirm = mergeThreadMessages(storedOkFirstParent, liveOkSecondParent)
    expect(
      mergedCrossParentConfirm
        .flatMap(m => m.toolCalls)
        .map(c => [c.parentOccurrenceId, c.status])
    ).toEqual([
      ['occ-p1', 'ok'],
      ['occ-p2', 'ok']
    ])
  })

  it('closes from Close Chat and from Escape', async () => {
    rpc({ 'hexbot.sections.open': () => ({ messages: history, section: thread }) })
    render(<ThreadView thread={{ bot: 'writer', peer: 'scout', sectionId: 'th1' }} />)
    await screen.findByText('Can you draft the intro?')
    fireEvent.click(screen.getByRole('button', { name: 'Close Chat' }))
    expect(useUi.getState().thread).toBeNull()
    useUi.setState({ thread: { bot: 'writer', peer: 'scout', sectionId: 'th1' } })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(useUi.getState().thread).toBeNull()
  })
})

describe('touchThread', () => {
  it('reads an open thread again only for its own changes, or any while its id is unknown', () => {
    useUi.setState({ thread: { bot: 'writer', peer: 'scout' }, threadChanged: 0 })
    useUi.getState().touchThread('elsewhere')
    expect(useUi.getState().threadChanged).toBe(1)
    useUi.setState({ thread: { bot: 'writer', peer: 'scout', sectionId: 'th1' } })
    useUi.getState().touchThread('elsewhere')
    expect(useUi.getState().threadChanged).toBe(1)
    useUi.getState().touchThread('th1')
    expect(useUi.getState().threadChanged).toBe(2)
    useUi.setState({ peerRoute: null, thread: null })
    useUi.getState().touchThread('th1')
    expect(useUi.getState().threadChanged).toBe(2)
    // A direct peer URL also refreshes on section-change events for its section.
    useUi.setState({ peerRoute: 'th-direct', thread: null })
    useUi.getState().touchThread('elsewhere')
    expect(useUi.getState().threadChanged).toBe(2)
    useUi.getState().touchThread('th-direct')
    expect(useUi.getState().threadChanged).toBe(3)
    useUi.setState({ peerRoute: null })
  })
})
