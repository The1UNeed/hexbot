import { writeFileSync } from 'node:fs'

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

const queued = { role: 'user', row_id: 'user-two', text: 'Second queued question', turn_id: turn }
const snap = (messages: unknown[] = prior) => ({ section, messages })

const deferred = () => {
  let resolve!: (value: unknown) => void

  const promise = new Promise(yes => {
    resolve = yes
  })

  return { promise, resolve }
}

const deps = { refreshBots: () => {}, refreshSections: () => {} }

const event = (type: string, payload: Record<string, unknown> = {}) =>
  routeEvent(
    { type, session_id: 'chat', payload: { turn_id: turn, ...payload } } as GatewayEvent,
    deps
  )

const words = () =>
  useTranscripts
    .getState()
    .bySession.chat!.messages.flatMap(m => [...(m.parts ?? []), m.text])
    .filter(Boolean)

const state = () => JSON.parse(JSON.stringify(useTranscripts.getState().bySession.chat))

const save = (name: string, value: unknown) => {
  if (process.env.HEXBOT_PROBE_EVIDENCE) {
    writeFileSync(
      `${process.env.HEXBOT_PROBE_EVIDENCE}/permanent-rendered-${name}.json`,
      JSON.stringify(value, null, 2) + '\n'
    )
  }
}

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

function start() {
  event('message.start')
  event('message.delta', { message_id: first.row_id, text: first.text })
  event('message.interim', { message_id: first.row_id, text: first.text, already_streamed: true })
  event('tool.start', {
    message_id: first.row_id,
    tool_id: 'chart-tool',
    name: 'hexbot_show_html',
    args: { html: '<p>chart</p>', title: 'Chart' }
  })
}

it.each([false, true])(
  'shows an identified tool once when report interposes its result=%s',
  async interposed => {
    const rendered = render(<ConversationColumn />)
    await screen.findByText('Earlier question')
    await act(async () => {
      start()
    })

    const rows = interposed
      ? [...prior, user, first, report, result]
      : [...prior, user, report, first, result]

    const held = deferred()
    let reads = 0
    call.mockImplementation(() =>
      ++reads === 1 ? held.promise : Promise.resolve(snap([...rows, second]))
    )
    const loading = useSections.getState().open('chat')
    await act(async () => {
      event('tool.complete', {
        message_id: first.row_id,
        tool_id: 'chart-tool',
        result_text: 'Shown'
      })
      event('message.delta', { message_id: second.row_id, text: second.text })
      held.resolve(snap(rows))
      await loading
    })
    const active = state()
    save(`rendered-tool-report-${interposed}`, {
      visuals: screen.queryAllByTestId('visual').map(frame => frame.getAttribute('title')),
      text: rendered.container.textContent,
      html: rendered.container.innerHTML
    })
    expect.soft(screen.queryAllByTestId('visual')).toHaveLength(1)
    rendered.unmount()
    event('message.complete', { message_id: second.row_id, text: second.text })
    await useSections.getState().open('chat')
    const terminal = state()
    save(`tool-report-${interposed}`, { active, terminal, reads })
    expect
      .soft(
        active.messages.flatMap((m: { toolCalls: { toolId: string }[] }) =>
          m.toolCalls.map(t => t.toolId)
        )
      )
      .toEqual(['chart-tool'])
    expect
      .soft(
        terminal.messages.flatMap((m: { toolCalls: { toolId: string }[] }) =>
          m.toolCalls.map(t => t.toolId)
        )
      )
      .toEqual(['chart-tool'])
  }
)

it.each([false, true])(
  'keeps a new identified interim after the queued user without a card, queued=%s',
  async hasQueued => {
    const rendered = render(<ConversationColumn />)
    await screen.findByText('Earlier question')
    await act(async () => {
      start()
    })
    const rows = [...prior, user, report, first, result, ...(hasQueued ? [queued] : [])]
    const held = deferred()
    let reads = 0
    call.mockImplementation(() =>
      ++reads === 1 ? held.promise : Promise.resolve(snap([...rows, second]))
    )
    const loading = useSections.getState().open('chat')
    await act(async () => {
      event('tool.complete', {
        message_id: first.row_id,
        tool_id: 'chart-tool',
        result_text: 'Shown'
      })
      event('message.delta', { message_id: second.row_id, text: second.text })
      event('message.interim', {
        message_id: second.row_id,
        text: second.text,
        already_streamed: true
      })
      held.resolve(snap(rows))
      await loading
    })
    const active = state()
    const activeWords = words()

    const renderedWords = [...rendered.container.querySelectorAll('.hex-prose')].map(
      el => el.textContent
    )

    save(`rendered-queued-no-card-${hasQueued}`, {
      renderedWords,
      html: rendered.container.innerHTML
    })
    rendered.unmount()
    event('message.complete', { message_id: second.row_id, text: second.text })
    await useSections.getState().open('chat')
    const terminal = state()
    const terminalWords = words()
    save(`queued-no-card-${hasQueued}`, { active, activeWords, terminal, terminalWords, reads })

    const expected = [
      ...prior.map(m => m.text),
      user.text,
      report.text,
      first.text,
      ...(hasQueued ? [queued.text] : []),
      second.text
    ]

    expect.soft(activeWords).toEqual(expected)
    expect.soft(renderedWords).toEqual(expected)
    expect.soft(terminalWords).toEqual(expected)
  }
)
