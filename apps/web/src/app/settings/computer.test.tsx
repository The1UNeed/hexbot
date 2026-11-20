import { JsonRpcGatewayError } from '@hermes/shared'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, vi } from 'vitest'

import {
  computersForget,
  computersGrant,
  computersList,
  computersRemoveApp,
  computersSet,
  computerStatus,
  computerStep
} from '../../lib/api'
import type { Bot, Computer, ComputerStatus } from '../../lib/types'
import { useBots } from '../../stores/bots'
import { useComputer } from '../../stores/computer'
import { useComputers } from '../../stores/computers'
import { useConnection } from '../../stores/connection'

import { ComputerSettings } from './computer'

vi.mock('../../lib/api', async importOriginal => ({
  ...(await importOriginal()),
  computerConfigure: vi.fn(),
  computerStatus: vi.fn(),
  computerStep: vi.fn(),
  computersForget: vi.fn().mockResolvedValue({ ok: true }),
  computersGrant: vi.fn().mockResolvedValue({ ok: true }),
  computersList: vi.fn(),
  computersRemoveApp: vi.fn().mockResolvedValue({ ok: true }),
  computersSet: vi.fn()
}))

vi.mock('../../components/ui/confirm', () => ({ confirm: vi.fn().mockResolvedValue(true) }))

const status = (change: Partial<ComputerStatus> = {}): ComputerStatus => ({
  activity: null,
  actor: null,
  available: true,
  control: 'bot',
  cursors: [],
  error: null,
  size: 'small',
  sizes: [
    { cpu: 2, memory_gb: 4, name: 'small' },
    { cpu: 4, memory_gb: 8, name: 'medium' }
  ],
  state: 'stopped',
  ...change
})

const cap = (bots: string[], available = true) => ({ available, bots })

const computers = (
  change: Partial<Record<'device' | 'host' | 'vm', Partial<Computer>>> = {}
): Computer[] => [
  {
    apps: {},
    available: true,
    desktop: cap(['owl']),
    id: 'vm',
    kind: 'vm',
    name: "The bots' computer",
    on: true,
    online: true,
    os: 'Linux',
    terminal: cap(['owl']),
    ...change.vm
  },
  {
    apps: { owl: ['Safari'] },
    available: true,
    desktop: { ...cap([]), on: false, ready: false },
    id: 'host',
    kind: 'host',
    name: 'studio',
    on: true,
    online: true,
    os: 'macOS',
    terminal: { ...cap([]), sandboxed: true },
    ...change.host
  },
  {
    apps: {},
    available: false,
    desktop: cap([], false),
    id: 'device:mac',
    kind: 'device',
    name: 'MacBook',
    on: true,
    online: false,
    os: 'macOS',
    terminal: cap(['owl'], false),
    ...change.device
  }
]

const owl = { display_name: 'Owl', name: 'owl' } as Bot

describe('Settings, Computers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useComputer.setState({ error: null, status: null })
    useComputers.setState({
      answered: null,
      computers: null,
      error: null,
      listFailed: null,
      notices: [],
      older: false
    })
    useBots.setState({ byName: { owl }, order: ['owl'] })
    vi.mocked(computerStatus).mockResolvedValue(status())
    vi.mocked(computerStep).mockResolvedValue(status({ state: 'starting' }))
    vi.mocked(computersList).mockResolvedValue({ computers: computers() })
    vi.mocked(computersSet).mockResolvedValue({ computers: computers() })
  })

  it('lists every computer with its bots, and keeps the bots computer controls', async () => {
    render(<ComputerSettings />)
    expect(await screen.findByText('MacBook')).toBeInTheDocument()
    expect(screen.getByText('studio')).toBeInTheDocument()
    expect(screen.getByText('Offline')).toBeInTheDocument()
    expect(await screen.findByTestId('computer-state')).toHaveTextContent('Off')
    fireEvent.click(screen.getByRole('button', { name: 'Turn on' }))
    await waitFor(() => expect(computerStep).toHaveBeenCalledWith('start'))
    expect(
      screen.getByRole('switch', { name: "Terminal on The bots' computer for Owl" })
    ).toHaveAttribute('aria-checked', 'true')
  })

  it('gives and takes a computer from a bot', async () => {
    render(<ComputerSettings />)
    fireEvent.click(await screen.findByRole('switch', { name: 'Terminal on studio for Owl' }))
    await waitFor(() =>
      expect(computersGrant).toHaveBeenCalledWith('host', 'terminal', 'owl', true)
    )
    fireEvent.click(screen.getByRole('switch', { name: "Desktop on The bots' computer for Owl" }))
    await waitFor(() => expect(computersGrant).toHaveBeenCalledWith('vm', 'desktop', 'owl', false))
  })

  it('shares this desktop, takes back an always allowed app, and forgets a computer', async () => {
    render(<ComputerSettings />)
    fireEvent.click(await screen.findByRole('switch', { name: "Share studio's desktop with bots" }))
    await waitFor(() => expect(computersSet).toHaveBeenCalledWith('host', { desktop: true }))
    fireEvent.click(screen.getByRole('button', { name: 'Stop always allowing Safari' }))
    await waitFor(() => expect(computersRemoveApp).toHaveBeenCalledWith('host', 'owl', 'Safari'))
    fireEvent.click(screen.getByRole('button', { name: 'Forget…' }))
    await waitFor(() => expect(computersForget).toHaveBeenCalledWith('device:mac'))
  })

  it('names the computer above each of the user computers bot grid and its allowed apps', async () => {
    vi.mocked(computersList).mockResolvedValue({
      computers: computers({ device: { apps: { owl: ['Notes'] } } })
    })
    render(<ComputerSettings />)
    expect(await screen.findByText('Bots on MacBook')).toBeInTheDocument()
    expect(screen.getByText('Always allowed apps on MacBook')).toBeInTheDocument()
  })

  it('keeps the desktop switch while sharing is on and Cua is not ready, so it can be turned off', async () => {
    const allow = vi.fn(async () => ({
      desktop: false,
      desktopNote: 'Cua is not running.',
      desktopReady: false,
      name: 'mac',
      os: 'macOS',
      terminal: false
    }))

    ;(window as unknown as { hexbot: unknown }).hexbot = {
      computer: {
        allow,
        state: async () => ({
          desktop: true,
          desktopNote: 'Cua is not running.',
          desktopReady: false,
          name: 'mac',
          os: 'macOS',
          terminal: false
        })
      }
    }
    useConnection.setState({
      target: { deviceToken: 't', host: 'studio', kind: 'remote', port: 9119, tls: false }
    })

    try {
      render(<ComputerSettings />)

      const desktop = await screen.findByRole('switch', {
        name: "Let bots use this computer's desktop"
      })

      expect(desktop).toHaveAttribute('aria-checked', 'true')
      fireEvent.click(desktop)
      await waitFor(() => expect(allow).toHaveBeenCalledWith({ desktop: false }))
    } finally {
      delete (window as unknown as { hexbot?: unknown }).hexbot
      useConnection.setState({ target: null })
    }
  })

  it('turns the bots computer off', async () => {
    render(<ComputerSettings />)
    fireEvent.click(await screen.findByRole('switch', { name: "Use the bots' computer" }))
    await waitFor(() => expect(computersSet).toHaveBeenCalledWith('vm', { on: false }))
  })

  it('says how to set the bots computer up when Cua is missing', async () => {
    vi.mocked(computerStatus).mockResolvedValue(status({ available: false }))
    render(<ComputerSettings />)
    expect(await screen.findByText('uv tool install cua')).toBeInTheDocument()
  })

  it('keeps what to do when a forgotten computer did not confirm, through refreshes', async () => {
    vi.mocked(computersForget).mockResolvedValueOnce({
      note: "MacBook didn't confirm that bots stopped there.",
      ok: true,
      released: false
    })
    render(<ComputerSettings />)
    fireEvent.click(await screen.findByRole('button', { name: 'Forget…' }))
    expect(await screen.findByText(/didn't confirm/)).toBeInTheDocument()
    await useComputers.getState().refresh()
    expect(screen.getByText(/didn't confirm/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    await waitFor(() => expect(screen.queryByText(/didn't confirm/)).not.toBeInTheDocument())
  })

  it("shows no switch from before a reconnect until this connection's list answers", async () => {
    render(<ComputerSettings />)
    expect(
      await screen.findByRole('switch', { name: 'Terminal on studio for Owl' })
    ).toBeInTheDocument()

    // Back after a while away: the grants may have changed meanwhile.
    let answer: (value: { computers: Computer[] }) => void = () => {}

    vi.mocked(computersList).mockReturnValue(
      new Promise(resolve => {
        answer = resolve
      })
    )
    act(() => useConnection.setState(state => ({ connects: state.connects + 1 })))
    await waitFor(() =>
      expect(screen.queryByRole('switch', { name: 'Terminal on studio for Owl' })).toBeNull()
    )
    expect(screen.getByLabelText('Loading computers')).toBeInTheDocument()

    await act(async () => answer({ computers: computers() }))
    expect(
      await screen.findByRole('switch', { name: 'Terminal on studio for Owl' })
    ).toBeInTheDocument()
  })

  it("says why when a reconnect's list fails, and reads it again on Try again", async () => {
    render(<ComputerSettings />)
    expect(
      await screen.findByRole('switch', { name: 'Terminal on studio for Owl' })
    ).toBeInTheDocument()

    vi.mocked(computersList).mockRejectedValueOnce(new Error('The daemon is busy'))
    act(() => useConnection.setState(state => ({ connects: state.connects + 1 })))
    expect(await screen.findByRole('alert')).toHaveTextContent('The daemon is busy')
    expect(screen.queryByRole('switch', { name: 'Terminal on studio for Owl' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(
      await screen.findByRole('switch', { name: 'Terminal on studio for Owl' })
    ).toBeInTheDocument()
  })

  it("keeps the bots' computer controls on a daemon from before computers", async () => {
    vi.mocked(computersList).mockRejectedValue(
      new JsonRpcGatewayError('unknown method: hexbot.computers.list', { code: -32601 })
    )
    render(<ComputerSettings />)
    expect(await screen.findByTestId('computer-state')).toHaveTextContent('Off')
    expect(screen.getByText(/needs a newer Hexbot on the daemon's computer/)).toBeInTheDocument()
    expect(screen.queryByLabelText('Loading computers')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it("keeps each computer's unread notice through other Forgets, each until its own OK", async () => {
    const macbook = "MacBook didn't confirm that bots stopped there."
    const studio = "studio didn't confirm that bots stopped there."

    vi.mocked(computersForget)
      .mockResolvedValueOnce({ note: macbook, ok: true, released: false })
      .mockResolvedValueOnce({ ok: true, released: true })
      .mockResolvedValueOnce({ note: studio, ok: true, released: false })
    render(<ComputerSettings />)
    await screen.findByText('MacBook')
    await act(() => useComputers.getState().forget('device:mac'))
    // Another computer forgotten cleanly leaves the unread one.
    await act(() => useComputers.getState().forget('device:old'))
    expect(screen.getByText(macbook)).toBeInTheDocument()
    await act(() => useComputers.getState().forget('device:studio'))
    expect(screen.getByText(macbook)).toBeInTheDocument()
    expect(screen.getByText(studio)).toBeInTheDocument()

    fireEvent.click(screen.getAllByRole('button', { name: 'OK' })[0]!)
    await waitFor(() => expect(screen.queryByText(macbook)).toBeNull())
    expect(screen.getByText(studio)).toBeInTheDocument()
  })
})
