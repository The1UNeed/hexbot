import { JsonRpcGatewayError } from '@hermes/shared'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'

import { authorizeCache, resetDeviceCacheForTests, writeCache } from '../../lib/device-cache'
import { restoreRoster } from '../../lib/roster-cache'
import { setActiveRpc } from '../../lib/rpc'
import type { Bot, DaemonInfo, Section } from '../../lib/types'
import { useBots } from '../../stores/bots'
import { useConnection } from '../../stores/connection'
import { useSections } from '../../stores/sections'
import { useTranscripts } from '../../stores/transcripts'
import { useUi } from '../../stores/ui'

import { ConversationColumn } from './index'

const navigate = vi.fn()
let params = { bot: 'owl', section: 'old' }
vi.mock('@tanstack/react-router', () => {
  const router = {
    matchRoutes: () => [{ params: params }],
    history: { location: {}, subscribe: () => () => {} },
    subscribe: () => () => {}
  }

  return {
    useRouter: () => router,
    useNavigate: () => navigate,
    useParams: () => params
  }
})

const section = (id: string, live: string | null = null) =>
  ({
    id,
    bot: 'owl',
    title: 'Trip',
    live_session_id: live,
    archived_at: null,
    message_count: 1,
    peer_bot: null
  }) as Section

const remembered = { bot: 'owl', section: 'old' }

const deferred = () => {
  let resolve!: (value: unknown) => void
  let reject!: (error: Error) => void

  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })

  return { promise, resolve, reject }
}

let call: ReturnType<typeof vi.fn>

const reply = (method: string, input: { id?: string } = {}) =>
  Promise.resolve(
    method === 'hexbot.sections.open'
      ? { section: section(input.id ?? 'old', `live-${input.id}`), messages: [] }
      : method === 'hexbot.sections.create'
        ? { section: section(params.section) }
        : { connectors: [] }
  )

beforeEach(() => {
  params = { bot: 'owl', section: 'old' }
  navigate.mockReset()
  Element.prototype.scrollIntoView = vi.fn()
  useConnection.setState({
    target: { kind: 'local' },
    epoch: 'first',
    daemon: { one_chat: true } as DaemonInfo
  })
  useBots.setState({ byName: { owl: { name: 'owl', display_name: 'Owl' } as Bot }, loaded: true })
  useSections.setState({
    byId: { old: section('old') },
    idsByBot: { owl: ['old'] },
    liveSessionId: {},
    cachedMessages: {},
    choosing: null
  })
  useTranscripts.setState({ bySession: {} })
  useUi.setState({ lastSection: remembered })
  call = vi.fn(reply)
  setActiveRpc({ call } as never)
})

it.each([
  new JsonRpcGatewayError('Provider preparation failed', { code: 5200 }),
  new JsonRpcGatewayError('Pi session not found', { code: 4001 }),
  new Error('Network disconnected')
])('keeps the selected route and retries a temporary open failure: %s', async error => {
  let attempts = 0
  call.mockImplementation((method: string, input: { id?: string }) => {
    if (method === 'hexbot.sections.open' && attempts++ === 0) {
      return Promise.reject(error)
    }

    return reply(method, input)
  })
  render(<ConversationColumn />)
  expect(await screen.findByRole('alert')).toHaveTextContent(error.message)
  expect(useUi.getState().lastSection).toEqual(remembered)
  expect(call.mock.calls.filter(([method]) => method === 'hexbot.sections.create')).toHaveLength(1)
  expect(attempts).toBe(1)
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await waitFor(() => expect(useSections.getState().liveSessionId.old).toBe('live-old'))
  expect(screen.queryByRole('alert')).toBeNull()
  expect(navigate).not.toHaveBeenCalled()
  expect(useUi.getState().lastSection).toEqual(remembered)
  expect(attempts).toBe(2)
})
it('redirects a genuinely deleted old ID to the canonical chat', async () => {
  call.mockImplementation((method: string, input: { id?: string }) => {
    if (method === 'hexbot.sections.open') {
      return Promise.reject(new JsonRpcGatewayError('section not found', { code: 4204 }))
    }

    if (method === 'hexbot.sections.create') {
      return Promise.resolve({ section: section('canonical') })
    }

    return reply(method, input)
  })
  render(<ConversationColumn />)
  await waitFor(() =>
    expect(navigate).toHaveBeenCalledWith({
      to: '/b/$bot/s/$section',
      params: { bot: 'owl', section: 'canonical' },
      replace: true
    })
  )
})
it('offers Retry when a missing reply resolves to the same catalog ID', async () => {
  call.mockImplementation((method: string, input: { id?: string }) =>
    method === 'hexbot.sections.open'
      ? Promise.reject(new JsonRpcGatewayError('section not found', { code: 4204 }))
      : reply(method, input)
  )
  render(<ConversationColumn />)
  expect(await screen.findByRole('button', { name: 'Retry' })).toBeVisible()
  expect(screen.queryByText('This chat is no longer available')).toBeNull()
  expect(useUi.getState().lastSection).toEqual(remembered)
  expect(navigate).not.toHaveBeenCalled()
})
it.each(['navigate', 'daemon', 'unmount'] as const)(
  'ignores a late missing-section failure after %s',
  async action => {
    const old = deferred()
    let held = false
    call.mockImplementation((method: string, input: { id?: string }) => {
      if (method === 'hexbot.sections.open' && input.id === 'old' && !held) {
        held = true

        return old.promise
      }

      return reply(method, input)
    })
    const view = render(<ConversationColumn />)
    await waitFor(() => expect(held).toBe(true))

    const canonicalCalls = call.mock.calls.filter(
      ([method]) => method === 'hexbot.sections.create'
    ).length

    if (action === 'navigate') {
      params = { bot: 'owl', section: 'new' }
      view.rerender(<ConversationColumn />)
    }

    if (action === 'daemon') {
      act(() =>
        useConnection.setState({ target: { kind: 'local', origin: 'http://another-daemon' } })
      )
    }

    if (action === 'unmount') {
      view.unmount()
    }

    await act(async () => {
      old.reject(new JsonRpcGatewayError('section not found', { code: 4204 }))
    })
    expect(call.mock.calls.filter(([method]) => method === 'hexbot.sections.create')).toHaveLength(
      canonicalCalls + (action === 'daemon' ? 1 : 0)
    )
    expect(navigate).not.toHaveBeenCalled()
    expect(useUi.getState().lastSection).toEqual(remembered)
  }
)
it('ignores late canonical resolution after navigation', async () => {
  const canonical = deferred()
  call.mockImplementation((method: string, input: { id?: string }) => {
    if (method === 'hexbot.sections.open' && input.id === 'old') {
      return Promise.reject(new JsonRpcGatewayError('section not found', { code: 4204 }))
    }

    if (method === 'hexbot.sections.create') {
      return canonical.promise
    }

    return reply(method, input)
  })
  const view = render(<ConversationColumn />)
  await waitFor(() => expect(call).toHaveBeenCalledWith('hexbot.sections.create', { bot: 'owl' }))
  params = { bot: 'owl', section: 'new' }
  view.rerender(<ConversationColumn />)
  await act(async () => {
    canonical.resolve({ section: section('canonical') })
  })
  expect(navigate).not.toHaveBeenCalled()
  expect(useUi.getState().lastSection).toEqual(remembered)
})

it('keeps a deep-linked bot and remembered chat while an incomplete cached roster awaits the network', async () => {
  await resetDeviceCacheForTests()
  vi.stubGlobal('indexedDB', new IDBFactory())
  vi.stubGlobal('IDBKeyRange', IDBKeyRange)
  const scope = 'local:http://cache.test'
  const held = deferred()
  call.mockImplementation((method: string, input: { id?: string }) =>
    method === 'hexbot.bots.list' ? held.promise : reply(method, input)
  )
  useConnection.setState({
    target: { kind: 'local', origin: 'http://cache.test' },
    daemon: { install_id: 'daemon', one_chat: true } as DaemonInfo
  })
  useBots.getState().reset()

  try {
    await authorizeCache(scope, 'daemon', () => true)
    await writeCache(scope, 'roster', {
      daemon: 'daemon',
      bots: [{ name: 'other', display_name: 'Other' }],
      sections: [],
      rooms: [],
      me: null
    })
    const listing = useBots.getState().refresh()
    await restoreRoster(scope)
    render(<ConversationColumn />)
    await waitFor(() => expect(useSections.getState().liveSessionId.old).toBe('live-old'))
    expect(screen.queryByText('This bot no longer exists')).toBeNull()
    expect(useUi.getState().lastSection).toEqual(remembered)
    await act(async () => {
      held.resolve({ bots: [{ name: 'owl', display_name: 'Owl' }] })
      await listing
    })
    expect(screen.queryByText('This bot no longer exists')).toBeNull()
    expect(useBots.getState().byName.owl).toBeDefined()
  } finally {
    await resetDeviceCacheForTests()
    vi.unstubAllGlobals()
  }
})
it('shows the bot loading, not an empty chat, until the history arrives', async () => {
  const held = deferred()
  call.mockImplementation((method: string, input: { id?: string }) =>
    method === 'hexbot.sections.open' ? held.promise : reply(method, input)
  )
  render(<ConversationColumn />)
  expect(await screen.findByRole('status', { name: "Opening Owl's chat" })).toBeInTheDocument()
  await waitFor(() =>
    expect(call.mock.calls.some(([method]) => method === 'hexbot.sections.open')).toBe(true)
  )
  expect(screen.getByRole('status', { name: "Opening Owl's chat" })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /What can you help me/i })).toBeNull()
  await act(async () => {
    held.resolve({
      section: section('old', 'live-old'),
      messages: [{ role: 'assistant', text: 'Owl history' }]
    })
  })
  expect(await screen.findByText('Owl history')).toBeInTheDocument()
  expect(screen.queryByRole('status', { name: "Opening Owl's chat" })).toBeNull()
})
it('keeps loading over an empty saved history until the read finds what arrived since', async () => {
  const held = deferred()
  call.mockImplementation((method: string, input: { id?: string }) =>
    method === 'hexbot.sections.open' ? held.promise : reply(method, input)
  )
  useSections.setState({ cachedMessages: { old: [] } })
  render(<ConversationColumn />)
  await waitFor(() =>
    expect(call.mock.calls.some(([method]) => method === 'hexbot.sections.open')).toBe(true)
  )
  expect(screen.getByRole('status', { name: "Opening Owl's chat" })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /What can you help me/i })).toBeNull()
  await act(async () => {
    held.resolve({
      section: section('old', 'live-old'),
      messages: [{ role: 'assistant', text: 'Sent from the phone' }]
    })
  })
  expect(await screen.findByText('Sent from the phone')).toBeInTheDocument()
})
it('shows an empty chat once its history is read', async () => {
  call.mockImplementation((method: string, input: { id?: string }) =>
    method === 'hexbot.sections.open'
      ? Promise.resolve({ section: section('old'), messages: [] })
      : reply(method, input)
  )
  render(<ConversationColumn />)
  expect(await screen.findByRole('button', { name: /What can you help me/i })).toBeInTheDocument()
  expect(screen.queryByRole('status', { name: "Opening Owl's chat" })).toBeNull()
})
