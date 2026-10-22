import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider
} from '@tanstack/react-router'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import { confirm } from '../components/ui/confirm'
import { useConnection } from '../stores/connection'
import { useUpdates } from '../stores/updates'

import { Route } from './__root'

const retryNow = vi.fn(() => Promise.resolve())

vi.mock('../app/chat-chooser', () => ({ ChatChooser: () => null }))
vi.mock('../lib/api', () => ({
  userMemoryGet: () => Promise.resolve({ updated_at: 'today' })
}))
vi.mock('../lib/bridge', () => ({
  getBridge: () => null,
  hasLocalRuntime: () => false
}))
vi.mock('../lib/connection', () => ({
  getSupervisor: () => ({ start: vi.fn(), stop: vi.fn(), retryNow }),
  setLocalDaemonPort: vi.fn()
}))

async function mount() {
  const root = createRootRoute({ component: Route.options.component as never })

  const bot = createRoute({
    getParentRoute: () => root,
    path: '/b/$bot/settings/$tab',
    component: () => <button>App content</button>
  })

  const settings = createRoute({
    getParentRoute: () => root,
    path: '/settings/$tab',
    component: () => <button>Settings content</button>
  })

  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ['/b/owl/settings/persona'] }),
    routeTree: root.addChildren([bot, settings])
  })

  await router.load()
  render(<RouterProvider router={router} />)
  await screen.findByRole('button', { name: 'App content' })

  return router
}

beforeEach(() => {
  retryNow.mockClear()
  useConnection.setState({
    status: 'connected',
    target: { kind: 'local' },
    daemon: null,
    epoch: 'first'
  })
  useUpdates.setState({ app: null })
})

function lock(kind: 'reconnect' | 'install') {
  if (kind === 'reconnect') {
    useConnection.setState({ status: 'reconnecting' })
  } else {
    useUpdates.setState({
      app: { status: 'installing', downloadedVersion: '0.1.6' } as never
    })
  }
}

it.each(['reconnect', 'install'] as const)(
  '%s cancels destructive confirmation and removes its focus trap',
  async kind => {
    await mount()
    const destroy = vi.fn()
    let answer!: Promise<boolean>
    act(() => {
      answer = confirm({ title: 'Delete the bot?', detail: 'Its history goes with it.' })
      void answer.then(yes => {
        if (yes) {
          destroy()
        }
      })
    })
    const confirmation = await screen.findByRole('alertdialog', { name: 'Delete the bot?' })
    const yes = within(confirmation).getByRole('button', { name: 'Yes' })

    act(() => lock(kind))

    expect(screen.queryByRole('alertdialog', { name: 'Delete the bot?', hidden: true })).toBeNull()
    expect(yes).not.toBeInTheDocument()
    await expect(answer).resolves.toBe(false)
    expect(destroy).not.toHaveBeenCalled()

    const overlay = screen.getByRole('alertdialog', {
      name: kind === 'reconnect' ? 'Connection lost' : 'Installing update'
    })

    expect(
      screen.getByRole('button', { name: 'App content', hidden: true }).parentElement
    ).toHaveAttribute('inert')

    // The old portalled modal must not pull keyboard focus behind the lock.
    overlay.tabIndex = -1
    act(() => overlay.focus())
    await waitFor(() => expect(overlay).toHaveFocus())

    if (kind === 'reconnect') {
      const retry = within(overlay).getByRole('button', { name: 'Reconnect now' })
      act(() => retry.focus())
      await waitFor(() => expect(retry).toHaveFocus())
      fireEvent.click(retry)
      expect(retryNow).toHaveBeenCalledOnce()
    }

    // Even a late request during a lock is cancelled, and never reappears.
    let late!: Promise<boolean>
    act(() => {
      late = confirm({ title: 'Delete another bot?' })
    })
    await expect(late).resolves.toBe(false)
    act(() => {
      useConnection.setState({ status: 'connected' })
      useUpdates.setState({ app: null })
    })
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(destroy).not.toHaveBeenCalled()
  }
)

it.each(['bot', 'page', 'target', 'epoch'] as const)(
  '%s changes cancel the old page action',
  async change => {
    const router = await mount()
    const saveSoul = vi.fn()
    let answer!: Promise<boolean>
    act(() => {
      answer = confirm({ title: 'Replace the soul with the Scout template?' })
      void answer.then(yes => {
        if (yes) {
          saveSoul()
        }
      })
    })
    await screen.findByRole('alertdialog')

    await act(async () => {
      if (change === 'bot') {
        await router.navigate({
          to: '/b/$bot/settings/$tab',
          params: { bot: 'yak', tab: 'persona' }
        })
      } else if (change === 'page') {
        await router.navigate({ to: '/settings/$tab', params: { tab: 'general' } })
      } else if (change === 'target') {
        useConnection.setState({ target: { kind: 'local', origin: 'http://other-daemon' } })
      } else {
        useConnection.setState({ epoch: 'second' })
      }
    })

    await expect(answer).resolves.toBe(false)
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(saveSoul).not.toHaveBeenCalled()

    // The new page/connection can still ask its own question.
    let current!: Promise<boolean>
    act(() => {
      current = confirm({ title: 'Replace this bot’s soul?' })
    })
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Yes' }))
    await expect(current).resolves.toBe(true)
    expect(saveSoul).not.toHaveBeenCalled()
  }
)
