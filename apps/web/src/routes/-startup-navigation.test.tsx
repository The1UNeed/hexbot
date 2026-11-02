import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider
} from '@tanstack/react-router'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

import type * as Connection from '../lib/connection'
import type { ConnectionTarget } from '../lib/types'
import { useConnection } from '../stores/connection'
import { useUi } from '../stores/ui'
import { useUpdates } from '../stores/updates'

import { Route as RootRoute } from './__root'
import { Route as ConnectRoute } from './connect'
import { Route as OnboardingRoute } from './onboarding'

import { Route as HomeRoute } from './index'

const supervisor = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn() }))
vi.mock('../lib/connection', async original => ({
  ...(await original<typeof Connection>()),
  getSupervisor: () => supervisor
}))
vi.mock('../app/chat-chooser', () => ({ ChatChooser: () => null }))

const remembered = { bot: 'owl', section: 'remembered' }
const appPage = vi.fn(() => <p>Conversation content</p>)

beforeEach(() => {
  localStorage.clear()
  delete window.hexbot
  vi.clearAllMocks()
  useUi.setState({ lastSection: remembered })
  useConnection.setState({
    target: null,
    status: 'idle',
    daemon: null,
    epoch: null,
    error: null,
    proofError: null
  })
  useUpdates.setState({ app: null })
})
afterEach(() => {
  delete window.hexbot
})

function surface(edition: 'browser' | 'client' | 'full') {
  if (edition !== 'browser') {
    window.hexbot = {
      edition,
      platform: 'darwin',
      daemon: { start: vi.fn(async () => ({ port: 9119 })) },
      updater: { onStatus: () => () => undefined, state: async () => null }
    } as unknown as Window['hexbot']
  }
}

async function mount(path: string) {
  const root = createRootRoute({ component: RootRoute.options.component as never })

  const home = createRoute({
    getParentRoute: () => root,
    path: '/',
    beforeLoad: HomeRoute.options.beforeLoad
  })

  const onboarding = createRoute({
    getParentRoute: () => root,
    path: '/onboarding',
    component: OnboardingRoute.options.component as never
  })

  const connect = createRoute({
    getParentRoute: () => root,
    path: '/connect',
    component: ConnectRoute.options.component as never
  })

  const pages = ['/b/$bot/s/$section', '/r/$room', '/settings/$tab'].map(path =>
    createRoute({ getParentRoute: () => root, path, component: appPage })
  )

  const router = createRouter({
    history: createMemoryHistory({ initialEntries: [path] }),
    routeTree: root.addChildren([home, onboarding, connect, ...pages])
  })

  await router.load()
  render(<RouterProvider router={router} />)

  return router
}

describe.each(['browser', 'client', 'full'] as const)('%s without a saved connection', edition => {
  beforeEach(() => surface(edition))

  it.each(['/', '/b/owl/s/remembered', '/r/garden', '/settings/providers'])(
    'recovers from %s without mounting a disconnected app page',
    async path => {
      const router = await mount(path)

      if (edition === 'full') {
        expect(await screen.findByRole('button', { name: 'Get started' })).toBeVisible()
      } else {
        expect(
          await screen.findByRole('button', { name: 'Sign in with Hex Connect' })
        ).toBeVisible()
      }

      expect(router.state.location.pathname).toBe(edition === 'full' ? '/onboarding' : '/connect')
      expect(appPage).not.toHaveBeenCalled()
      expect(supervisor.start).not.toHaveBeenCalled()
      expect(useUi.getState().lastSection).toEqual(remembered)
    }
  )

  it('leaves pairing links on the connect screen', async () => {
    const router = await mount('/connect?host=studio&port=9119&code=PAIR')

    expect(await screen.findByRole('button', { name: 'Sign in with Hex Connect' })).toBeVisible()
    expect(router.state.location.searchStr).toBe('?host=studio&port=9119&code=PAIR')
  })
})

it.each<ConnectionTarget>([
  { kind: 'local' },
  { kind: 'remote', host: 'studio', port: 9119, deviceToken: 'token', tls: false }
])('restores the remembered chat when the target is %j', async target => {
  surface('full')
  useConnection.setState({ target })
  const router = await mount('/')

  expect(await screen.findByText('Conversation content')).toBeVisible()
  expect(router.state.location.pathname).toBe('/b/owl/s/remembered')
  await waitFor(() => expect(supervisor.start).toHaveBeenCalledWith(target))
})

it('keeps local daemon setup available in Full after recovering a remembered chat', async () => {
  surface('full')
  await mount('/')
  fireEvent.click(await screen.findByRole('button', { name: 'Get started' }))
  fireEvent.click(screen.getByRole('button', { name: 'Next' }))
  fireEvent.click(screen.getByRole('button', { name: 'Next' }))

  expect(await screen.findByRole('button', { name: 'On this computer' })).toBeVisible()
  expect(screen.getByRole('button', { name: 'On another device' })).toBeVisible()
  expect(useUi.getState().lastSection).toEqual(remembered)
})

it('returns a revoked Full app to pairing instead of local setup', async () => {
  surface('full')
  useConnection.setState({ status: 'unauthorized' })
  const router = await mount('/b/owl/s/remembered')

  expect(await screen.findByRole('button', { name: 'Sign in with Hex Connect' })).toBeVisible()
  expect(router.state.location.pathname).toBe('/connect')
  expect(appPage).not.toHaveBeenCalled()
})

it('recovers when the connection target is cleared while a chat is open', async () => {
  useConnection.setState({ target: { kind: 'local' } })
  const router = await mount('/b/owl/s/remembered')
  await screen.findByText('Conversation content')
  await act(async () => useConnection.getState().clearTarget())

  expect(await screen.findByRole('button', { name: 'Sign in with Hex Connect' })).toBeVisible()
  expect(router.state.location.pathname).toBe('/connect')
  expect(screen.queryByText('Conversation content')).not.toBeInTheDocument()
})
