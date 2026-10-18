import type { GatewayEvent } from '@hermes/shared'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

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
    daemon: { one_chat: true } as DaemonInfo
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
    const view = render(<ConversationColumn />)
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
    expect(opens()).toHaveLength(2)
  }
)

it('does not treat an initial catalog live ID as loaded chat history', async () => {
  await useSections.getState().refresh()
  render(<ConversationColumn />)
  expect(await screen.findByText('Previous conversation')).toBeVisible()
  expect(opens()).toHaveLength(1)
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
      routeEvent({ type, session_id: 'chat', payload } as GatewayEvent)

    const rows = [
      { role: 'assistant', row_id: 1, text: 'Previous conversation' },
      { role: 'user', row_id: 2, text: 'Current question' },
      { role: 'assistant', row_id: 3, text: 'Dream report', dream: true }
    ]

    const answer = { role: 'assistant', row_id: 4, text: 'Final answer' }
    await useSections.getState().open('chat')
    render(<ConversationColumn />)
    expect(await screen.findByText('Previous conversation')).toBeVisible()
    await act(async () => {
      useTranscripts.getState().appendUserMessage('chat', 'Current question')

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
    routeEvent({ type, session_id: 'chat', payload } as GatewayEvent)

  texts = Array.from({ length: 65 }, (_, index) => `Older message ${index}`)
  const old = history(texts).messages
  await useSections.getState().open('chat')
  render(<ConversationColumn />)
  expect(await screen.findByText('Older message 64')).toBeVisible()
  expect(screen.queryByText('Older message 0')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }))
  expect(screen.getByText('Older message 0')).toBeVisible()
  await act(async () => {
    useTranscripts.getState().appendUserMessage('chat', 'Current question')
    event('message.start')
    event('message.interim', { text: 'Equal interim' })
    event('message.interim', { text: 'Equal interim' })
    event('tool.start', {
      tool_id: 'visual-1',
      name: 'hexbot_show_html',
      args: { html: '<p>chart</p>', title: 'Costs' }
    })
  })

  const rows = [
    ...old,
    { role: 'user', row_id: 65, text: 'Current question' },
    { role: 'assistant', row_id: 66, text: 'Dream report', dream: true },
    { role: 'assistant', row_id: 67, text: 'Equal interim' },
    { role: 'assistant', row_id: 68, text: 'Equal interim' },
    { role: 'tool', row_id: 69, tool_id: 'visual-1', name: 'hexbot_show_html', text: 'Shown' }
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
            messages: [...rows, { role: 'assistant', row_id: 70, text: 'Final answer' }]
          })
  )
  await act(async () => {
    reload()
  })
  const loading = useSections.getState().open('chat')
  await act(async () => {
    event('message.delta', { text: 'Later tail' })
    event('tool.complete', { tool_id: 'visual-1', result_text: 'Shown' })
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
