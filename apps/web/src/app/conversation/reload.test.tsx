import type { GatewayEvent } from '@hermes/shared'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { promptSubmit } from '../../lib/api'
import { routeEvent } from '../../lib/events'
import { setActiveRpc } from '../../lib/rpc'
import type { Bot, DaemonInfo, Section } from '../../lib/types'
import { useBots } from '../../stores/bots'
import { useConnection } from '../../stores/connection'
import { useSections } from '../../stores/sections'
import {
  resetTranscriptEffects,
  setTranscriptEffects,
  useTranscripts
} from '../../stores/transcripts'

import { ConversationColumn } from './index'

const navigate = vi.fn()
vi.mock('@tanstack/react-router', () => {
  const router = {
    matchRoutes: () => [{ params: { bot: 'owl', section: 'chat' } }],
    history: { location: {}, subscribe: () => () => {} },
    subscribe: () => () => {}
  }

  return {
    useRouter: () => router,
    useNavigate: () => navigate,
    useParams: () => ({ bot: 'owl', section: 'chat' })
  }
})

const section = {
  id: 'chat',
  bot: 'owl',
  title: 'Trip',
  live_session_id: 'chat',
  archived_at: null,
  message_count: 3,
  peer_bot: null
} as Section

const history = (texts: string[]) => ({
  section,
  messages: texts.map((text, row_id) => ({ role: 'assistant', row_id, text }))
})

const deferred = () => {
  let resolve!: (value: unknown) => void
  let reject!: (error: Error) => void

  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })

  return { promise, resolve, reject }
}

const reload = () =>
  routeEvent(
    {
      type: 'hexbot.sections.changed',
      payload: { bot: 'owl', id: 'chat', reload: true }
    } as GatewayEvent,
    { refreshBots: () => undefined, refreshSections: () => undefined }
  )

let call: ReturnType<typeof vi.fn>
let texts: string[]

const reply = (method: string) =>
  Promise.resolve(
    method === 'hexbot.sections.open'
      ? history(texts)
      : method === 'hexbot.sections.list'
        ? { sections: [section] }
        : method === 'hexbot.sections.create'
          ? { section }
          : { connectors: [] }
  )

const opens = () => call.mock.calls.filter(([method]) => method === 'hexbot.sections.open')
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  useConnection.setState({
    target: { kind: 'local' },
    epoch: 'first',
    daemon: { one_chat: true, transcript_identity: true } as DaemonInfo
  })
  useBots.setState({ byName: { owl: { name: 'owl', display_name: 'Owl' } as Bot }, loaded: true })
  useSections.setState({
    byId: { chat: section },
    idsByBot: { owl: ['chat'] },
    liveSessionId: {},
    choosing: null
  })
  useTranscripts.setState({ bySession: {} })
  setTranscriptEffects({ touchSection: () => {}, notify: () => {}, ackApproval: () => {} })
  texts = ['Previous conversation']
  call = vi.fn(reply)
  setActiveRpc({ call } as never)
})
afterEach(() => {
  setActiveRpc(null)
  resetTranscriptEffects()
})

it.each([false, true])(
  'loads the report after catalog refresh, mounted=%s, reusing the durable live ID',
  async mounted => {
    await useSections.getState().open('chat')
    const view = await act(async () => render(<ConversationColumn />))
    expect(await screen.findByText('Previous conversation')).toBeVisible()

    if (!mounted) {
      view.unmount()
    } // A room or another route is on screen when the report arrives.

    texts.push('Dream report')
    await act(async () => {
      reload()
      await useSections.getState().refresh()
      // A roster lookup must not reattach catalog metadata as loaded history either.
      await useSections.getState().chat('owl')
    })

    if (!mounted) {
      render(<ConversationColumn />)
    }

    expect(await screen.findByText('Dream report')).toBeVisible()
    expect(screen.getAllByText('Previous conversation')).toHaveLength(1)
    expect(screen.getAllByText('Dream report')).toHaveLength(1)
    // The first read, the view's own read when it opens, and the report's.
    expect(opens()).toHaveLength(3)
  }
)

it('does not treat an initial catalog live ID as loaded chat history', async () => {
  await useSections.getState().refresh()
  render(<ConversationColumn />)
  expect(await screen.findByText('Previous conversation')).toBeVisible()
  expect(opens()).toHaveLength(1)
})

it('rereads invalidated pending history before remounting without duplicating content', async () => {
  const held = deferred()
  let reads = 0
  call.mockImplementation((method: string) =>
    method === 'hexbot.sections.open' && ++reads === 2 ? held.promise : reply(method)
  )
  await useSections.getState().open('chat')
  const view = render(<ConversationColumn />)
  // Cached content is visible while the view's own read is still pending.
  expect(await screen.findByText('Previous conversation')).toBeVisible()
  await waitFor(() => expect(opens()).toHaveLength(2))
  const pendingMount = useSections.getState().open('chat')
  view.unmount()
  texts.push('Dream report')
  await act(async () => {
    reload()
    await useSections.getState().refresh()
    await useSections.getState().chat('owl')
    held.resolve(history(['Previous conversation']))
    await pendingMount
  })
  // The invalidated pending read was followed by a fresh read for the report.
  expect(opens()).toHaveLength(3)
  await act(async () => render(<ConversationColumn />))
  expect(opens()).toHaveLength(4)
  expect(screen.getAllByText('Previous conversation')).toHaveLength(1)
  expect(screen.getAllByText('Dream report')).toHaveLength(1)
})

it.each([false, true])(
  'coalesces concurrent opens and rereads multiple reloads, stale failure=%s',
  async fails => {
    const first = deferred()
    const second = deferred()
    let reads = 0
    call.mockImplementation((method: string) =>
      method !== 'hexbot.sections.open'
        ? reply(method)
        : ++reads === 1
          ? first.promise
          : reads === 2
            ? second.promise
            : reply(method)
    )
    const pending = useSections.getState().open('chat')
    void pending.catch(() => undefined)
    render(<ConversationColumn />)
    await act(async () => {
      reload()
      await useSections.getState().refresh()
    })

    if (fails) {
      first.reject(new Error('stale read failed'))
    } else {
      first.resolve(history(['Stale longer history', 'Old extra message', 'Old extra message two']))
    }

    await waitFor(() => expect(reads).toBe(2))
    await act(async () => {
      reload()
      reload()
      texts = ['Previous conversation', 'Report one', 'Report two']
      second.resolve(history(['Before the second report']))
      await pending
    })
    expect(await screen.findByText('Report two')).toBeVisible()
    expect(screen.queryByText('Stale longer history')).toBeNull()
    expect(screen.queryByText('Before the second report')).toBeNull()
    expect(screen.getAllByText('Report one')).toHaveLength(1)
    expect(reads).toBe(3)
  }
)

it('keeps invalidation after a read error and reloads on Retry after another list refresh', async () => {
  await useSections.getState().open('chat')
  reload()
  texts.push('Dream report')
  let reads = 0
  call.mockImplementation((method: string) =>
    method === 'hexbot.sections.open' && reads++ === 0
      ? Promise.reject(new Error('History unavailable'))
      : reply(method)
  )
  await useSections.getState().refresh()
  render(<ConversationColumn />)
  expect(await screen.findByRole('alert')).toHaveTextContent('History unavailable')
  await act(async () => {
    await useSections.getState().refresh()
  })
  expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(await screen.findByText('Dream report')).toBeVisible()
  expect(screen.getAllByText('Previous conversation')).toHaveLength(1)
  expect(screen.queryByRole('alert')).toBeNull()
})

it.each(['start-delta', 'delta-only', 'already-streaming', 'completed-during-read'])(
  'renders retained history, report and answer once across %s',
  async mode => {
    const event = (type: string, payload: Record<string, unknown> = {}) =>
      routeEvent({
        type,
        session_id: 'chat',
        payload: { turn_id: 'render-run', message_id: '4', ...payload }
      } as GatewayEvent)

    let inputId: string | undefined

    const rows = [
      { role: 'assistant', row_id: 1, text: 'Previous conversation' },
      {
        role: 'user',
        row_id: 2,
        text: 'Current question',
        get input_id() {
          return inputId
        },
        turn_id: 'render-run'
      },
      { role: 'assistant', row_id: 3, text: 'Dream report', dream: true }
    ]

    const answer = { role: 'assistant', row_id: 4, text: 'Final answer', turn_id: 'render-run' }
    await useSections.getState().open('chat')
    render(<ConversationColumn />)
    expect(await screen.findByText('Previous conversation')).toBeVisible()
    await act(async () => {
      inputId = useTranscripts.getState().appendUserMessage('chat', 'Current question').inputId

      if (mode === 'already-streaming') {
        event('message.start')
        event('message.delta', { text: 'Prefix before reload ' })
      }
    })
    const held = deferred()
    let reads = 0
    call.mockImplementation((method: string) =>
      method !== 'hexbot.sections.open'
        ? reply(method)
        : ++reads === 1
          ? held.promise
          : Promise.resolve({ section, messages: [...rows, answer] })
    )
    await act(async () => {
      reload()
    })
    expect(screen.getByText('Previous conversation')).toBeVisible()
    expect(screen.getByText('Current question')).toBeVisible()
    await waitFor(() => expect(reads).toBe(1))
    const loading = useSections.getState().open('chat')
    await act(async () => {
      if (mode === 'start-delta' || mode === 'completed-during-read') {
        event('message.start')
      }

      event('message.delta', { text: 'Live tail' })

      if (mode === 'completed-during-read') {
        event('message.complete', { text: answer.text })
      }

      held.resolve({ section, messages: rows })
      await loading
    })
    expect(screen.getByText('Previous conversation')).toBeVisible()
    expect(screen.getByText('Current question')).toBeVisible()
    expect(screen.getAllByText('Dream report')).toHaveLength(1)

    if (mode !== 'completed-during-read') {
      expect(screen.getByRole('status', { name: 'Owl is writing' })).toBeVisible()
      expect(useTranscripts.getState().bySession.chat!.messages.at(-1)?.text).toBe(
        mode === 'already-streaming' ? 'Prefix before reload Live tail' : 'Live tail'
      )
      await act(async () => {
        event('message.complete', { text: answer.text })
        await useSections.getState().open('chat')
      })
    }

    expect(screen.getAllByText('Final answer')).toHaveLength(1)
    expect(screen.getAllByText('Dream report')).toHaveLength(1)
    expect(reads).toBe(2)
    expect(screen.queryByRole('status', { name: 'Owl is writing' })).toBeNull()
  }
)

it('keeps pagination, equal interims and an HTML tool through hydration and the terminal reread', async () => {
  const event = (type: string, payload: Record<string, unknown> = {}) =>
    routeEvent({
      type,
      session_id: 'chat',
      payload: { turn_id: 'render-run', message_id: '70', ...payload }
    } as GatewayEvent)

  texts = Array.from({ length: 65 }, (_, index) => `Older message ${index}`)
  const old = history(texts).messages
  await useSections.getState().open('chat')
  render(<ConversationColumn />)
  expect(await screen.findByText('Older message 64')).toBeVisible()
  expect(screen.queryByText('Older message 0')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }))
  expect(screen.getByText('Older message 0')).toBeVisible()
  let inputId: string | undefined
  await act(async () => {
    inputId = useTranscripts.getState().appendUserMessage('chat', 'Current question').inputId
    event('message.start')
    event('message.interim', { text: 'Equal interim', message_id: '67' })
    event('message.interim', { text: 'Equal interim', message_id: '68' })
    event('tool.start', {
      message_id: '68',
      tool_id: 'visual-1',
      name: 'hexbot_show_html',
      args: { html: '<p>chart</p>', title: 'Costs' }
    })
  })

  const rows = [
    ...old,
    {
      role: 'user',
      row_id: 65,
      text: 'Current question',
      input_id: inputId,
      turn_id: 'render-run'
    },
    { role: 'assistant', row_id: 66, text: 'Dream report', dream: true },
    { role: 'assistant', row_id: 67, turn_id: 'render-run', text: 'Equal interim' },
    { role: 'assistant', row_id: 68, turn_id: 'render-run', text: 'Equal interim' },
    {
      role: 'tool',
      row_id: 69,
      turn_id: 'render-run',
      tool_id: 'visual-1',
      name: 'hexbot_show_html',
      text: 'Shown'
    }
  ]

  const held = deferred()
  let reads = 0
  call.mockImplementation((method: string) =>
    method !== 'hexbot.sections.open'
      ? reply(method)
      : ++reads === 1
        ? held.promise
        : Promise.resolve({
            section,
            messages: [
              ...rows,
              { role: 'assistant', row_id: 70, turn_id: 'render-run', text: 'Final answer' }
            ]
          })
  )
  await act(async () => {
    reload()
  })
  const loading = useSections.getState().open('chat')
  await act(async () => {
    event('message.delta', { text: 'Later tail' })
    event('tool.complete', { message_id: '68', tool_id: 'visual-1', result_text: 'Shown' })
    held.resolve({ section, messages: rows })
    await loading
  })
  expect(screen.getByText('Older message 0')).toBeVisible()
  expect(screen.getAllByText('Equal interim')).toHaveLength(2)
  expect(screen.getAllByTitle('Costs')).toHaveLength(1)
  expect(screen.getAllByText('Dream report')).toHaveLength(1)
  await act(async () => {
    event('message.complete', { text: 'Final answer' })
    await useSections.getState().open('chat')
  })
  expect(screen.getAllByText('Equal interim')).toHaveLength(2)
  expect(screen.getAllByTitle('Costs')).toHaveLength(1)
  expect(screen.getAllByText('Dream report')).toHaveLength(1)
  expect(screen.getAllByText('Final answer')).toHaveLength(1)
  expect(reads).toBe(2)
})

it.each([false, true])(
  'renders an unproven pending input and file separately from durable users, same text=%s',
  async same => {
    await useSections.getState().open('chat')
    render(<ConversationColumn />)
    expect(await screen.findByText('Previous conversation')).toBeVisible()
    const text = 'Own pending question'

    const file = {
      id: 'own-file',
      name: 'own-private-notes.txt',
      mime: 'text/plain',
      size: 9,
      kind: 'file' as const
    }

    const submit = deferred()
    const held = deferred()
    let localId = ''
    let entered!: () => void

    const entry = new Promise<void>(yes => {
      entered = yes
    })

    call.mockImplementation((method: string) => {
      if (method === 'prompt.submit') {
        entered()

        return submit.promise
      }

      return method === 'hexbot.sections.open' ? held.promise : reply(method)
    })
    let submitting!: ReturnType<typeof promptSubmit>
    await act(async () => {
      localId = useTranscripts.getState().appendUserMessage('chat', text, [file]).id
      submitting = promptSubmit('chat', text, { attachments: [file.id] })
      await entry
      reload()
    })
    const loading = useSections.getState().open('chat')

    const rows = [
      { role: 'assistant', row_id: 0, text: 'Previous conversation' },
      { role: 'assistant', row_id: 1, text: 'Dream report', dream: true },
      { role: 'user', row_id: 2, text: same ? text : 'Remote question' },
      { role: 'assistant', row_id: 3, text: 'Remote answer' }
    ]

    await act(async () => {
      held.resolve({ section, messages: rows })
      await loading
    })
    expect(screen.getAllByText(text)).toHaveLength(same ? 2 : 1)
    expect(screen.getAllByText(file.name)).toHaveLength(1)
    expect(screen.getAllByText('Dream report')).toHaveLength(1)
    expect(screen.getAllByText('Remote answer')).toHaveLength(1)
    expect(
      useTranscripts.getState().bySession.chat!.messages.find(m => m.id === '2')?.attachments
    ).toEqual([])
    expect(
      useTranscripts.getState().bySession.chat!.messages.find(m => m.id === localId)?.attachments
    ).toEqual([file])
    await act(async () => {
      submit.resolve({ status: 'submitted' })
      await submitting
      call.mockResolvedValue({ section, messages: rows })
      await useSections.getState().open('chat')
    })
    expect(screen.getAllByText(text)).toHaveLength(same ? 2 : 1)
    expect(screen.getAllByText(file.name)).toHaveLength(1)
    expect(
      useTranscripts.getState().bySession.chat!.messages.find(m => m.id === '2')?.attachments
    ).toEqual([])
  }
)

it.each(['loaded', 'unloaded'])(
  'renders a remote identity-equipped turn after its durable user, %s',
  async mode => {
    if (mode === 'loaded') {
      await useSections.getState().open('chat')
    }

    const held = deferred()

    const rows = [
      { role: 'assistant', row_id: 0, text: 'Previous conversation' },
      { role: 'assistant', row_id: 1, text: 'Dream report', dream: true },
      {
        role: 'user',
        row_id: 2,
        input_id: 'remote-input',
        turn_id: 'remote-run',
        text: 'Remote question'
      }
    ]

    const answer = {
      role: 'assistant',
      row_id: 'remote-answer',
      turn_id: 'remote-run',
      text: 'Remote final answer'
    }

    let reads = 0
    call.mockImplementation((method: string) =>
      method === 'hexbot.sections.open'
        ? ++reads === 1
          ? held.promise
          : Promise.resolve({ section, messages: [...rows, answer] })
        : reply(method)
    )
    render(<ConversationColumn />)
    await act(async () => {
      reload()
    })
    await waitFor(() => expect(reads).toBe(1))
    const loading = useSections.getState().open('chat')
    await act(async () => {
      routeEvent({
        type: 'message.start',
        session_id: 'chat',
        payload: { turn_id: 'remote-run' }
      } as GatewayEvent)
      routeEvent({
        type: 'message.delta',
        session_id: 'chat',
        payload: { turn_id: 'remote-run', message_id: 'remote-answer', text: answer.text }
      } as GatewayEvent)
      held.resolve({ section, messages: rows })
      await loading
    })
    expect(screen.getAllByText('Previous conversation')).toHaveLength(1)
    expect(screen.getAllByText('Dream report')).toHaveLength(1)
    expect(screen.getAllByText('Remote question')).toHaveLength(1)
    expect(
      screen
        .getByText('Remote question')
        .compareDocumentPosition(screen.getByRole('status', { name: 'Owl is writing' })) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    await act(async () => {
      routeEvent({
        type: 'message.complete',
        session_id: 'chat',
        payload: { turn_id: 'remote-run', message_id: 'remote-answer', text: answer.text }
      } as GatewayEvent)
      await useSections.getState().open('chat')
      await useSections.getState().open('chat')
    })
    expect(screen.getAllByText('Remote final answer')).toHaveLength(1)
    expect(screen.getAllByText('Dream report')).toHaveLength(1)
    expect(
      screen
        .getByText('Remote question')
        .compareDocumentPosition(screen.getByText('Remote final answer')) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(useTranscripts.getState().bySession.chat!.messages.map(message => message.id)).toEqual([
      '0',
      '1',
      '2',
      'remote-answer'
    ])
  }
)

it('renders queued users, identified replies and an answered card in their actual order', async () => {
  await useSections.getState().open('chat')
  render(<ConversationColumn />)

  const event = (type: string, payload: Record<string, unknown> = {}) =>
    routeEvent({
      type,
      session_id: 'chat',
      payload: { turn_id: 'queued-run', ...payload }
    } as GatewayEvent)

  await act(async () => {
    event('message.start')
    event('message.interim', { message_id: 'first-fragment', text: 'First queued reply' })
    event('tool.start', { message_id: 'first-fragment', tool_id: 'queued-tool', name: 'terminal' })
    event('approval.request', {
      message_id: 'first-fragment',
      request_id: 'queued-card',
      command: 'read first.txt'
    })
    useTranscripts.getState().resolveApproval('chat', 'queued-card', 'once')
    event('tool.complete', {
      message_id: 'first-fragment',
      tool_id: 'queued-tool',
      result_text: 'Read'
    })
    event('message.delta', { message_id: 'second-fragment', text: 'Second queued reply' })
  })

  const rows = [
    { role: 'assistant', row_id: 0, text: 'Previous conversation' },
    { role: 'assistant', row_id: 1, text: 'Dream report', dream: true },
    { role: 'user', row_id: 2, text: 'First queued question', turn_id: 'queued-run' },
    {
      role: 'assistant',
      row_id: 'first-fragment',
      text: 'First queued reply',
      turn_id: 'queued-run'
    },
    {
      role: 'tool',
      row_id: 'tool-row',
      tool_id: 'queued-tool',
      name: 'terminal',
      text: 'Read',
      turn_id: 'queued-run'
    },
    { role: 'user', row_id: 3, text: 'Second queued question', turn_id: 'queued-run' }
  ]

  call.mockImplementation((method: string) =>
    method === 'hexbot.sections.open' ? Promise.resolve({ section, messages: rows }) : reply(method)
  )
  await act(async () => {
    reload()
    await useSections.getState().open('chat')
  })

  const before = (a: HTMLElement, b: HTMLElement) =>
    Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)

  expect(
    before(screen.getByText('First queued question'), screen.getByText('First queued reply'))
  ).toBe(true)
  expect(before(screen.getByText('First queued reply'), screen.getByText('read first.txt'))).toBe(
    true
  )
  expect(
    before(screen.getByText('read first.txt'), screen.getByText('Second queued question'))
  ).toBe(true)
  expect(
    before(
      screen.getByText('Second queued question'),
      screen.getByRole('status', { name: 'Owl is writing' })
    )
  ).toBe(true)
  call.mockImplementation((method: string) =>
    method === 'hexbot.sections.open'
      ? Promise.resolve({
          section,
          messages: [
            ...rows,
            {
              role: 'assistant',
              row_id: 'second-fragment',
              text: 'Second queued reply',
              turn_id: 'queued-run'
            }
          ]
        })
      : reply(method)
  )
  await act(async () => {
    event('message.complete', { message_id: 'second-fragment', text: 'Second queued reply' })
    await useSections.getState().open('chat')
    await useSections.getState().open('chat')
  })
  expect(screen.getAllByText('First queued reply')).toHaveLength(1)
  expect(screen.getAllByText('Second queued reply')).toHaveLength(1)
  expect(
    before(screen.getByText('read first.txt'), screen.getByText('Second queued question'))
  ).toBe(true)
})

it('reads the chat again on reconnect, so a card answered on another app meanwhile goes', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(1_000)

  try {
    useConnection.setState({ status: 'connected' })
    render(<ConversationColumn />)
    expect(await screen.findByText('Previous conversation')).toBeVisible()
    act(() =>
      routeEvent({
        type: 'approval.request',
        session_id: 'chat',
        payload: { choices: ['once', 'deny'], command: 'rm -rf build', request_id: 'a1' }
      } as GatewayEvent)
    )
    expect(screen.getByText('rm -rf build')).toBeVisible()
    // Answered on the phone while this app was offline: the answer event was missed.
    vi.setSystemTime(2_000)
    call.mockImplementation((method: string) =>
      method === 'hexbot.sections.open'
        ? Promise.resolve({ ...history(texts), busy: false, pending_requests: [] })
        : reply(method)
    )
    act(() => useConnection.setState({ status: 'reconnecting' }))
    act(() => useConnection.setState({ status: 'connected' }))
    await waitFor(() => expect(screen.queryByText('rm -rf build')).toBeNull())
    expect(screen.getByText('Previous conversation')).toBeVisible()
    expect(opens()).toHaveLength(2)
  } finally {
    vi.useRealTimers()
  }
})
