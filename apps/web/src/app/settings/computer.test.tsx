import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, vi } from 'vitest'

import { computersConfigure, computersList, computerStatus, computerStep } from '../../lib/api'
import type { ComputersList, ComputerStatus } from '../../lib/types'
import { useBots } from '../../stores/bots'
import { useComputer } from '../../stores/computer'
import { useComputers } from '../../stores/computers'

import { ComputerSettings } from './computer'

vi.mock('../../lib/api', async importOriginal => ({
  ...(await importOriginal()),
  computerConfigure: vi.fn(),
  computersConfigure: vi.fn(),
  computersForBot: vi.fn().mockResolvedValue({ bot: 'owl', computers: [] }),
  computersList: vi.fn(),
  computerStatus: vi.fn(),
  computerStep: vi.fn()
}))

const computers = (choice: ComputersList['choice'] = 'both'): ComputersList => ({
  choice,
  computers: [
    {
      asks: false,
      bots: ['owl'],
      id: 'bots',
      kind: 'bots',
      limited: false,
      name: "Bots' computer",
      on: choice === 'both' || choice === 'bots',
      online: true,
      os: 'Linux',
      ready: true,
      screen: true
    },
    {
      asks: true,
      bots: [],
      id: 'daemon',
      kind: 'daemon',
      limited: choice === 'none',
      name: 'Studio',
      on: choice !== 'bots',
      online: true,
      os: 'macOS',
      ready: true,
      screen: false
    }
  ]
})

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

describe('Settings, Manuals, Computers', () => {
  beforeEach(() => {
    useComputer.setState({ error: null, status: null })
    useComputers.setState({ byBot: {}, error: null, list: null })
    useBots.setState({
      byName: { owl: { display_name: 'Owl', name: 'owl' } as never },
      order: ['owl']
    })
    vi.mocked(computerStep).mockResolvedValue(status({ state: 'starting' }))
    vi.mocked(computersList).mockResolvedValue(computers())
  })

  it('offers the four choices, naming the daemon, and saves one', async () => {
    vi.mocked(computerStatus).mockResolvedValue(status())
    vi.mocked(computersConfigure).mockResolvedValue(computers('none'))
    render(<ComputerSettings />)
    const group = await screen.findByRole('radiogroup', { name: 'Where bots work' })
    const choices = within(group).getAllByRole('radio')
    expect(choices.map(choice => choice.textContent)).toEqual([
      expect.stringContaining("Bots' computer and yours"),
      expect.stringContaining("Bots' computer only"),
      expect.stringContaining('Your computer only'),
      expect.stringContaining('Neither')
    ])
    expect(choices[0]).toHaveAttribute('aria-checked', 'true')
    expect(choices[0]).toHaveTextContent('run commands on Studio')
    // The daemon keeps the choice; the reload after saving reads it back.
    vi.mocked(computersList).mockResolvedValue(computers('none'))
    fireEvent.click(choices[3]!)
    await waitFor(() => expect(computersConfigure).toHaveBeenCalledWith({ choice: 'none' }))
    expect(
      await screen.findByText('Commands stay in the workspace sandbox, in every approval mode.')
    ).toBeInTheDocument()
  })

  it('lets each bot use each computer or not', async () => {
    vi.mocked(computerStatus).mockResolvedValue(status())
    vi.mocked(computersConfigure).mockResolvedValue(computers())
    render(<ComputerSettings />)
    const onBots = await screen.findByRole('switch', { name: "Owl uses Bots' computer" })
    const onDaemon = screen.getByRole('switch', { name: 'Owl uses Studio' })
    expect(onBots).toHaveAttribute('aria-checked', 'true')
    expect(onDaemon).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(onDaemon)
    await waitFor(() =>
      expect(computersConfigure).toHaveBeenCalledWith({
        allowed: true,
        bot: 'owl',
        computer: 'daemon'
      })
    )
  })

  it('picks the bots that may use the daemon\'s screen, apart from its terminal', async () => {
    vi.mocked(computerStatus).mockResolvedValue(status())
    vi.mocked(computersConfigure).mockResolvedValue(computers())
    render(<ComputerSettings />)

    const screenSwitch = await screen.findByRole('switch', {
      name: 'Owl uses the screen of Studio'
    })

    expect(screenSwitch).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByText(/never click or type in Hexbot/)).toBeInTheDocument()
    fireEvent.click(screenSwitch)
    await waitFor(() =>
      expect(computersConfigure).toHaveBeenCalledWith({
        bot: 'owl',
        computer: 'daemon',
        screen: true
      })
    )
  })

  it('lends this computer from the app on it, and lists computers other apps lent', async () => {
    const lent = { cua: true, name: 'Laptop', on: false, os: 'macOS', sandbox: true, screen: false }
    const set = vi.fn().mockResolvedValue({ ...lent, on: true })
    window.hexbot = {
      computer: { run: vi.fn(), set, state: vi.fn().mockResolvedValue(lent) }
    } as never
    const withLaptop = computers()
    withLaptop.computers.push({
      asks: true,
      bots: [],
      id: 'app-1f2e3d4c',
      kind: 'device',
      lends_screen: true,
      limited: false,
      name: 'Studio Air',
      online: false,
      os: 'macOS',
      ready: false,
      screen: false,
      screen_bots: []
    })
    vi.mocked(computersList).mockResolvedValue(withLaptop)
    vi.mocked(computerStatus).mockResolvedValue(status())
    render(<ComputerSettings />)
    fireEvent.click(await screen.findByRole('switch', { name: 'Let bots use this computer' }))
    await waitFor(() => expect(set).toHaveBeenCalledWith({ on: true, screen: false }))
    expect(await screen.findByRole('switch', { name: 'Its screen too' })).toBeInTheDocument()
    expect(screen.getByText(/Offline: the Hexbot app there is closed/)).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Owl uses Studio Air' })).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Owl uses the screen of Studio Air' })).toBeInTheDocument()
    delete window.hexbot
  })

  it('hides the daemon\'s bots when only the bots\' computer is chosen', async () => {
    vi.mocked(computerStatus).mockResolvedValue(status())
    vi.mocked(computersList).mockResolvedValue(computers('bots'))
    render(<ComputerSettings />)
    expect(await screen.findByText("Off. Bots don't run anything here.")).toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: 'Owl uses Studio' })).not.toBeInTheDocument()
    expect(
      screen.queryByRole('switch', { name: 'Owl uses the screen of Studio' })
    ).not.toBeInTheDocument()
  })

  it('says what bots do on their computer and turns it on', async () => {
    vi.mocked(computerStatus).mockResolvedValue(status())
    render(<ComputerSettings />)
    expect(await screen.findByTestId('computer-state')).toHaveTextContent('Off')

    for (const use of ['Code execution', 'Browser', 'Desktop']) {
      expect(screen.getByText(use)).toBeInTheDocument()
    }

    expect(screen.getByText('Size')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Turn on' }))
    await waitFor(() => expect(computerStep).toHaveBeenCalledWith('start'))
  })

  it('resets after asking', async () => {
    vi.mocked(computerStatus).mockResolvedValue(status({ state: 'running' }))
    render(<ComputerSettings />)
    fireEvent.click(await screen.findByRole('button', { name: 'Reset…' }))
    await waitFor(() => expect(computerStep).toHaveBeenCalledWith('reset'))
  })

  it('says how to set it up when Cua is missing', async () => {
    vi.mocked(computerStatus).mockResolvedValue(status({ available: false }))
    render(<ComputerSettings />)
    expect(await screen.findByText('uv tool install cua')).toBeInTheDocument()
    expect(screen.queryByText('Size')).not.toBeInTheDocument()
  })
})
