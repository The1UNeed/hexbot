import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider
} from '@tanstack/react-router'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'

import { ChatChooser } from '../app/chat-chooser'
import type * as AvatarBuilder from '../lib/avatar-builder'
import { setActiveRpc } from '../lib/rpc'
import type { Bot, DaemonInfo, Section } from '../lib/types'
import { useBots } from '../stores/bots'
import { useConnection } from '../stores/connection'
import { useSections } from '../stores/sections'
import { useUi } from '../stores/ui'

import { Route } from './onboarding'

import { Route as HomeRoute } from './index'

const avatar = vi.hoisted(() => vi.fn(async () => null as string | null))
vi.mock('../lib/avatar-builder', async original => ({
  ...(await original<typeof AvatarBuilder>()),
  avatarPng: avatar
}))

const bot = { name: 'owl', display_name: 'Owl', sections_recent: [] } as unknown as Bot
const section = (id: string) => ({ id, bot: 'owl', title: id, message_count: 2 }) as Section
const canonical = section('canonical')
const remembered = { bot: 'owl', section: 'remembered' }

const deferred = () => {
  let resolve!: (value: unknown) => void
  let reject!: (reason: Error) => void

  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })

  return { promise, resolve, reject }
}

let call: ReturnType<typeof vi.fn>
let existing = true

const reply = (method: string) =>
  Promise.resolve(
    {
      'hexbot.bots.list': { bots: existing ? [bot] : [] },
      'hexbot.memory.user.get': { text: 'Alex', updated_at: 1 },
      'hexbot.sections.create': { section: canonical },
      'hexbot.sections.list': { sections: [section('legacy-a'), section('legacy-b')] },
      'hexbot.sections.unarchive': { section: section('legacy-b') },
      'hexbot.providers.list': {
        providers: [{ id: 'lmstudio', label: 'Local', configured: true }]
      },
      'hexbot.models.list': { all: [{ id: 'local-model', label: 'Local model' }], curated: [] },
      'hexbot.settings.get': { default_model: 'lmstudio/local-model', usage_data: false },
      'hexbot.connectors.list': { connectors: [] },
      'hexbot.bots.create_primary': { bot, section: canonical }
    }[method] ?? {}
  )

beforeEach(() => {
  existing = true
  useBots.setState({ byName: { owl: bot }, order: ['owl'], loaded: true })
  useUi.setState({ lastSection: remembered })
  useSections.setState({ choosing: null, byId: {}, idsByBot: {} })
  useConnection.setState({
    target: { kind: 'local' },
    status: 'connected',
    epoch: 'first',
    daemon: { one_chat: true, install_id: 'first' } as DaemonInfo
  })
  call = vi.fn(reply)
  setActiveRpc({ call } as never)
  avatar.mockReset().mockResolvedValue(null)
})
afterEach(() => setActiveRpc(null))

async function mount(strict = false) {
  const root = createRootRoute({
    component: () => (
      <>
        <ChatChooser />
        <Outlet />
      </>
    )
  })

  const onboarding = createRoute({
    getParentRoute: () => root,
    path: '/onboarding',
    component: Route.options.component as never
  })

  const home = createRoute({
    getParentRoute: () => root,
    path: '/',
    beforeLoad: HomeRoute.options.beforeLoad
  })

  const chat = createRoute({
    getParentRoute: () => root,
    path: '/b/$bot/s/$section',
    component: () => <p>Owner chat</p>
  })

  const room = createRoute({
    getParentRoute: () => root,
    path: '/r/$room',
    component: () => <p>Garden room</p>
  })

  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ['/onboarding'] }),
    routeTree: root.addChildren([home, onboarding, chat, room])
  })

  await router.load()

  return {
    ...render(
      strict ? (
        <StrictMode>
          <RouterProvider router={router} />
        </StrictMode>
      ) : (
        <RouterProvider router={router} />
      )
    ),
    router
  }
}

it.each(['room', 'unmount', 'daemon', 'epoch', 'install', 'capability', 'same-url'] as const)(
  'onboarding canonical completion yields to later %s',
  async action => {
    const held = deferred()
    call.mockImplementation((method: string) =>
      method === 'hexbot.sections.create' ? held.promise : reply(method)
    )
    const view = await mount()
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

      if (action === 'install') {
        useConnection.setState({ daemon: { one_chat: true, install_id: 'second' } as DaemonInfo })
      }

      if (action === 'capability') {
        useConnection.setState({ daemon: null })
      }

      if (action === 'same-url') {
        view.router.history.push('/onboarding')
      }

      useUi.setState({ lastSection: { bot: 'yak', section: 'new-intent' } })
      held.resolve({ section: canonical })
    })
    expect(view.router.state.location.pathname).toBe(
      action === 'room' ? '/r/garden' : '/onboarding'
    )
    expect(useUi.getState().lastSection).toEqual({ bot: 'yak', section: 'new-intent' })
  }
)
it.each(['info', 'legacy-list', 'initial-list'] as const)(
  'leaving during %s prevents later chat writes and remembered selection',
  async boundary => {
    if (boundary === 'info') {
      useConnection.setState({ daemon: null })
    }

    if (boundary === 'legacy-list') {
      useConnection.setState({ daemon: { one_chat: false } as unknown as DaemonInfo })
      useUi.setState({ lastSection: null })
    }

    const method =
      boundary === 'info'
        ? 'hexbot.info'
        : boundary === 'legacy-list'
          ? 'hexbot.sections.list'
          : 'hexbot.bots.list'

    const held = deferred()
    call.mockImplementation((name: string) => (name === method ? held.promise : reply(name)))
    const view = await mount()
    await waitFor(() => expect(call.mock.calls.some(([name]) => name === method)).toBe(true))
    await act(async () => {
      await view.router.navigate({ to: '/r/$room', params: { room: 'garden' } })
    })
    await act(async () => {
      held.resolve(
        boundary === 'info'
          ? { one_chat: true }
          : boundary === 'legacy-list'
            ? { sections: [] }
            : { bots: [bot] }
      )
    })
    expect(view.router.state.location.pathname).toBe('/r/garden')
    expect(
      call.mock.calls.some(
        ([name]) => name === 'hexbot.sections.create' || name === 'hexbot.sections.unarchive'
      )
    ).toBe(false)
  }
)
it('healthy onboarding resolves before remembering and real Home restores that canonical route', async () => {
  const view = await mount()
  await screen.findByText('Owner chat')
  expect(view.router.state.location.pathname).toBe('/b/owl/s/canonical')
  expect(useUi.getState().lastSection).toEqual({ bot: 'owl', section: 'canonical' })
  await act(async () => {
    await view.router.navigate({ to: '/' })
  })
  expect(view.router.state.location.pathname).toBe('/b/owl/s/canonical')
})
it('Continue retries once and a pending retry cannot hijack a later room', async () => {
  const held = deferred()
  let attempts = 0
  call.mockImplementation((method: string) =>
    method === 'hexbot.sections.create'
      ? ++attempts === 1
        ? Promise.reject(new Error('Canonical unavailable'))
        : held.promise
      : reply(method)
  )
  const view = await mount()
  expect(await screen.findByRole('alert')).toHaveTextContent('Canonical unavailable')
  const button = screen.getByRole('button', { name: 'Continue' })
  fireEvent.click(button)
  fireEvent.click(button)
  await waitFor(() => expect(attempts).toBe(2))
  expect(button).toBeDisabled()
  await act(async () => {
    await view.router.navigate({ to: '/r/$room', params: { room: 'garden' } })
    held.resolve({ section: canonical })
  })
  expect(view.router.state.location.pathname).toBe('/r/garden')
  expect(useUi.getState().lastSection).toEqual(remembered)
})
it('legacy Escape leaves Continue usable and saves a later explicit choice', async () => {
  useUi.setState({ lastSection: null })
  useConnection.setState({ daemon: { one_chat: false } as unknown as DaemonInfo })
  const view = await mount()
  fireEvent.keyDown(await screen.findByRole('dialog'), { key: 'Escape' })
  expect(await screen.findByRole('button', { name: 'Continue' })).toBeEnabled()
  expect(useUi.getState().lastSection).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  fireEvent.click(await screen.findByRole('button', { name: /legacy-b/ }))
  await screen.findByText('Owner chat')
  expect(view.router.state.location.pathname).toBe('/b/owl/s/legacy-b')
  expect(call).toHaveBeenCalledWith('hexbot.sections.unarchive', { id: 'legacy-b' })
  expect(useUi.getState().lastSection).toEqual({ bot: 'owl', section: 'legacy-b' })
  expect(call.mock.calls.some(([method]) => method === 'hexbot.sections.create')).toBe(false)
})

async function firstBot() {
  existing = false
  useBots.setState({ byName: {}, order: [], loaded: true })
  useUi.setState({ lastSection: null })
  const view = await mount()
  fireEvent.click(await screen.findByRole('button', { name: /Get started/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Next' }))
  fireEvent.click(screen.getByRole('button', { name: 'Next' }))
  const providers = await screen.findByRole('button', { name: 'Continue' })
  await waitFor(() => expect(providers).toBeEnabled())
  fireEvent.click(providers)
  const defaults = await screen.findByTestId('onboarding-defaults-continue')
  await waitFor(() => expect(defaults).toBeEnabled())
  fireEvent.click(defaults)
  fireEvent.click(await screen.findByTestId('onboarding-tools-continue'))
  await screen.findByTestId('onboarding-usage-continue')

  return view
}

/** The usage data step's Continue creates HexBot. */
const createHexBot = () => fireEvent.click(screen.getByTestId('onboarding-usage-continue'))

it.each(['healthy', 'room', 'unmount', 'daemon', 'epoch', 'install', 'avatar'] as const)(
  'HexBot creation keeps its caller lifetime: %s',
  async action => {
    const view = await firstBot()
    const held = deferred()

    if (action === 'avatar') {
      avatar.mockImplementationOnce(() => held.promise as Promise<null>)
    } else {
      call.mockImplementation((method: string) =>
        method === 'hexbot.bots.create_primary' ? held.promise : reply(method)
      )
    }

    createHexBot()

    if (action !== 'avatar') {
      await waitFor(() =>
        expect(
          call.mock.calls.filter(([method]) => method === 'hexbot.bots.create_primary')
        ).toHaveLength(1)
      )
    }

    await act(async () => {
      if (action === 'room' || action === 'avatar') {
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
        useConnection.setState({ daemon: { one_chat: true, install_id: 'second' } as DaemonInfo })
      }

      held.resolve(action === 'avatar' ? null : { bot, section: canonical })
    })

    if (action === 'healthy') {
      await screen.findByText('Owner chat')
      expect(useUi.getState().lastSection).toEqual({ bot: 'owl', section: 'canonical' })
      expect(call).toHaveBeenCalledWith('hexbot.bots.introduce', {
        name: 'owl',
        section: 'canonical'
      })
    } else {
      expect(view.router.state.location.pathname).toBe(
        action === 'room' || action === 'avatar' ? '/r/garden' : '/onboarding'
      )
      expect(useUi.getState().lastSection).toBeNull()
      expect(call.mock.calls.some(([method]) => method === 'hexbot.bots.introduce')).toBe(false)

      if (action === 'avatar') {
        expect(call.mock.calls.some(([method]) => method === 'hexbot.bots.create_primary')).toBe(
          false
        )
      }
    }
  }
)

it('React Strict Mode keeps a healthy initial decision and creates only its canonical lookup', async () => {
  const view = await mount(true)
  await screen.findByText('Owner chat')
  expect(view.router.state.location.pathname).toBe('/b/owl/s/canonical')
  expect(call.mock.calls.filter(([method]) => method === 'hexbot.sections.create')).toHaveLength(1)
})
it.each(['healthy', 'room'] as const)(
  'About you completion keeps the onboarding decision: %s',
  async action => {
    const held = deferred()
    call.mockImplementation((method: string) =>
      method === 'hexbot.memory.user.get'
        ? Promise.resolve({ text: '', updated_at: null })
        : method === 'hexbot.memory.user.set'
          ? held.promise
          : reply(method)
    )
    const view = await mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Skip' }))
    await waitFor(() => expect(call).toHaveBeenCalledWith('hexbot.memory.user.set', { text: '' }))

    if (action === 'room') {
      await act(async () => {
        await view.router.navigate({ to: '/r/$room', params: { room: 'garden' } })
      })
    }

    await act(async () => {
      held.resolve({ text: '', updated_at: 1 })
    })

    if (action === 'healthy') {
      await screen.findByText('Owner chat')
      expect(view.router.state.location.pathname).toBe('/b/owl/s/canonical')
    } else {
      expect(view.router.state.location.pathname).toBe('/r/garden')
      expect(call.mock.calls.some(([method]) => method === 'hexbot.sections.create')).toBe(false)
    }
  }
)
it('duplicate HexBot clicks make one request, and a creation error permits a healthy retry', async () => {
  const view = await firstBot()
  const held = deferred()
  call.mockImplementation((method: string) =>
    method === 'hexbot.bots.create_primary' ? held.promise : reply(method)
  )
  const button = screen.getByTestId('onboarding-usage-continue')
  await act(async () => {
    fireEvent.click(button)
    fireEvent.click(button)
  })
  expect(
    call.mock.calls.filter(([method]) => method === 'hexbot.bots.create_primary')
  ).toHaveLength(1)
  await act(async () => {
    held.reject(new Error('Creation unavailable'))
  })
  expect(await screen.findByRole('alert')).toHaveTextContent('Creation unavailable')
  expect(useUi.getState().lastSection).toBeNull()
  call.mockImplementation(reply)
  createHexBot()
  await screen.findByText('Owner chat')
  expect(view.router.state.location.pathname).toBe('/b/owl/s/canonical')
  expect(call.mock.calls.filter(([method]) => method === 'hexbot.bots.introduce')).toHaveLength(1)
})

it.each(['chooser', 'unarchive'] as const)(
  'a later room cancels onboarding at the legacy %s boundary',
  async boundary => {
    useUi.setState({ lastSection: null })
    useConnection.setState({ daemon: { one_chat: false } as unknown as DaemonInfo })
    const held = deferred()
    call.mockImplementation((method: string) =>
      method === 'hexbot.sections.list'
        ? Promise.resolve({ sections: [section('another-a'), section('another-b')] })
        : method === 'hexbot.sections.unarchive'
          ? held.promise
          : reply(method)
    )
    const view = await mount()
    await screen.findByRole('dialog')
    const obsolete = useSections.getState().choosing!

    if (boundary === 'unarchive') {
      fireEvent.click(screen.getByRole('button', { name: /another-b/ }))
      await waitFor(() =>
        expect(call).toHaveBeenCalledWith('hexbot.sections.unarchive', { id: 'another-b' })
      )
    }

    await act(async () => {
      await view.router.navigate({ to: '/r/$room', params: { room: 'garden' } })

      if (boundary === 'chooser') {
        obsolete.pick(section('another-b'))
      }

      held.resolve({ section: section('another-b') })
    })
    expect(view.router.state.location.pathname).toBe('/r/garden')
    expect(useUi.getState().lastSection).toBeNull()
    expect(useSections.getState().choosing).toBeNull()

    if (boundary === 'chooser') {
      expect(call.mock.calls.some(([method]) => method === 'hexbot.sections.unarchive')).toBe(false)
    }

    expect(call.mock.calls.some(([method]) => method === 'hexbot.sections.create')).toBe(false)
  }
)

it.each([false, true])(
  'initial info hydration completes the same visit in Strict Mode=%s',
  async strict => {
    useConnection.setState({ daemon: null })
    const held = deferred()
    call.mockImplementation((method: string) =>
      method === 'hexbot.memory.user.get' ? held.promise : reply(method)
    )
    const view = await mount(strict)
    await waitFor(() => expect(call).toHaveBeenCalledWith('hexbot.memory.user.get', {}))
    await act(async () => {
      useConnection.getState().setDaemon({ one_chat: true, install_id: 'first' } as DaemonInfo)
      held.resolve({ text: 'Alex', updated_at: 1 })
    })
    await screen.findByText('Owner chat')
    expect(view.router.state.location.pathname).toBe('/b/owl/s/canonical')
    expect(call.mock.calls.filter(([name]) => name === 'hexbot.sections.create')).toHaveLength(1)
  }
)

it.each([
  'room',
  'same-url',
  'unmount',
  'daemon',
  'epoch',
  'install',
  'capability',
  'capability-blip',
  'install-roundtrip',
  'target-roundtrip',
  'epoch-roundtrip'
] as const)('initial hydration cannot revive a decision superseded by %s', async action => {
  useConnection.setState({ daemon: null })
  const held = deferred()
  call.mockImplementation((method: string) =>
    method === 'hexbot.memory.user.get' ? held.promise : reply(method)
  )
  const view = await mount()
  await waitFor(() => expect(call).toHaveBeenCalledWith('hexbot.memory.user.get', {}))
  const target = useConnection.getState().target
  await act(async () => {
    if (action === 'room') {
      await view.router.navigate({ to: '/r/$room', params: { room: 'garden' } })
    }

    if (action === 'same-url') {
      view.router.history.push('/onboarding')
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

    useConnection.getState().setDaemon({ one_chat: true, install_id: 'first' } as DaemonInfo)

    if (action === 'install') {
      useConnection.getState().setDaemon({ one_chat: true, install_id: 'second' } as DaemonInfo)
    }

    if (action === 'capability') {
      useConnection
        .getState()
        .setDaemon({ one_chat: false, install_id: 'first' } as unknown as DaemonInfo)
    }

    if (action === 'capability-blip') {
      useConnection.getState().setDaemon(null)
      useConnection.getState().setDaemon({ one_chat: true, install_id: 'first' } as DaemonInfo)
    }

    if (action === 'install-roundtrip') {
      useConnection.getState().setDaemon({ one_chat: true, install_id: 'second' } as DaemonInfo)
      useConnection.getState().setDaemon({ one_chat: true, install_id: 'first' } as DaemonInfo)
    }

    if (action === 'target-roundtrip') {
      useConnection.getState().setTarget({ kind: 'local', origin: 'http://other' })
      useConnection.getState().setTarget(target)
      useConnection.getState().setEpoch('first')
      useConnection.getState().setDaemon({ one_chat: true, install_id: 'first' } as DaemonInfo)
    }

    if (action === 'epoch-roundtrip') {
      useConnection.getState().setEpoch('second')
      useConnection.getState().setEpoch('first')
      useConnection.getState().setDaemon({ one_chat: true, install_id: 'first' } as DaemonInfo)
    }

    useUi.setState({ lastSection: { bot: 'yak', section: 'new-intent' } })
    held.resolve({ text: 'Alex', updated_at: 1 })
  })
  expect(view.router.state.location.pathname).toBe(action === 'room' ? '/r/garden' : '/onboarding')
  expect(useUi.getState().lastSection).toEqual({ bot: 'yak', section: 'new-intent' })
  expect(call.mock.calls.some(([name]) => name === 'hexbot.sections.create')).toBe(false)
  expect(useSections.getState().choosing).toBeNull()
})

it.each([false, true])(
  'initial hydration preserves About you and its completion, existing bots=%s',
  async hasBots => {
    existing = hasBots
    useBots.setState({ byName: hasBots ? { owl: bot } : {}, order: hasBots ? ['owl'] : [] })
    useConnection.setState({ daemon: null })
    call.mockImplementation((method: string) =>
      method === 'hexbot.memory.user.get'
        ? Promise.resolve({ text: '', updated_at: null })
        : reply(method)
    )
    const view = await mount()

    if (!hasBots) {
      fireEvent.click(await screen.findByRole('button', { name: /Get started/ }))
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    }

    fireEvent.change(await screen.findByLabelText('Your name'), { target: { value: 'Alex' } })
    await act(async () => {
      useConnection.getState().setDaemon({ one_chat: true, install_id: 'first' } as DaemonInfo)
      useBots.setState({ byName: { owl: bot }, order: ['owl'] })
    })
    expect(screen.getByLabelText('Your name')).toHaveValue('Alex')
    expect(call.mock.calls.filter(([name]) => name === 'hexbot.memory.user.get')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    if (hasBots) {
      await screen.findByText('Owner chat')
      expect(view.router.state.location.pathname).toBe('/b/owl/s/canonical')
    } else {
      expect(await screen.findByRole('heading', { name: 'Connect a provider' })).toBeVisible()
      expect(call.mock.calls.some(([name]) => name === 'hexbot.sections.create')).toBe(false)
    }
  }
)

it('a roster refresh during HexBot creation does not repeat the completed decision', async () => {
  const view = await firstBot()
  const held = deferred()
  call.mockImplementation((method: string) =>
    method === 'hexbot.bots.create_primary' ? held.promise : reply(method)
  )
  createHexBot()
  await waitFor(() =>
    expect(call).toHaveBeenCalledWith('hexbot.bots.create_primary', expect.anything())
  )
  await act(async () => {
    useBots.setState({ byName: { owl: bot }, order: ['owl'] })
  })
  expect(call.mock.calls.filter(([name]) => name === 'hexbot.memory.user.get')).toHaveLength(1)
  await act(async () => held.resolve({ bot, section: canonical }))
  await screen.findByText('Owner chat')
  expect(view.router.state.location.pathname).toBe('/b/owl/s/canonical')
  expect(call.mock.calls.filter(([name]) => name === 'hexbot.bots.introduce')).toHaveLength(1)
})
