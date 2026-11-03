import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, vi } from 'vitest'

import { computerStatus, computerStep } from '../../lib/api'
import type { ComputerStatus } from '../../lib/types'
import { useComputer } from '../../stores/computer'

import { ComputerSettings } from './computer'

vi.mock('../../lib/api', async importOriginal => ({
  ...(await importOriginal()),
  computerConfigure: vi.fn(),
  computerStatus: vi.fn(),
  computerStep: vi.fn()
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

describe('Settings, Manuals, Computer use', () => {
  beforeEach(() => {
    useComputer.setState({ error: null, status: null })
    vi.mocked(computerStep).mockResolvedValue(status({ state: 'starting' }))
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
