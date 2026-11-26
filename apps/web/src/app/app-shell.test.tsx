import { act, fireEvent, render, screen } from '@testing-library/react'

import { useBots } from '../stores/bots'
import { useMe } from '../stores/me'
import { useUi } from '../stores/ui'
import { fileTab, visualsActions } from '../stores/visuals'

import { AppShell } from './app-shell'

vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ bot: 'scout', section: 'daily' })
}))

vi.mock('./conversation/thread-view', () => ({
  ThreadView: ({ thread }: { thread: { bot: string; peer: string } }) => (
    <div data-testid="thread-view" role="region" tabIndex={-1}>
      {thread.peer} ⇄ {thread.bot}
    </div>
  )
}))

vi.mock('./slots', () => ({
  ConversationColumn: () => (
    <div>
      Conversation
      <button data-testid="open-thread-btn" type="button">
        Open thread
      </button>
    </div>
  ),
  ProfilePanel: () => <div>Profile</div>,
  RosterColumn: () => (
    <div>
      Roster
      <button data-roster-id="bot:scout" type="button">
        Scout row
      </button>
    </div>
  )
}))

describe('AppShell', () => {
  beforeEach(() => {
    useBots.setState({ settled: true })
    useMe.setState({ loaded: true })
    useUi.setState({
      peerRoute: null,
      rightPanelOpen: true,
      sidebarWidth: 280,
      thread: null
    })
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

  it('opens a bot-to-bot thread full-view inside the main pane, hides the right panel, and manages focus', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn()
      }))
    )

    render(<AppShell />)
    expect(screen.getByText('Profile')).toBeInTheDocument()
    expect(screen.queryByTestId('thread-view')).toBeNull()

    const opener = screen.getByTestId('open-thread-btn')
    opener.focus()
    expect(document.activeElement).toBe(opener)

    act(() => useUi.getState().openThread({ bot: 'writer', peer: 'scout', sectionId: 'th1' }))

    const thread = screen.getByTestId('thread-view')
    expect(thread).toHaveTextContent('scout ⇄ writer')
    expect(thread.closest('section')).toHaveClass('hex-shell-main')
    expect(document.activeElement).toBe(thread)

    const panel = screen.getByText('Profile').closest('aside')!
    expect(panel).toHaveClass('opacity-0')
    expect(panel).toHaveAttribute('inert')

    // Closing makes the exiting thread inert and returns keyboard focus to the opener.
    act(() => useUi.getState().closeThread())
    expect(thread.parentElement).toHaveAttribute('inert')
    expect(document.activeElement).toBe(opener)
  })

  it('hides the right panel on direct peer routes and closes the compact roster drawer on row click', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn()
      }))
    )
    render(<AppShell />)

    act(() => useUi.getState().setPeerRoute('peer-1'))
    expect(screen.getByText('Profile').closest('aside')).toHaveClass('opacity-0')

    // Opening a file tab from a peer route shows the visual panel beside it without quick tools.
    act(() =>
      visualsActions().open(
        fileTab('plan.md', {
          askable: false,
          mime: 'text/markdown',
          path: '/work/plan.md',
          sectionId: 'peer-1',
          sessionId: 'live-peer'
        })
      )
    )
    expect(screen.getByRole('tab', { name: /plan\.md/ }).closest('aside')).toHaveClass(
      'opacity-100'
    )
    act(() => visualsActions().closeAll())
    act(() => useUi.getState().setPeerRoute(null))

    // Even re-clicking the already-active bot row dismisses the narrow roster drawer.
    const show = screen.getByRole('button', { name: 'Show roster' })
    fireEvent.click(show)
    expect(show).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Scout row' }))
    expect(show).toHaveAttribute('aria-expanded', 'false')
  })
})
