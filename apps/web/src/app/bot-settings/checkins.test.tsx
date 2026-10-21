import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { setActiveRpc } from '../../lib/rpc'
import type { Bot, CheckinStatus } from '../../lib/types'
import { useCheckins } from '../../stores/checkins'
import { useSections } from '../../stores/sections'
import { useSettings } from '../../stores/settings'
import { useTranscripts } from '../../stores/transcripts'

import { CheckinsTab } from './checkins'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a href="#section">{children}</a>
}))

const hexbot = { display_name: 'HexBot', name: 'hexbot', primary: true } as Bot

const status = (patch: Partial<CheckinStatus> = {}): CheckinStatus => ({
  bot: 'hexbot',
  enabled: true,
  every_minutes: 60,
  hours: '08:00-22:00',
  next_run_at: '2026-10-15T08:00:00Z',
  recent: [
    {
      bot: 'hexbot',
      finished_at: '2026-10-14T07:28:00Z',
      id: 'c1',
      kind: 'wakeup',
      messaged: true,
      started_at: '2026-10-14T07:27:00Z',
      status: 'complete',
      summary: 'Told them about the PE feedback.'
    }
  ],
  running: false,
  section_id: 'checkins-1',
  wakeups: [
    {
      at: '2026-10-15T07:30:00Z',
      id: 'w1',
      local: 'Thu 15 Oct, 07:30',
      note: 'Check the essay draft is submitted'
    }
  ],
  ...patch
})

describe('check-ins', () => {
  beforeEach(() => {
    useCheckins.setState({ error: null, loaded: false, status: null })
    useSettings.setState({
      settings: {
        checkin_enabled: true,
        checkin_every_minutes: 60,
        checkin_hours: '08:00-22:00'
      } as never
    })
  })

  it('shows what is waiting and what happened, and runs one now', async () => {
    const call = vi.fn((method: string) =>
      Promise.resolve(method === 'hexbot.checkins.status' ? status() : { id: 'c2' })
    )

    setActiveRpc({ call } as never)
    render(<CheckinsTab bot={hexbot} />)
    expect(await screen.findByText('Check the essay draft is submitted')).toBeInTheDocument()
    expect(screen.getByText('Messaged you')).toBeInTheDocument()
    expect(screen.getByText('Wake-up')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Check in now' }))
    await waitFor(() =>
      expect(call.mock.calls.map(([method]) => method)).toContain('hexbot.checkins.run_now')
    )
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('hexbot.checkins.cancel_wakeup', { id: 'w1' })
    )
  })

  it('deletes the Check-ins conversation after asking', async () => {
    let deleted = false

    const call = vi.fn((method: string) => {
      if (method === 'hexbot.sections.delete') {
        deleted = true
      }

      return Promise.resolve(
        method === 'hexbot.checkins.status'
          ? status(deleted ? { section_id: null } : {})
          : { deleted: true }
      )
    })

    setActiveRpc({ call } as never)
    // Opened before, so its live transcript is loaded.
    useSections.setState({ liveSessionId: { 'checkins-1': 'live-checkins' } })
    useTranscripts.getState().open('live-checkins', 'checkins-1', [])
    render(<CheckinsTab bot={hexbot} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))
    expect(call).not.toHaveBeenCalledWith('hexbot.sections.delete', expect.anything())
    const confirm = screen.getByRole('button', { name: 'Delete' })
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('hexbot.sections.delete', { id: 'checkins-1' })
    )
    await waitFor(() => expect(screen.queryByText('Delete Check-ins')).toBeNull())
    expect(call.mock.calls.filter(([method]) => method === 'hexbot.sections.delete')).toHaveLength(
      1
    )
    // Its transcript and listing go with it.
    expect(call).toHaveBeenCalledWith('hexbot.sections.list', expect.anything())
    expect(useTranscripts.getState().bySession['live-checkins']).toBeUndefined()
    expect(useSections.getState().liveSessionId['checkins-1']).toBeUndefined()
  })

  it('turns check-ins off and changes their hours', async () => {
    const call = vi.fn((method: string, params?: { patch?: Record<string, unknown> }) =>
      Promise.resolve(
        method === 'hexbot.checkins.status'
          ? status()
          : { checkin_enabled: true, checkin_hours: '08:00-22:00', ...params?.patch }
      )
    )

    setActiveRpc({ call } as never)
    render(<CheckinsTab bot={hexbot} />)
    fireEvent.click(await screen.findByRole('switch', { name: 'Check in on its own' }))
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('hexbot.settings.set', {
        patch: { checkin_enabled: false }
      })
    )
    const to = screen.getByLabelText('To')
    fireEvent.change(to, { target: { value: '23:30' } })
    fireEvent.blur(to)
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('hexbot.settings.set', {
        patch: { checkin_hours: '08:00-23:30' }
      })
    )
  })

  it('turns the hours around through a moment when both ends match', async () => {
    const call = vi.fn((method: string, params?: { patch?: Record<string, unknown> }) =>
      Promise.resolve(
        method === 'hexbot.checkins.status'
          ? status()
          : { checkin_enabled: true, checkin_hours: '08:00-22:00', ...params?.patch }
      )
    )

    setActiveRpc({ call } as never)
    render(<CheckinsTab bot={hexbot} />)
    const from = await screen.findByLabelText('From')
    fireEvent.change(from, { target: { value: '22:00' } })
    fireEvent.blur(from)
    // 22:00 to 22:00 is no window, so nothing is sent yet.
    expect(call.mock.calls.filter(([method]) => method === 'hexbot.settings.set')).toEqual([])
    const to = screen.getByLabelText('To')
    fireEvent.change(to, { target: { value: '08:00' } })
    fireEvent.blur(to)
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('hexbot.settings.set', {
        patch: { checkin_hours: '22:00-08:00' }
      })
    )
  })
})
