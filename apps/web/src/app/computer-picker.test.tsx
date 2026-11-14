import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, vi } from 'vitest'

import { computersForBot, computersUse } from '../lib/api'
import type { ComputerInfo } from '../lib/types'
import { useComputers } from '../stores/computers'

import { ComputerPicker } from './computer-picker'

vi.mock('../lib/api', async importOriginal => ({
  ...(await importOriginal()),
  computersForBot: vi.fn(),
  computersUse: vi.fn()
}))

vi.mock('@tanstack/react-router', async importOriginal => ({
  ...(await importOriginal()),
  useNavigate: () => vi.fn()
}))

const computer = (id: 'bots' | 'daemon', active: boolean): ComputerInfo => ({
  active,
  asks: id === 'daemon',
  id,
  kind: id,
  limited: false,
  name: id === 'bots' ? "Bots' computer" : 'Studio',
  online: true,
  os: id === 'bots' ? 'Linux' : 'macOS',
  ready: true,
  screen: id === 'bots'
})

describe('the computer picker', () => {
  beforeEach(() => {
    useComputers.setState({ byBot: {}, error: null, list: null })
    vi.mocked(computersForBot).mockResolvedValue({
      bot: 'owl',
      computers: [computer('bots', true), computer('daemon', false)]
    })
    vi.mocked(computersUse).mockResolvedValue({
      bot: 'owl',
      computers: [computer('bots', false), computer('daemon', true)]
    })
  })

  it('shows the active computer and switches the bot to another', async () => {
    render(<ComputerPicker bot="owl" variant="sidebar" />)
    const trigger = await screen.findByTestId('computer-picker-sidebar')
    expect(trigger).toHaveTextContent("Bots' computer")
    fireEvent.click(trigger)
    expect(await screen.findByText('Nothing asks here')).toBeInTheDocument()
    expect(screen.getByText('Follows the approval mode')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('computer-pick-daemon'))
    await waitFor(() => expect(computersUse).toHaveBeenCalledWith('owl', 'daemon'))
    await waitFor(() => expect(trigger).toHaveTextContent('Studio'))
  })

  it('stays out of the sidebar when there is nothing to switch, but not out of the tab', async () => {
    vi.mocked(computersForBot).mockResolvedValue({
      bot: 'owl',
      computers: [computer('daemon', true)]
    })
    const { unmount } = render(<ComputerPicker bot="owl" variant="sidebar" />)
    await waitFor(() => expect(useComputers.getState().byBot.owl).toBeDefined())
    expect(screen.queryByTestId('computer-picker-sidebar')).not.toBeInTheDocument()
    unmount()
    render(<ComputerPicker bot="owl" variant="panel" />)
    expect(await screen.findByTestId('computer-picker-panel')).toHaveTextContent('Studio')
  })
})
