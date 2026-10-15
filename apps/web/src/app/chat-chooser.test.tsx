import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import type * as api from '../lib/api'
import { sectionsCreate, sectionsList, sectionsUnarchive } from '../lib/api'
import type { DaemonInfo, Section } from '../lib/types'
import { useBots } from '../stores/bots'
import { useConnection } from '../stores/connection'
import { useSections } from '../stores/sections'

import { ChatChooser } from './chat-chooser'

vi.mock('../lib/api', async importOriginal => ({
  ...(await importOriginal<typeof api>()),
  sectionsCreate: vi.fn(),
  sectionsList: vi.fn(),
  sectionsUnarchive: vi.fn()
}))

const section = (id: string, overrides: Partial<Section> = {}) =>
  ({
    archived_at: null,
    bot: 'ada',
    id,
    live_session_id: null,
    message_count: 4,
    peer_bot: null,
    preview: '',
    title: id,
    title_by: null,
    updated_at: Date.now() / 1000,
    ...overrides
  }) as Section

describe('choosing a chat on an older daemon', () => {
  beforeEach(() => {
    vi.mocked(sectionsCreate).mockReset()
    vi.mocked(sectionsUnarchive).mockReset()
    useConnection.setState({ daemon: { version: '0.1.6' } as DaemonInfo })
    useBots.setState({ byName: { ada: { display_name: 'Ada', name: 'ada' } } } as never)
    useSections.setState({ byId: {}, choosing: null, idsByBot: {}, liveSessionId: {} })
  })

  it('lists the sections, and the one picked comes back from the archive to take messages', async () => {
    vi.mocked(sectionsList).mockResolvedValue({
      sections: [
        section('Night notes', { preview: 'What did you learn?' }),
        section('Trip', { archived_at: 5 })
      ]
    })
    vi.mocked(sectionsUnarchive).mockResolvedValue({ section: section('Trip') })
    render(<ChatChooser />)

    const opening = useSections.getState().chat('ada')

    expect(await screen.findByText('Continue with Ada')).toBeVisible()
    expect(screen.getByRole('button', { name: /Night notes.*What did you learn/ })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: /Trip.*Archived/ }))

    expect(await opening).toMatchObject({ archived_at: null, id: 'Trip' })
    expect(sectionsUnarchive).toHaveBeenCalledWith('Trip')
    expect(sectionsCreate).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByText('Continue with Ada')).toBeNull())
  })

  it('opens and makes nothing when closed', async () => {
    vi.mocked(sectionsList).mockResolvedValue({
      sections: [section('a', { bot: 'bea' }), section('b', { bot: 'bea' })]
    })
    render(<ChatChooser />)

    const opening = useSections.getState().chat('bea')

    fireEvent.keyDown(await screen.findByRole('dialog'), { key: 'Escape' })

    expect(await opening).toBeNull()
    expect(sectionsCreate).not.toHaveBeenCalled()
    expect(sectionsUnarchive).not.toHaveBeenCalled()
  })
})
