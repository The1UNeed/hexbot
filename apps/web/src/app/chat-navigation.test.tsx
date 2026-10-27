import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useRouterState
} from '@tanstack/react-router'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { setActiveRpc } from '../lib/rpc'
import type { Bot, DaemonInfo, Room, Section } from '../lib/types'
import { useBots } from '../stores/bots'
import { useConnection } from '../stores/connection'
import { useRooms } from '../stores/rooms'
import { useSections } from '../stores/sections'

import { DreamingBlock } from './bot-settings/memory'
import { ChatChooser } from './chat-chooser'
import { RosterColumn } from './roster'

const bot = {
  name: 'owl',
  display_name: 'Owl',
  avatar: null,
  title: '',
  description: '',
  sections_recent: []
} as unknown as Bot

const section = (id: string, updated_at = 1) =>
  ({
    id,
    bot: 'owl',
    title: id,
    updated_at,
    archived_at: null,
    peer_bot: null,
    live_session_id: null,
    message_count: 2,
    preview: id
  }) as Section

const healthy = section('healthy')
const quarantined = section('quarantined', 9)
const room = { id: 'garden', name: 'Garden', members: [], archived_at: null } as unknown as Room

const deferred = () => {
  let resolve!: (value: unknown) => void

  const promise = new Promise(yes => {
    resolve = yes
  })

  return { promise, resolve }
}

let call: ReturnType<typeof vi.fn>
const methods = () => call.mock.calls.map(([method]) => method)

const reply = (method: string) =>
  Promise.resolve(
    {
      'hexbot.sections.create': { section: healthy },
      'hexbot.sections.list': { sections: [quarantined, healthy] },
      'hexbot.sections.unarchive': { section: healthy },
      'hexbot.sections.open': { section: healthy, messages: [] },
      'hexbot.dreaming.status': { enabled: true },
      'hexbot.dreaming.list': {
        dreams: [
          { id: 'd1', started_at: 1, status: 'complete', summary: 'Report one' },
          { id: 'd2', started_at: 2, status: 'complete', summary: 'Report two' }
        ]
      }
    }[method] ?? {}
  )

beforeEach(() => {
  useConnection.setState({
    target: { kind: 'local' },
    epoch: 'first',
    daemon: { one_chat: true } as DaemonInfo
  })
  useBots.setState({ byName: { owl: bot }, order: ['owl'], loaded: true })
  useRooms.setState({ byId: { garden: room }, order: ['garden'] })
  useSections.setState({
    byId: { quarantined, healthy },
    idsByBot: { owl: ['quarantined', 'healthy'] },
    liveSessionId: {},
    choosing: null
  })
  call = vi.fn(reply)
  setActiveRpc({ call } as never)
})
afterEach(() => setActiveRpc(null))

function Location() {
  const href = useRouterState({ select: state => state.location.href })

  return <output data-testid="location">{href}</output>
}

async function mount(memory = false, initial = memory ? '/b/owl/settings/memory' : '/') {
  const root = createRootRoute({
    component: () => (
      <>
        <RosterColumn />
        <ChatChooser />
        <Location />
        <Outlet />
      </>
    )
  })

  const home = createRoute({ getParentRoute: () => root, path: '/', component: () => null })
  const room = createRoute({ getParentRoute: () => root, path: '/r/$room', component: () => null })

  const chat = createRoute({
    getParentRoute: () => root,
    path: '/b/$bot/s/$section',
    component: () => null
  })

  const settings = createRoute({
    getParentRoute: () => root,
    path: '/b/$bot/settings/$tab',
    component: () => <DreamingBlock bot={bot} onSave={() => undefined} />
  })

  const search = createRoute({ getParentRoute: () => root, path: '/search', component: () => null })

  const history = createMemoryHistory({
    initialEntries: ['/search', initial]
  })

  const router = createRouter({
    history,
    routeTree: root.addChildren([home, room, chat, settings, search])
  })

  await router.load()
  const view = render(<RouterProvider router={router} />)
  await screen.findByRole('button', { name: /Owl/ })

  return { router, ...view }
}

const expectLocation = (path: string) =>
  expect(screen.getByTestId('location')).toHaveTextContent(path)

it.each(['room', 'back', 'search', 'unmount', 'daemon'] as const)(
  'roster lookup yields to later %s, even in the same React batch',
  async action => {
    const held = deferred()
    call.mockImplementation((method: string) =>
      method === 'hexbot.sections.create' ? held.promise : reply(method)
    )
    const view = await mount()
    fireEvent.click(screen.getByRole('button', { name: /Owl/ }))
    await waitFor(() => expect(methods()).toContain('hexbot.sections.create'))
    await act(async () => {
      if (action === 'room') {
        fireEvent.click(screen.getByRole('button', { name: /Garden/ }))
      }

      if (action === 'back') {
        view.router.history.back()
      }

      if (action === 'search') {
        view.router.history.push('/search')
      }

      if (action === 'unmount') {
        view.unmount()
      }

      if (action === 'daemon') {
        useConnection.getState().setTarget({ kind: 'local', origin: 'http://other' })
      }

      held.resolve({ section: healthy })
    })
    expect(methods()).not.toContain('hexbot.sections.open')
    expect(view.router.state.location.pathname).toBe(
      action === 'room' ? '/r/garden' : ['back', 'search'].includes(action) ? '/search' : '/'
    )
  }
)

it('opens a chat the daemon named on this connection without waiting for it again', async () => {
  const view = await mount()
  fireEvent.click(screen.getByRole('button', { name: /Owl/ }))
  await waitFor(() => expectLocation('/b/owl/s/healthy'))
  await act(async () => {
    void view.router.navigate({ to: '/r/$room', params: { room: 'garden' } })
  })
  call.mockImplementation((method: string) =>
    method === 'hexbot.sections.create' ? deferred().promise : reply(method)
  )
  fireEvent.click(screen.getByRole('button', { name: /Owl/ }))
  await waitFor(() => expectLocation('/b/owl/s/healthy'))
  expect(methods().filter(method => method === 'hexbot.sections.create')).toHaveLength(1)
})

it('shows the clicked bot as chosen while its chat is asked for', async () => {
  call.mockImplementation((method: string) =>
    method === 'hexbot.sections.create' ? deferred().promise : reply(method)
  )
  await mount()
  const row = screen.getByRole('button', { name: /Owl/ })
  expect(row).not.toHaveClass('bg-background')
  fireEvent.click(row)
  await waitFor(() => expect(row).toHaveClass('bg-background'))
  expectLocation('/')
  // Going elsewhere drops the choice, though the lookup never answers,
  // even to the place already shown.
  fireEvent.click(screen.getByRole('button', { name: /Garden/ }))
  await waitFor(() => expectLocation('/r/garden'))
  expect(row).not.toHaveClass('bg-background')
  fireEvent.click(row)
  await waitFor(() => expect(row).toHaveClass('bg-background'))
  fireEvent.click(screen.getByRole('button', { name: /Garden/ }))
  await waitFor(() => expect(row).not.toHaveClass('bg-background'))
})

it.each(['list', 'chooser', 'write'] as const)(
  'older roster lookup yields at the %s boundary',
  async boundary => {
    useConnection.setState({ daemon: { version: '0.1.6' } as DaemonInfo })
    const held = deferred()
    const delayed = boundary === 'list' ? 'hexbot.sections.list' : 'hexbot.sections.unarchive'
    call.mockImplementation((method: string) => (method === delayed ? held.promise : reply(method)))
    const view = await mount()
    fireEvent.click(screen.getByRole('button', { name: /Owl/ }))

    if (boundary !== 'list') {
      const pick = await screen.findByRole('button', { name: /healthy/ })

      if (boundary === 'write') {
        fireEvent.click(pick)
      }
    }

    await act(async () => {
      void view.router.navigate({ to: '/r/$room', params: { room: 'garden' } })

      if (boundary === 'list') {
        held.resolve({ sections: [healthy] })
      }

      if (boundary === 'write') {
        held.resolve({ section: healthy })
      }
    })
    expectLocation('/r/garden')
    expect(methods()).not.toContain('hexbot.sections.create')
    expect(methods()).not.toContain('hexbot.sections.open')

    if (boundary !== 'write') {
      expect(methods()).not.toContain('hexbot.sections.unarchive')
    }

    expect(useSections.getState().choosing).toBeNull()

    // A write that finished after navigation must not become a remembered pick.
    if (boundary === 'write') {
      fireEvent.click(screen.getByRole('button', { name: /Owl/ }))
      await screen.findByRole('dialog')
      act(() => useSections.getState().choosing?.pick(null))
    }
  }
)

it.each(['Report one', 'Report two'])(
  'resolves %s on activation through the daemon, without row RPCs',
  async name => {
    await mount(true)
    const report = await screen.findByText(name)
    expect(methods()).not.toContain('hexbot.sections.create')
    fireEvent.click(report)
    await waitFor(() => expectLocation('/b/owl/s/healthy'))
    expect(call).toHaveBeenCalledWith('hexbot.sections.create', { bot: 'owl', title: undefined })
  }
)

it('Dream reports open the replacement when every local row is unreadable', async () => {
  call.mockImplementation((method: string) =>
    method === 'hexbot.sections.create'
      ? Promise.resolve({ section: section('replacement') })
      : reply(method)
  )
  await mount(true)
  fireEvent.click(await screen.findByText('Report one'))
  await waitFor(() => expectLocation('/b/owl/s/replacement'))
})

it('older Dream links preserve ambiguity, cancellation, and the persisted choice', async () => {
  useConnection.setState({ daemon: { version: '0.1.6' } as DaemonInfo })
  await mount(true)
  fireEvent.click(await screen.findByText('Report one'))
  fireEvent.keyDown(await screen.findByRole('dialog'), { key: 'Escape' })
  await waitFor(() => expect(useSections.getState().choosing).toBeNull())
  expectLocation('/b/owl/settings/memory')
  expect(methods()).not.toContain('hexbot.sections.create')
  expect(methods()).not.toContain('hexbot.sections.unarchive')
  fireEvent.click(screen.getByText('Report two'))
  fireEvent.click(await screen.findByRole('button', { name: /healthy/ }))
  await waitFor(() => expectLocation('/b/owl/s/healthy'))
  expect(call).toHaveBeenCalledWith('hexbot.sections.unarchive', { id: 'healthy' })
})

it.each(['navigate', 'epoch', 'unmount'] as const)(
  'Dream report resolution yields to %s',
  async action => {
    const held = deferred()
    call.mockImplementation((method: string) =>
      method === 'hexbot.sections.create' ? held.promise : reply(method)
    )
    const view = await mount(true)
    fireEvent.click(await screen.findByText('Report one'))
    await waitFor(() => expect(methods()).toContain('hexbot.sections.create'))
    await act(async () => {
      if (action === 'navigate') {
        view.router.history.push('/search')
      }

      if (action === 'epoch') {
        useConnection.getState().setEpoch('restarted')
      }

      if (action === 'unmount') {
        view.unmount()
      }

      held.resolve({ section: healthy })
    })
    expect(view.router.state.location.pathname).toBe(
      action === 'navigate' ? '/search' : '/b/owl/settings/memory'
    )
  }
)

it.each(['list', 'chooser', 'write'] as const)(
  'older Dream report selection yields at the %s boundary',
  async boundary => {
    useConnection.setState({ daemon: { version: '0.1.6' } as DaemonInfo })
    const held = deferred()
    const delayed = boundary === 'list' ? 'hexbot.sections.list' : 'hexbot.sections.unarchive'
    const view = await mount(true)
    await screen.findByText('Report one')
    call.mockImplementation((method: string) => (method === delayed ? held.promise : reply(method)))
    fireEvent.click(screen.getByText('Report one'))

    if (boundary !== 'list') {
      const pick = await screen.findByRole('button', { name: /healthy/ })

      if (boundary === 'write') {
        fireEvent.click(pick)
      }
    }

    await act(async () => {
      view.router.history.back()

      if (boundary === 'list') {
        held.resolve({ sections: [healthy] })
      }

      if (boundary === 'write') {
        held.resolve({ section: healthy })
      }
    })
    expectLocation('/search')
    expect(methods()).not.toContain('hexbot.sections.create')
    expect(methods()).not.toContain('hexbot.sections.open')

    if (boundary !== 'write') {
      expect(methods()).not.toContain('hexbot.sections.unarchive')
    }

    expect(useSections.getState().choosing).toBeNull()
  }
)

it('a later click on the already selected room cancels the pending bot lookup', async () => {
  const held = deferred()
  call.mockImplementation((method: string) =>
    method === 'hexbot.sections.create' ? held.promise : reply(method)
  )
  await mount(false, '/r/garden')
  fireEvent.click(screen.getByRole('button', { name: /Owl/ }))
  await waitFor(() => expect(methods()).toContain('hexbot.sections.create'))
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /Garden/ }))
    held.resolve({ section: healthy })
  })
  expectLocation('/r/garden')
  expect(methods()).not.toContain('hexbot.sections.open')
})
