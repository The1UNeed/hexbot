import { act, render, screen } from '@testing-library/react'

import { ConversationColumn } from '../app/conversation'
import { useBots } from '../stores/bots'
vi.mock('@tanstack/react-router', () => {
  const router = {
    matchRoutes: () => [{ params: { bot: 'owl', section: 'chat' } }],
    history: { location: {}, subscribe: () => () => {} },
    subscribe: () => () => {}
  }

  const navigate = vi.fn()

  return {
    useRouter: () => router,
    useNavigate: () => navigate,
    useParams: () => ({ bot: 'owl', section: 'chat' })
  }
})
import type { GatewayEvent } from '@hermes/shared'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { useConnection } from '../stores/connection'
import { useSections } from '../stores/sections'
import { resetTranscriptEffects, setTranscriptEffects, useTranscripts } from '../stores/transcripts'

import { routeEvent } from './events'
import { setActiveRpc } from './rpc'
import type { DaemonInfo, Section } from './types'

const section = {
  id: 'chat',
  bot: 'owl',
  live_session_id: 'chat',
  title: 'Trip',
  peer_bot: null,
  message_count: 2
} as Section

const prior = [
  { role: 'user', row_id: 'old-user', text: 'Earlier question' },
  { role: 'assistant', row_id: 'old-answer', text: 'Earlier answer' }
]

const report = { role: 'assistant', row_id: 'report', text: 'Dream report', dream: true }
const turn = 'actual-run'

const user = {
  role: 'user',
  row_id: 'user-one',
  text: 'Show the chart',
  turn_id: turn,
  input_id: undefined as string | undefined
}

const first = {
  role: 'assistant',
  row_id: 'fragment-a',
  text: 'I will show the chart.',
  turn_id: turn,
  tool_calls: [
    {
      id: 'chart-tool',
      type: 'function',
      function: {
        name: 'hexbot_show_html',
        arguments: JSON.stringify({ html: '<p>chart</p>', title: 'Chart' })
      }
    }
  ]
}

const result = {
  role: 'tool',
  row_id: 'result-row',
  tool_id: 'chart-tool',
  tool_call_id: 'chart-tool',
  name: 'hexbot_show_html',
  text: 'Shown',
  turn_id: turn
}

const second = {
  role: 'assistant',
  row_id: 'fragment-b',
  text: 'Answer after queued input',
  turn_id: turn
}

const snap = (messages: unknown[] = prior) => ({ section, messages })

const deps = { refreshBots: () => {}, refreshSections: () => {} }

const event = (type: string, payload: Record<string, unknown> = {}) =>
  routeEvent(
    { type, session_id: 'chat', payload: { turn_id: turn, ...payload } } as GatewayEvent,
    deps
  )

const state = () => JSON.parse(JSON.stringify(useTranscripts.getState().bySession.chat))

let call: ReturnType<typeof vi.fn>
beforeEach(async () => {
  Element.prototype.scrollIntoView = vi.fn()
  useBots.setState({ byName: { owl: { name: 'owl', display_name: 'Owl' } as never }, loaded: true })
  useConnection.setState({
    target: { kind: 'local' },
    epoch: 'fragment-epoch',
    daemon: { one_chat: true, transcript_identity: true } as DaemonInfo
  })
  useSections.setState({
    byId: { chat: section },
    idsByBot: { owl: ['chat'] },
    liveSessionId: {},
    choosing: null
  })
  useTranscripts.setState({ bySession: {} })
  setTranscriptEffects({ touchSection: () => {}, notify: () => {}, ackApproval: () => {} })
  call = vi.fn((method: string) =>
    Promise.resolve(
      method === 'hexbot.sections.open'
        ? snap()
        : method === 'hexbot.sections.create'
          ? { section }
          : method === 'hexbot.sections.list'
            ? { sections: [section] }
            : { connectors: [] }
    )
  )
  setActiveRpc({ call } as never)
  await useSections.getState().open('chat')
  user.input_id = useTranscripts.getState().appendUserMessage('chat', user.text).inputId
})
afterEach(() => {
  setActiveRpc(null)
  resetTranscriptEffects()
})

it.each([
  [false, true, false],
  [true, true, false],
  [false, false, false],
  [true, false, false],
  [false, true, true],
  [true, true, true]
])(
  'retains each visual and nested occurrence through hydration, report=%s collision=%s cards=%s',
  async (interposed, collision, cards) => {
    const topId = 'outer/1',
      parentId = 'outer',
      childId = collision ? topId : 'unrelated-child'

    const top = { ...first, tool_calls: [{ ...first.tool_calls[0], id: topId }] }
    const topResult = { ...result, tool_id: topId, tool_call_id: topId }

    const parent = {
      ...second,
      tool_calls: [
        {
          id: parentId,
          type: 'function',
          function: {
            name: 'codemode',
            arguments: JSON.stringify({ code: "text(await tools.memory({action:'read'}));" })
          }
        }
      ]
    }

    const parentResult = {
      role: 'tool',
      row_id: 'parent-result',
      tool_id: parentId,
      tool_call_id: parentId,
      name: 'codemode',
      text: 'Nested memory',
      turn_id: turn,
      nested_calls: {
        calls: [
          {
            id: childId,
            name: 'memory',
            status: 'ok',
            arguments: { action: 'read' },
            durationMs: 20
          }
        ]
      }
    }

    const final = { role: 'assistant', row_id: 'fragment-c', text: 'Done', turn_id: turn }
    const rendered = render(<ConversationColumn />)
    await screen.findByText('Earlier question')

    const shown = () => ({
      frames: screen.queryAllByTestId('visual').map(frame => frame.getAttribute('title')),
      state: state(),
      html: rendered.container.innerHTML
    })

    await act(async () => {
      event('message.start')
      event('reasoning.delta', { message_id: first.row_id, text: 'Chart reasoning' })
      event('message.delta', { message_id: first.row_id, text: first.text })
      event('message.interim', {
        message_id: first.row_id,
        text: first.text,
        already_streamed: true
      })
      event('tool.start', {
        message_id: first.row_id,
        tool_id: topId,
        name: 'hexbot_show_html',
        args: { html: '<p>chart</p>', title: 'Chart' }
      })
      event('tool.complete', {
        message_id: first.row_id,
        tool_id: topId,
        result_text: 'Shown',
        duration_s: 0.01
      })
    })
    const initial = shown()

    if (interposed) {
      call.mockResolvedValue(snap([...prior, user, top, topResult, report]))
      await act(async () => {
        await useSections.getState().open('chat')
      })
    }

    await act(async () => {
      event('reasoning.delta', { message_id: second.row_id, text: 'Memory reasoning' })
      event('message.delta', { message_id: second.row_id, text: second.text })
      event('message.interim', {
        message_id: second.row_id,
        text: second.text,
        already_streamed: true
      })
      event('tool.start', {
        message_id: second.row_id,
        tool_id: parentId,
        name: 'codemode',
        args: { code: "text(await tools.memory({action:'read'}));" }
      })
      // Safe producer omission: the nested occurrence is identified by parent, not assigned A's message_id.
      event('tool.start', {
        tool_id: childId,
        parent_tool_call_id: parentId,
        name: 'memory',
        args: { action: 'read' }
      })
      event('tool.complete', {
        tool_id: childId,
        parent_tool_call_id: parentId,
        name: 'memory',
        args: { action: 'read' },
        result_text: 'Nested memory',
        duration_s: 0.02
      })
    })
    const afterNested = shown()
    await act(async () => {
      event('tool.complete', {
        message_id: second.row_id,
        tool_id: parentId,
        name: 'codemode',
        result_text: 'Nested memory'
      })

      if (cards) {
        event('clarify.request', {
          message_id: second.row_id,
          request_id: 'question',
          question: 'Keep this memory?',
          choices: ['Yes', 'No']
        })
        event('approval.request', {
          message_id: second.row_id,
          request_id: 'approval',
          command: 'Inspect memory',
          choices: ['once', 'deny']
        })
      }

      event('message.delta', { message_id: final.row_id, text: final.text })
    })

    const rows = [
      ...prior,
      user,
      top,
      topResult,
      ...(interposed ? [report] : []),
      parent,
      parentResult,
      final
    ]

    call.mockResolvedValue(snap(rows))
    await act(async () => {
      event('message.complete', { message_id: final.row_id, text: final.text })
      await useSections.getState().open('chat')
    })
    const terminal = shown()
    await act(async () => {
      await useSections.getState().open('chat')
    })
    const reopened = shown()
    expect.soft(initial.frames).toEqual(['Chart'])
    expect.soft(afterNested.frames).toEqual(['Chart'])
    expect.soft(terminal.frames).toEqual(['Chart'])
    expect.soft(reopened.frames).toEqual(['Chart'])

    for (const snapshot of [afterNested, terminal, reopened]) {
      const tools = snapshot.state.messages.flatMap(
        (m: {
          toolCalls: {
            toolId: string
            name: string
            args: unknown
            messageId?: string
            parentToolCallId?: string
          }[]
        }) => m.toolCalls
      )

      expect
        .soft(tools.filter((t: { name: string }) => t.name === 'hexbot_show_html'))
        .toMatchObject([
          { toolId: topId, messageId: first.row_id, args: { html: '<p>chart</p>', title: 'Chart' } }
        ])
    }

    for (const snapshot of [afterNested, terminal, reopened]) {
      const tools = snapshot.state.messages.flatMap((m: { toolCalls: unknown[] }) => m.toolCalls)
      expect(tools).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ toolId: parentId, messageId: second.row_id, name: 'codemode' }),
          expect.objectContaining({
            toolId: childId,
            parentToolCallId: parentId,
            messageId: second.row_id,
            name: 'memory',
            args: { action: 'read' },
            status: 'ok'
          })
        ])
      )
      expect(tools).toHaveLength(3)
    }

    const text = (snapshot: typeof terminal) =>
      snapshot.state.messages
        .flatMap((m: { parts?: string[]; text: string }) => [...(m.parts ?? []), m.text])
        .filter(Boolean)

    expect(text(terminal)).toEqual([
      ...prior.map(row => row.text),
      user.text,
      first.text,
      ...(interposed ? [report.text] : []),
      second.text,
      final.text
    ])
    expect(text(reopened)).toEqual(text(terminal))

    for (const snapshot of [afterNested, terminal, reopened]) {
      const reasoning = Object.assign(
        {},
        ...snapshot.state.messages.map(
          (m: { thinkingByFragment?: Record<string, string> }) => m.thinkingByFragment
        )
      )

      expect(reasoning).toEqual({
        [first.row_id]: 'Chart reasoning',
        [second.row_id]: 'Memory reasoning'
      })
    }

    if (cards) {
      for (const snapshot of [terminal, reopened]) {
        expect(snapshot.state.clarifies).toMatchObject([
          { requestId: 'question', messageId: second.row_id }
        ])
        expect(snapshot.state.approvals).toMatchObject([
          { requestId: 'approval', messageId: second.row_id }
        ])
        const labels = [second.text, 'Keep this memory?', 'Inspect memory', final.text]
        const positions = labels.map(label => snapshot.html.indexOf(label))
        expect(positions.every(position => position >= 0)).toBe(true)
        expect(positions).toEqual([...positions].sort((a, b) => a - b))
      }
    }

    rendered.unmount()
  }
)
