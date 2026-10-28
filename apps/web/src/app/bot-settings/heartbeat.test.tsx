import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { setActiveRpc } from '../../lib/rpc'
import type { Bot, HeartbeatStatus } from '../../lib/types'
import { useHeartbeat } from '../../stores/heartbeat'
import { useSections } from '../../stores/sections'
import { useSettings } from '../../stores/settings'
import { useTranscripts } from '../../stores/transcripts'

import { countChecks, HeartbeatTab } from './heartbeat'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a href="#section">{children}</a>
}))

const owl = { display_name: 'Owl', name: 'owl', primary: false } as Bot

const PLACEHOLDER =
  '# Heartbeat\n\n<!--\nOne check per line, for example:\n- Has Sam replied?\n-->\n'

const status = (patch: Partial<HeartbeatStatus> = {}): HeartbeatStatus => ({
  bot: 'owl',
  cap: 4000,
  earlier_checkins: null,
  empty: false,
  enabled: true,
  every_minutes: 30,
  next_run_at: '2026-10-15T08:30:00Z',
  recent: [
    {
      bot: 'owl',
      finished_at: '2026-10-15T08:01:00Z',
      id: 'h1',
      kind: 'scheduled',
      messaged: true,
      started_at: '2026-10-15T08:00:00Z',
      status: 'complete',
      summary: 'BA 286 is two hours late; told them.'
    }
  ],
  running: false,
  text: '# Heartbeat\n- Is flight BA 286 on Friday delayed?\n',
  ...patch
})

describe('heartbeat', () => {
  beforeEach(() => {
    useHeartbeat.setState({ byBot: {}, errors: {} })
    useSettings.setState({ settings: { heartbeat_enabled: true } as never })
  })

  it('counts only real checks, as the daemon does', () => {
    expect(countChecks(PLACEHOLDER)).toBe(0)
    expect(countChecks('# Heartbeat\n- \n- [ ]\n')).toBe(0)
    expect(countChecks('<!-- draft\n- Is BA 286 late?')).toBe(0)
    expect(countChecks(`${PLACEHOLDER}- Has Sam replied?\n- Is BA 286 late?`)).toBe(2)
  })

  it('shows the checklist and what came of it, saves it on leaving the field, and runs one now', async () => {
    let text = status().text

    const call = vi.fn((method: string, params?: { text?: string }) => {
      if (method === 'hexbot.heartbeat.set') {
        text = params?.text ?? text
      }

      return Promise.resolve(
        method === 'hexbot.heartbeat.status' || method === 'hexbot.heartbeat.set'
          ? status({ text })
          : { id: 'h2' }
      )
    })

    setActiveRpc({ call } as never)
    render(<HeartbeatTab bot={owl} />)
    const field = await screen.findByRole('textbox', { name: 'Heartbeat checklist' })
    expect(field).toHaveValue(status().text)
    expect(screen.getByText('1 check')).toBeInTheDocument()
    expect(
      screen.getByText('Posted in your chat. BA 286 is two hours late; told them.')
    ).toBeInTheDocument()

    const next = `${status().text}- Has Sam replied about the lease?\n`

    fireEvent.change(field, { target: { value: next } })
    expect(screen.getByText('2 checks')).toBeInTheDocument()
    // Not until the change is saved.
    expect(screen.getByRole('button', { name: 'Run now' })).toBeDisabled()
    fireEvent.blur(field)
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('hexbot.heartbeat.set', { bot: 'owl', text: next })
    )
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run now' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Run now' }))
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('hexbot.heartbeat.run_now', { bot: 'owl' })
    )
  })

  it('waits for a check before it runs', async () => {
    const call = vi.fn(() =>
      Promise.resolve(status({ empty: true, recent: [], text: PLACEHOLDER }))
    )

    setActiveRpc({ call } as never)
    render(<HeartbeatTab bot={owl} />)
    expect(await screen.findByText('Add a check to start')).toBeInTheDocument()
    expect(screen.getByText('Nothing to check yet')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Run now' })).toBeDisabled()
    expect(screen.getByText('No heartbeats yet')).toBeInTheDocument()
  })

  it('turns every bot’s heartbeat off', async () => {
    const call = vi.fn((method: string, params?: { patch?: Record<string, unknown> }) =>
      Promise.resolve(
        method === 'hexbot.heartbeat.status'
          ? status()
          : { heartbeat_enabled: true, ...params?.patch }
      )
    )

    setActiveRpc({ call } as never)
    render(<HeartbeatTab bot={owl} />)
    fireEvent.click(await screen.findByRole('switch', { name: 'Run heartbeats' }))
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('hexbot.settings.set', {
        patch: { heartbeat_enabled: false }
      })
    )
    await waitFor(() => expect(screen.getByText('Off')).toBeInTheDocument())
  })

  it('takes a change the bot made from its chat', async () => {
    const call = vi.fn(() => Promise.resolve(status()))

    setActiveRpc({ call } as never)
    render(<HeartbeatTab bot={owl} />)
    const field = await screen.findByRole('textbox', { name: 'Heartbeat checklist' })
    call.mockImplementation(() => Promise.resolve(status({ text: '- Is the XM6 under $300?' })))
    await useHeartbeat.getState().refreshLoaded('owl')
    await waitFor(() => expect(field).toHaveValue('- Is the XM6 under $300?'))
  })

  it('deletes the Check-ins from before the heartbeat after asking', async () => {
    let deleted = false

    const call = vi.fn((method: string) => {
      if (method === 'hexbot.sections.delete') {
        deleted = true
      }

      return Promise.resolve(
        method === 'hexbot.heartbeat.status'
          ? status({ earlier_checkins: deleted ? null : 'checkins-1' })
          : { deleted: true }
      )
    })

    setActiveRpc({ call } as never)
    // Opened before, so its live transcript is loaded.
    useSections.setState({ liveSessionId: { 'checkins-1': 'live-checkins' } })
    useTranscripts.getState().open('live-checkins', 'checkins-1', [])
    render(<HeartbeatTab bot={owl} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))
    expect(call).not.toHaveBeenCalledWith('hexbot.sections.delete', expect.anything())
    const confirm = screen.getByRole('button', { name: 'Delete' })
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('hexbot.sections.delete', { id: 'checkins-1' })
    )
    await waitFor(() => expect(screen.queryByText('Delete earlier check-ins')).toBeNull())
    expect(call.mock.calls.filter(([method]) => method === 'hexbot.sections.delete')).toHaveLength(
      1
    )
    // Its transcript and listing go with it.
    expect(call).toHaveBeenCalledWith('hexbot.sections.list', expect.anything())
    expect(useTranscripts.getState().bySession['live-checkins']).toBeUndefined()
    expect(useSections.getState().liveSessionId['checkins-1']).toBeUndefined()
  })
})
