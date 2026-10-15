import type { GatewayEvent } from '@hermes/shared'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { routeEvent } from '../../lib/events'
import { setActiveRpc } from '../../lib/rpc'
import type { Bot, DaemonInfo, Section } from '../../lib/types'
import { useBots } from '../../stores/bots'
import { useConnection } from '../../stores/connection'
import { useSections } from '../../stores/sections'
import { useTranscripts } from '../../stores/transcripts'

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
  texts = ['Previous conversation']
  call = vi.fn(reply)
  setActiveRpc({ call } as never)
})
afterEach(() => setActiveRpc(null))

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
