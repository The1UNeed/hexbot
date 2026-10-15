import { JsonRpcGatewayError } from '@hermes/shared'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider
} from '@tanstack/react-router'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { setActiveRpc } from '../../lib/rpc'
import type { Bot, DaemonInfo, Section } from '../../lib/types'
import { Route as HomeRoute } from '../../routes/index'
import { useBots } from '../../stores/bots'
import { useConnection } from '../../stores/connection'
import { useSections } from '../../stores/sections'
import { useTranscripts } from '../../stores/transcripts'
import { useUi } from '../../stores/ui'
import { ChatChooser } from '../chat-chooser'

import { ConversationColumn } from './index'

const section = (id: string, extra: Partial<Section> = {}) =>
  ({
    id,
    bot: 'owl',
    title: id,
    peer_bot: null,
    archived_at: null,
    message_count: 2,
    live_session_id: id,
    ...extra
  }) as Section

const old = section('old')
const canonical = section('canonical')
const peer = section('peer', { peer_bot: 'yak' })

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
let modern = true

const reply = (method: string, input: Record<string, unknown> = {}) =>
  Promise.resolve(
    method === 'hexbot.info'
      ? { one_chat: modern }
      : method === 'hexbot.sections.list'
        ? { sections: [old, canonical, peer] }
        : method === 'hexbot.sections.create'
          ? { section: canonical }
          : method === 'hexbot.sections.unarchive'
            ? { section: section(String(input.id)) }
            : method === 'hexbot.sections.open'
              ? {
                  section: section(
                    String(input.id),
                    input.id === 'peer' ? { peer_bot: 'yak' } : {}
                  ),
                  messages: [{ role: 'assistant', text: `${input.id} history` }],
                  ...(input.id === 'peer'
                    ? { pending_clarify: { request_id: 'question', question: 'Which file?' } }
                    : {})
                }
              : { connectors: [] }
  )

const calls = (method: string) => call.mock.calls.filter(([name]) => name === method)

async function mount(initial = '/b/owl/s/old') {
  const root = createRootRoute({
    component: () => (
      <>
        <ChatChooser />
        <Outlet />
      </>
    )
  })

  const home = createRoute({
    getParentRoute: () => root,
    path: '/',
    beforeLoad: HomeRoute.options.beforeLoad
  })

  const chat = createRoute({
    getParentRoute: () => root,
    path: '/b/$bot/s/$section',
    component: ConversationColumn
  })

  const room = createRoute({
    getParentRoute: () => root,
    path: '/r/$room',
    component: () => <p>Garden room</p>
  })

  const search = createRoute({
    getParentRoute: () => root,
    path: '/search',
    component: () => <p>Search page</p>
  })

  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ['/search', initial] }),
    routeTree: root.addChildren([home, chat, room, search])
  })

  await router.load()
  const view = render(<RouterProvider router={router} />)

  return { ...view, router }
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  modern = true
  useConnection.setState({
    target: { kind: 'local' },
    epoch: 'first',
    daemon: { one_chat: true } as DaemonInfo
  })
  useBots.setState({ byName: { owl: { name: 'owl', display_name: 'Owl' } as Bot }, loaded: true })
  useSections.setState({
    byId: { old, canonical },
    idsByBot: { owl: ['old', 'canonical'] },
    liveSessionId: {},
    choosing: null
  })
  useTranscripts.setState({ bySession: {} })
  useUi.setState({ lastSection: { bot: 'owl', section: 'old' } })
  call = vi.fn(reply)
  setActiveRpc({ call } as never)
})
afterEach(() => setActiveRpc(null))
it.each(['bookmark', 'startup', 'back', 'loaded'] as const)(
  'resolves a healthy survivor before opening or showing it: %s',
  async source => {
    if (source === 'loaded') {
      await useSections.getState().open('old')
    }

    call.mockClear()
    const view = await mount(source === 'startup' ? '/' : '/b/owl/s/old')
    expect(screen.queryByText('old history')).toBeNull()
    await waitFor(() => expect(view.router.state.location.pathname).toBe('/b/owl/s/canonical'))
    expect(await screen.findByText('canonical history')).toBeVisible()
    expect(calls('hexbot.sections.open').some(([, p]) => p.id === 'old')).toBe(false)

    if (source === 'back') {
      await act(async () => {
        await view.router.navigate({ to: '/r/$room', params: { room: 'garden' } })
        view.router.history.back()
      })
      expect(await screen.findByText('canonical history')).toBeVisible()
    }

    expect(calls('hexbot.sections.create').length).toBeLessThanOrEqual(3)
  }
)
it('leaves an explicit peer thread and its question on that thread', async () => {
  const view = await mount('/b/owl/s/peer')
  expect(await screen.findByText('Which file?')).toBeVisible()
  expect(view.router.state.location.pathname).toBe('/b/owl/s/peer')
  expect(calls('hexbot.sections.create')).toHaveLength(0)
  expect(useSections.getState().liveSessionId.peer).toBe('peer')
})
it.each(['room', 'back', 'same-url', 'daemon', 'epoch', 'unmount'] as const)(
  'a late canonical lookup yields to %s',
  async action => {
    const held = deferred()
    call.mockImplementation((method: string, input: Record<string, unknown>) =>
      method === 'hexbot.sections.create' ? held.promise : reply(method, input)
    )
    const view = await mount()
    await waitFor(() => expect(calls('hexbot.sections.create')).toHaveLength(1))
    await act(async () => {
      if (action === 'room') {
        void view.router.navigate({ to: '/r/$room', params: { room: 'garden' } })
      }

      if (action === 'back') {
        view.router.history.back()
      }

      if (action === 'same-url') {
        view.router.history.push('/b/owl/s/old')
      }

      if (action === 'daemon') {
        useConnection.getState().setTarget({ kind: 'local', origin: 'http://other' })
      }

      if (action === 'epoch') {
        useConnection.getState().setEpoch('second')
      }

      if (action === 'unmount') {
        view.unmount()
      }

      held.resolve({ section: canonical })
    })

    if (['room', 'back', 'unmount'].includes(action)) {
      expect(calls('hexbot.sections.open')).toHaveLength(0)
    }

    if (action === 'room') {
      expect(view.router.state.location.pathname).toBe('/r/garden')
    }

    if (action === 'back') {
      expect(view.router.state.location.pathname).toBe('/search')
    }
  }
)
it.each(['info', 'list', 'open'] as const)(
  'keeps an honest Retry after a temporary %s failure',
  async boundary => {
    if (boundary === 'info') {
      useConnection.setState({ daemon: null })
    }

    if (boundary === 'list') {
      useSections.setState({ byId: {}, idsByBot: {} })
    }

    const method = `hexbot.${boundary === 'info' ? 'info' : `sections.${boundary}`}`
    let failed = false
    call.mockImplementation((name: string, input: Record<string, unknown>) => {
      if (name === method && !failed) {
        failed = true

        return Promise.reject(new Error('Temporary failure'))
      }

      return reply(name, input)
    })
    const view = await mount(boundary === 'open' ? '/b/owl/s/canonical' : '/b/owl/s/old')
    expect(await screen.findByRole('alert')).toHaveTextContent('Temporary failure')
    expect(view.router.state.location.pathname).toBe(
      boundary === 'open' ? '/b/owl/s/canonical' : '/b/owl/s/old'
    )

    if (boundary === 'info') {
      expect(calls('hexbot.sections.create')).toHaveLength(0)
    }

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('canonical history')).toBeVisible()
  }
)
it('offers the older-daemon chooser and cancel without adopting the bookmarked row', async () => {
  modern = false
  useConnection.setState({ daemon: { one_chat: false } as unknown as DaemonInfo })
  const view = await mount()
  expect(await screen.findByRole('dialog')).toBeVisible()
  expect(calls('hexbot.sections.unarchive')).toHaveLength(0)
  expect(calls('hexbot.sections.open')).toHaveLength(0)
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape', code: 'Escape' })
  expect(view.router.state.location.pathname).toBe('/b/owl/s/old')
  expect(calls('hexbot.sections.create')).toHaveLength(0)
  expect(calls('hexbot.sections.unarchive')).toHaveLength(0)
})
it('persists the older-daemon chosen chat before opening it', async () => {
  modern = false
  useConnection.setState({ daemon: { one_chat: false } as unknown as DaemonInfo })
  await mount()
  fireEvent.click(await screen.findByRole('button', { name: /canonical/ }))
  expect(await screen.findByText('canonical history')).toBeVisible()
  const methods = call.mock.calls.map(([method]) => method)
  expect(methods.indexOf('hexbot.sections.unarchive')).toBeLessThan(
    methods.indexOf('hexbot.sections.open')
  )
  expect(calls('hexbot.sections.unarchive')[0]![1]).toEqual({ id: 'canonical' })
})
it('does not bounce a route on a temporary open error with code 4001', async () => {
  call.mockImplementation((method: string, input: Record<string, unknown>) =>
    method === 'hexbot.sections.open'
      ? Promise.reject(new JsonRpcGatewayError('Pi session not found', { code: 4001 }))
      : reply(method, input)
  )
  const view = await mount('/b/owl/s/canonical')
  expect(await screen.findByRole('alert')).toHaveTextContent('Pi session not found')
  expect(view.router.state.location.pathname).toBe('/b/owl/s/canonical')
})

it('binds same-URL navigation to a new lookup, ignoring the old reply', async () => {
  const first = deferred()
  const second = deferred()
  let lookups = 0
  call.mockImplementation((method: string, input: Record<string, unknown>) =>
    method === 'hexbot.sections.create'
      ? ++lookups === 1
        ? first.promise
        : lookups === 2
          ? second.promise
          : reply(method, input)
      : reply(method, input)
  )
  const view = await mount()
  await waitFor(() => expect(lookups).toBe(1))
  await act(async () => {
    view.router.history.push('/b/owl/s/old')
  })
  await waitFor(() => expect(lookups).toBe(2))
  await act(async () => first.resolve({ section: canonical }))
  expect(view.router.state.location.pathname).toBe('/b/owl/s/old')
  expect(screen.getByRole('textbox', { name: 'Message' })).toBeDisabled()
  expect(calls('hexbot.sections.open')).toHaveLength(0)
  await act(async () => second.resolve({ section: canonical }))
  expect(await screen.findByText('canonical history')).toBeVisible()
})

it('dismisses a route chooser when navigation supersedes its entry', async () => {
  modern = false
  useConnection.setState({ daemon: { one_chat: false } as unknown as DaemonInfo })
  const view = await mount()
  await screen.findByRole('dialog')
  const obsolete = useSections.getState().choosing!
  await act(async () => {
    await view.router.navigate({ to: '/r/$room', params: { room: 'garden' } })
    obsolete.pick(old)
  })
  expect(useSections.getState().choosing).toBeNull()
  expect(calls('hexbot.sections.unarchive')).toHaveLength(0)
  expect(view.router.state.location.pathname).toBe('/r/garden')
})
