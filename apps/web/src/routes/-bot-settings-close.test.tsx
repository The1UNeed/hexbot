import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider
} from '@tanstack/react-router'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { ChatChooser } from '../app/chat-chooser'
import { setActiveRpc } from '../lib/rpc'
import type { DaemonInfo, Section } from '../lib/types'
import { useBots } from '../stores/bots'
import { useConnection } from '../stores/connection'
import { useSections } from '../stores/sections'
import { useUi } from '../stores/ui'

import { Route } from './b.$bot.settings.$tab'

import { Route as HomeRoute } from './index'

vi.mock('../app/app-shell', () => ({ AppShell: () => null }))
vi.mock('../app/bot-settings', () => ({
  BotSettingsPanel: () => null,
  isBotSettingsTab: () => true,
  rememberTab: () => {},
  TAB_LABELS: { profile: 'Profile' }
}))

const section = (id: string) =>
  ({ id, bot: 'owl', title: id, message_count: 2, preview: '' }) as Section

const healthy = section('healthy')
const old = section('old')

const deferred = () => {
  let resolve!: (value: unknown) => void

  const promise = new Promise(yes => {
    resolve = yes
  })

  return { promise, resolve }
}

let call: ReturnType<typeof vi.fn>

const reply = (method: string) =>
  Promise.resolve(
    method === 'hexbot.sections.create'
      ? { section: healthy }
      : method === 'hexbot.sections.list'
        ? { sections: [old, healthy] }
        : method === 'hexbot.sections.unarchive'
          ? { section: healthy }
          : {}
  )

beforeEach(() => {
  useBots.setState({
    byName: { owl: { name: 'owl', display_name: 'Owl', sections_recent: [] } as never },
    loaded: true
  })
  useUi.setState({ lastSection: null })
  useSections.setState({ choosing: null, byId: {}, idsByBot: {} })
  useConnection.setState({
    target: { kind: 'local' },
    epoch: 'first',
    daemon: { one_chat: true } as DaemonInfo
  })
  call = vi.fn(reply)
  setActiveRpc({ call } as never)
})
afterEach(() => setActiveRpc(null))

async function mount() {
  const root = createRootRoute({
    component: () => (
      <>
        <ChatChooser />
        <Outlet />
      </>
    )
  })

  const settings = createRoute({
    getParentRoute: () => root,
    path: '/b/$bot/settings/$tab',
    component: Route.options.component as never
  })

  const chat = createRoute({
    getParentRoute: () => root,
    path: '/b/$bot/s/$section',
    component: () => <p>Chat</p>
  })

  const room = createRoute({
    getParentRoute: () => root,
    path: '/r/$room',
    component: () => <p>Room</p>
  })

  const home = createRoute({
    getParentRoute: () => root,
    path: '/',
    beforeLoad: HomeRoute.options.beforeLoad
  })

  const onboarding = createRoute({
    getParentRoute: () => root,
    path: '/onboarding',
    component: () => <p>Onboarding</p>
  })

  const connect = createRoute({
    getParentRoute: () => root,
    path: '/connect',
    component: () => <p>Connect</p>
  })

  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ['/b/owl/settings/profile'] }),
    routeTree: root.addChildren([settings, chat, room, home, onboarding, connect])
  })

  await router.load()
  const view = render(<RouterProvider router={router} />)
  await screen.findByRole('button', { name: 'Close bot settings' })

  return { ...view, router }
}

const close = () => fireEvent.click(screen.getByRole('button', { name: 'Close bot settings' }))
it.each(['room', 'unmount', 'daemon', 'epoch', 'capability', 'same-url'] as const)(
  'pending close yields to later %s',
  async action => {
    const pending = deferred()
    call.mockImplementation((method: string) =>
      method === 'hexbot.sections.create' ? pending.promise : reply(method)
    )
    const view = await mount()
    close()
    await waitFor(() => expect(call).toHaveBeenCalledWith('hexbot.sections.create', { bot: 'owl' }))
    await act(async () => {
      if (action === 'room') {
        await view.router.navigate({ to: '/r/$room', params: { room: 'garden' } })
      }

      if (action === 'unmount') {
        view.unmount()
      }

      if (action === 'daemon') {
        useConnection.getState().setTarget({ kind: 'local', origin: 'http://other' })
      }

      if (action === 'epoch') {
        useConnection.getState().setEpoch('second')
      }

      if (action === 'capability') {
        useConnection.setState({ daemon: null })
      }

      if (action === 'same-url') {
        view.router.history.push('/b/owl/settings/profile')
      }

      pending.resolve({ section: healthy })
    })
    expect(view.router.state.location.pathname).toBe(
      action === 'room' ? '/r/garden' : '/b/owl/settings/profile'
    )
  }
)
it('uses the daemon choice instead of a remembered surviving owner row', async () => {
  useUi.setState({ lastSection: { bot: 'owl', section: 'old' } })
  const view = await mount()
  close()
  await waitFor(() => expect(view.router.state.location.pathname).toBe('/b/owl/s/healthy'))
})
it('a second close wins when canonical lookups complete in reverse order', async () => {
  const first = deferred()
  let calls = 0
  call.mockImplementation((method: string) =>
    method === 'hexbot.sections.create' && ++calls === 1 ? first.promise : reply(method)
  )
  const view = await mount()
  close()
  await waitFor(() => expect(calls).toBe(1))
  close()
  await waitFor(() => expect(view.router.state.location.pathname).toBe('/b/owl/s/healthy'))
  await act(async () => first.resolve({ section: old }))
  expect(view.router.state.location.pathname).toBe('/b/owl/s/healthy')
})
it.each(['cancel', 'navigate'] as const)(
  'an older-daemon close chooser respects %s',
  async action => {
    useConnection.setState({ daemon: { one_chat: false } as unknown as DaemonInfo })
    const view = await mount()
    close()
    await screen.findByRole('dialog')

    if (action === 'cancel') {
      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape', code: 'Escape' })
    } else {
      await act(async () => {
        await view.router.navigate({ to: '/r/$room', params: { room: 'garden' } })
      })
    }

    await waitFor(() => expect(useSections.getState().choosing).toBeNull())
    expect(call.mock.calls.some(([method]) => method === 'hexbot.sections.unarchive')).toBe(false)
    expect(view.router.state.location.pathname).toBe(
      action === 'cancel' ? '/b/owl/settings/profile' : '/r/garden'
    )
  }
)
it('keeps settings open and reports an info error without creating a chat', async () => {
  useConnection.setState({ daemon: null })
  call.mockRejectedValue(new Error('Metadata unavailable'))
  const view = await mount()
  close()
  expect(await screen.findByRole('alert')).toHaveTextContent('Metadata unavailable')
  expect(view.router.state.location.pathname).toBe('/b/owl/settings/profile')
  expect(call.mock.calls.some(([method]) => method === 'hexbot.sections.create')).toBe(false)
})

it('closes a deleted bot without chat RPCs or a stale Home redirect', async () => {
  useBots.setState({ byName: {}, loaded: true })
  useUi.setState({ lastSection: { bot: 'owl', section: 'deleted-chat' } })
  call.mockRejectedValue(new Error('Bot not found'))
  const view = await mount()
  expect(await screen.findByText('This bot no longer exists.')).toBeVisible()
  close()
  await waitFor(() => expect(view.router.state.location.pathname).toBe('/onboarding'))
  expect(useUi.getState().lastSection).toBeNull()
  expect(call).not.toHaveBeenCalled()
})
it.each(['resolve', 'reject'] as const)(
  'deletion during held Close %s leaves through real Home policy',
  async result => {
    const held = deferred()
    call.mockImplementation((method: string) =>
      method === 'hexbot.sections.create' ? held.promise : reply(method)
    )
    useUi.setState({ lastSection: { bot: 'owl', section: 'deleted-chat' } })
    const view = await mount()
    close()
    await waitFor(() => expect(call).toHaveBeenCalledWith('hexbot.sections.create', { bot: 'owl' }))
    await act(async () => {
      useBots.setState({ byName: {}, loaded: true })
      held.resolve(
        result === 'resolve' ? { section: healthy } : Promise.reject(new Error('Bot not found'))
      )
    })
    await waitFor(() => expect(view.router.state.location.pathname).toBe('/onboarding'))
    expect(useUi.getState().lastSection).toBeNull()
    expect(call.mock.calls.some(([method]) => method === 'hexbot.sections.unarchive')).toBe(false)
  }
)
it.each(['room', 'unmount', 'daemon', 'epoch', 'install', 'same-url'] as const)(
  'a deleted-bot exit yields to later %s and preserves a newer remembered chat',
  async action => {
    const held = deferred()
    call.mockImplementation((method: string) =>
      method === 'hexbot.sections.create' ? held.promise : reply(method)
    )
    const view = await mount()
    close()
    await waitFor(() => expect(call).toHaveBeenCalledWith('hexbot.sections.create', { bot: 'owl' }))
    await act(async () => {
      useBots.setState({ byName: {}, loaded: true })

      if (action === 'room') {
        await view.router.navigate({ to: '/r/$room', params: { room: 'garden' } })
      }

      if (action === 'unmount') {
        view.unmount()
      }

      if (action === 'daemon') {
        useConnection.getState().setTarget({ kind: 'local', origin: 'http://other' })
      }

      if (action === 'epoch') {
        useConnection.getState().setEpoch('second')
      }

      if (action === 'install') {
        useConnection.setState({ daemon: { one_chat: true, install_id: 'other' } as DaemonInfo })
      }

      if (action === 'same-url') {
        view.router.history.push('/b/owl/settings/profile')
      }

      useUi.setState({ lastSection: { bot: 'yak', section: 'new-chat' } })
      held.resolve({ section: healthy })
    })
    expect(view.router.state.location.pathname).toBe(
      action === 'room' ? '/r/garden' : '/b/owl/settings/profile'
    )
    expect(useUi.getState().lastSection).toEqual({ bot: 'yak', section: 'new-chat' })
  }
)

it('keeps an unloaded roster distinct from a deleted bot on Close', async () => {
  useBots.setState({ byName: {}, loaded: false })
  const held = deferred()
  call.mockReturnValue(held.promise)
  const view = await mount()
  expect(await screen.findByText('Loading…')).toBeVisible()
  close()
  expect(view.router.state.location.pathname).toBe('/b/owl/settings/profile')
  expect(call.mock.calls.every(([method]) => method === 'hexbot.bots.list')).toBe(true)
  await act(async () => held.resolve({ bots: [] }))
  expect(await screen.findByText('This bot no longer exists.')).toBeVisible()
  close()
  await waitFor(() => expect(view.router.state.location.pathname).toBe('/onboarding'))
})
it('a deleted bot leaves a different remembered chat intact', async () => {
  useBots.setState({ byName: {}, loaded: true })
  const remembered = { bot: 'yak', section: 'yak-chat' }
  useUi.setState({ lastSection: remembered })
  const view = await mount()
  close()
  await waitFor(() => expect(view.router.state.location.pathname).toBe('/b/yak/s/yak-chat'))
  expect(useUi.getState().lastSection).toEqual(remembered)
  expect(call).not.toHaveBeenCalled()
})
it('a live bot Close reports a lookup error and can retry', async () => {
  call.mockRejectedValueOnce(new Error('Temporary canonical failure'))
  const view = await mount()
  close()
  expect(await screen.findByRole('alert')).toHaveTextContent('Temporary canonical failure')
  expect(view.router.state.location.pathname).toBe('/b/owl/settings/profile')
  close()
  await waitFor(() => expect(view.router.state.location.pathname).toBe('/b/owl/s/healthy'))
})
