import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import type * as api from '../../lib/api'
import { sectionsList, sectionsUnarchive } from '../../lib/api'
import type { Bot, Section } from '../../lib/types'
import { useBots } from '../../stores/bots'
import { useSections } from '../../stores/sections'

import { archiveGroup, ArchiveSettings } from './archive'

const navigate = vi.fn()

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))

vi.mock('../../lib/api', async importOriginal => ({
  ...(await importOriginal<typeof api>()),
  sectionsList: vi.fn(),
  sectionsOpen: vi.fn().mockReturnValue(new Promise(() => undefined)),
  sectionsUnarchive: vi.fn()
}))

const DAY = 86_400_000
const now = Date.now()

const section = (overrides: Partial<Section>) =>
  ({
    archived_at: null,
    bot: 'ada',
    id: 's',
    live_session_id: null,
    message_count: 3,
    peer_bot: null,
    preview: '',
    title: 'Untitled',
    title_by: null,
    updated_at: now,
    ...overrides
  }) as Section

const sections = [
  section({ archived_at: now - DAY, id: 'a', preview: 'Exa needs a key', title: 'Web search' }),
  section({ archived_at: now - 9 * DAY, bot: 'milo', id: 'b', title: 'Release notes' }),
  section({ archived_at: now - 2 * DAY, id: 'c', title: 'Nightly build' }),
  section({ id: 'open', title: 'Still open' })
]

describe('archive settings', () => {
  beforeEach(() => {
    navigate.mockReset()
    useSections.setState({
      byId: {},
      idsByBot: {},
      liveSessionId: {},
      sendingTitles: {},
      error: null,
      loading: false
    })
    useBots.setState({
      byName: {
        ada: { avatar: null, display_name: 'Ada', name: 'ada' } as Bot,
        milo: { avatar: null, display_name: 'Milo', name: 'milo' } as Bot
      },
      order: ['ada', 'milo']
    })
    vi.mocked(sectionsList).mockResolvedValue({ sections })
  })

  it('groups archived sections by when they were archived, newest first', async () => {
    render(<ArchiveSettings />)

    const week = await screen.findByRole('region', { name: 'This week' })
    expect(
      within(week)
        .getAllByRole('listitem')
        .map(item => item.textContent)
    ).toEqual([expect.stringContaining('Web search'), expect.stringContaining('Nightly build')])
    expect(
      within(screen.getByRole('region', { name: 'Last week' })).getByText('Release notes')
    ).toBeTruthy()
    expect(screen.queryByText('Still open')).toBeNull()
  })

  it('narrows by search across titles, first messages and bots, and by bot', async () => {
    render(<ArchiveSettings />)
    await screen.findByText('Web search')

    fireEvent.change(screen.getByLabelText('Search the archive'), { target: { value: 'exa' } })
    expect(screen.getByText('Web search')).toBeTruthy()
    expect(screen.queryByText('Nightly build')).toBeNull()

    fireEvent.change(screen.getByLabelText('Search the archive'), { target: { value: 'nothing' } })
    expect(screen.getByText('Nothing archived matches that.')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Search the archive'), { target: { value: '' } })
    fireEvent.click(within(screen.getByRole('group')).getByRole('button', { name: /Milo/ }))
    expect(screen.getByText('Release notes')).toBeTruthy()
    expect(screen.queryByText('Web search')).toBeNull()
  })

  it('restores a section, which leaves the archive', async () => {
    vi.mocked(sectionsUnarchive).mockResolvedValue({
      section: { ...sections[0]!, archived_at: null }
    })
    render(<ArchiveSettings />)
    const row = (await screen.findByText('Web search')).closest('li')!

    fireEvent.click(within(row).getByRole('button', { name: 'Restore' }))

    await waitFor(() => expect(screen.queryByText('Web search')).toBeNull())
    expect(sectionsUnarchive).toHaveBeenCalledWith('a')
  })

  it('shows other bots after restoring the selected bot’s last archive', async () => {
    vi.mocked(sectionsUnarchive).mockResolvedValue({
      section: { ...sections[1]!, archived_at: null }
    })
    render(<ArchiveSettings />)
    await screen.findByText('Release notes')
    fireEvent.click(within(screen.getByRole('group')).getByRole('button', { name: /Milo/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }))

    await screen.findByText('Web search')
    expect(screen.getByText('Nightly build')).toBeTruthy()
    expect(screen.queryByText('Nothing archived matches that.')).toBeNull()
  })

  it('shows loading until the archive arrives', async () => {
    let resolve!: (value: { sections: Section[] }) => void
    vi.mocked(sectionsList).mockReturnValue(
      new Promise(done => {
        resolve = done
      })
    )
    render(<ArchiveSettings />)

    expect(screen.getByRole('status').textContent).toContain('Loading the archive')
    expect(screen.queryByText(/Nothing archived/)).toBeNull()
    resolve({ sections })
    await screen.findByText('Web search')
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('shows a load failure and retries', async () => {
    vi.mocked(sectionsList).mockRejectedValueOnce(new Error('Disconnected'))
    render(<ArchiveSettings />)

    expect((await screen.findByRole('alert')).textContent).toContain('Disconnected')
    expect(screen.queryByText(/Nothing archived/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await screen.findByText('Web search')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows restore failures and keeps the archived conversation', async () => {
    vi.mocked(sectionsUnarchive).mockRejectedValueOnce(new Error('Disconnected'))
    render(<ArchiveSettings />)
    const row = (await screen.findByText('Web search')).closest('li')!
    fireEvent.click(within(row).getByRole('button', { name: 'Restore' }))

    expect((await screen.findByRole('alert')).textContent).toContain('Could not restore')
    expect(screen.getByText('Web search')).toBeTruthy()
  })

  it('opens a section in its conversation', async () => {
    render(<ArchiveSettings />)
    const row = (await screen.findByText('Nightly build')).closest('li')!

    fireEvent.click(within(row).getByRole('button', { name: 'Open' }))

    expect(navigate).toHaveBeenCalledWith({
      params: { bot: 'ada', section: 'c' },
      to: '/b/$bot/s/$section'
    })
  })

  it('says so when nothing is archived', async () => {
    vi.mocked(sectionsList).mockResolvedValue({ sections: [section({ id: 'open' })] })
    render(<ArchiveSettings />)

    expect(await screen.findByText(/Nothing archived\. Archive a conversation/)).toBeTruthy()
    expect(screen.queryByLabelText('Search the archive')).toBeNull()
  })

  it('names months past the last two weeks, with the year only when it differs', () => {
    const today = new Date(2026, 9, 7).getTime()

    expect(archiveGroup(today - DAY, today)).toBe('This week')
    expect(archiveGroup(today - 10 * DAY, today)).toBe('Last week')
    expect(archiveGroup(new Date(2026, 7, 3).getTime(), today)).toMatch(/August/)
    expect(archiveGroup(new Date(2025, 7, 3).getTime(), today)).toMatch(/2025/)
  })
})
