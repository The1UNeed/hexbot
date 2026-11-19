import { act, fireEvent, render, screen } from '@testing-library/react'

import { useBots } from '../stores/bots'
import { useMe } from '../stores/me'

import { AppShell } from './app-shell'

vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ bot: 'scout', section: 'daily' })
}))

vi.mock('../stores/ui', () => ({
  useUi: (selector: (state: object) => unknown) =>
    selector({
      closeThread: vi.fn(),
      rightPanelOpen: true,
      toggleRightPanel: vi.fn(),
      setSidebarWidth: vi.fn(),
      sidebarWidth: 280,
      thread: null
    })
}))

vi.mock('./slots', () => ({
  ConversationColumn: () => <div>Conversation</div>,
  ProfilePanel: () => <div>Profile</div>,
  RosterColumn: () => <div>Roster</div>
}))

describe('AppShell', () => {
  beforeEach(() => {
    useBots.setState({ settled: true })
    useMe.setState({ loaded: true })
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn()
      }))
    )
  })

  it('opens and closes the compact roster drawer', () => {
    render(<AppShell />)
    const roster = screen.getByTestId('app-roster')
    const show = screen.getByRole('button', { name: 'Show roster' })

    expect(show).toHaveAttribute('aria-expanded', 'false')
    expect(roster).toHaveClass('max-[700px]:-translate-x-full')
    fireEvent.click(show)
    expect(show).toHaveAttribute('aria-expanded', 'true')
    expect(roster).toHaveClass('max-[700px]:translate-x-0')
    fireEvent.click(screen.getByRole('button', { name: 'Hide roster' }))
    expect(show).toHaveAttribute('aria-expanded', 'false')
  })

  it('shows no name or face until bots and you have come over', () => {
    useBots.setState({ byName: {}, order: [], settled: false })
    useMe.setState({ loaded: false, me: null })
    render(<AppShell />)

    expect(screen.getByRole('status', { name: 'Loading Hexbot' })).toBeInTheDocument()
    expect(screen.queryByText('Roster')).toBeNull()
    expect(screen.queryByText('Conversation')).toBeNull()

    act(() => useBots.setState({ settled: true }))
    expect(screen.queryByText('Roster')).toBeNull()

    act(() => useMe.setState({ loaded: true }))
    expect(screen.getByText('Roster')).toBeInTheDocument()
    expect(screen.getByText('Conversation')).toBeInTheDocument()
  })

  it("opens at once with this device's copy when it has the bot being opened", () => {
    useBots.setState({
      byName: { scout: { name: 'scout' } as never },
      order: ['scout'],
      settled: false
    })
    useMe.setState({ loaded: false, me: { display_name: 'Alex' } as never })
    render(<AppShell />)

    expect(screen.getByText('Roster')).toBeInTheDocument()
  })

  it("waits for the daemon when this device's copy lacks the bot being opened", () => {
    useBots.setState({ byName: { owl: { name: 'owl' } as never }, order: ['owl'], settled: false })
    useMe.setState({ loaded: true })
    render(<AppShell />)

    expect(screen.getByRole('status', { name: 'Loading Hexbot' })).toBeInTheDocument()
  })
})
