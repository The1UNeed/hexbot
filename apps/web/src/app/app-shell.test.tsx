import { fireEvent, render, screen } from '@testing-library/react'

import { AppShell } from './app-shell'

vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ bot: 'scout', section: 'daily' })
}))

vi.mock('../stores/ui', () => ({
  useUi: (selector: (state: object) => unknown) =>
    selector({
      rightPanelOpen: true,
      toggleRightPanel: vi.fn(),
      setSidebarWidth: vi.fn(),
      sidebarWidth: 280
    })
}))

vi.mock('./slots', () => ({
  ConversationColumn: () => <div>Conversation</div>,
  ProfilePanel: () => <div>Profile</div>,
  RosterColumn: () => <div>Roster</div>
}))

describe('AppShell', () => {
  beforeEach(() => {
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
})
