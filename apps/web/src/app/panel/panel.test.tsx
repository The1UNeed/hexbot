import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { vi } from 'vitest'

import type { Bot, ToolCall } from '../../lib/types'
import { useBots } from '../../stores/bots'
import { useComputer } from '../../stores/computer'
import { useConnection } from '../../stores/connection'
import { useSections } from '../../stores/sections'
import { useTranscripts } from '../../stores/transcripts'
import { useUi } from '../../stores/ui'

import { ProfilePanel } from './index'

// The ui store persists to localStorage, which Node shadows without a file; give it memory.
vi.hoisted(() => {
  const items = new Map<string, string>()

  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      clear: () => items.clear(),
      getItem: (key: string) => items.get(key) ?? null,
      key: (index: number) => [...items.keys()][index] ?? null,
      get length() {
        return items.size
      },
      removeItem: (key: string) => items.delete(key),
      setItem: (key: string, value: string) => items.set(key, String(value))
    }
  })
})

const api = vi.hoisted(() => ({
  computerControl: vi.fn(),
  computerStatus: vi.fn(),
  computerView: vi.fn()
}))

vi.mock('../../lib/api', async importOriginal => ({
  ...(await importOriginal<object>()),
  ...api
}))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({})
}))

const bot = {
  avatar: null,
  created_at: 0,
  description: '',
  display_name: 'Scout',
  dream_enabled: true,
  last_activity_at: 0,
  model: 'glm-5',
  name: 'scout',
  owner_id: 'local',
  persona: '',
  provider: null,
  sections_recent: [],
  sections_total: 0,
  skills: [],
  title: '',
  tools: [],
  updated_at: 0
} satisfies Bot

const running = {
  activity: null,
  actor: null,
  available: true,
  control: 'bot' as const,
  cursors: [],
  error: null,
  size: 'small' as const,
  sizes: [],
  state: 'running' as const
}

const call = (partial: Partial<ToolCall>): ToolCall => ({
  args: { command: 'date' },
  durationS: 1,
  name: 'terminal',
  result: 'Fri',
  startedAt: 0,
  status: 'ok',
  summary: 'date',
  toolId: partial.toolId ?? 't',
  ...partial
})

function seed(calls: ToolCall[], streaming: boolean) {
  useBots.setState({ byName: { scout: bot } })
  useUi.setState({ lastSection: { bot: 'scout', section: 'daily' }, panelTab: 'details' })
  useSections.setState({ liveSessionId: { daily: 's' } })
  useTranscripts.setState({
    bySession: {
      s: {
        approvals: [],
        clarifies: [],
        error: null,
        info: null,
        messages: [
          {
            attachments: [],
            createdAt: 0,
            id: 'm',
            role: 'assistant',
            streaming,
            text: '',
            toolCalls: calls
          }
        ],
        context: null,
        sessionId: 's',
        status: null,
        streamingMessageId: streaming ? 'm' : null,
        usage: null
      }
    }
  })
}

describe('ProfilePanel', () => {
  it('names the running step under the name, and lists no steps on Computer', () => {
    seed(
      [
        call({ toolId: 'a' }),
        call({ name: 'memory', summary: '', toolId: 'b' }),
        call({ status: 'running', summary: 'ls', toolId: 'c' })
      ],
      true
    )
    render(<ProfilePanel />)

    // The status under the name names the running step and opens Computer.
    fireEvent.click(screen.getByRole('button', { name: 'Scout is running a command' }))
    expect(screen.getByRole('tab', { name: 'Computer' })).toHaveAttribute('aria-selected', 'true')

    // Computer shows no list of steps.
    expect(screen.queryByTestId('computer-steps')).toBeNull()
    expect(screen.queryByText('Running ls')).toBeNull()
  })

  it('shows a bot clicked in the roster while its chat opens, then the chat it lands on', () => {
    seed([], false)
    useBots.setState({ byName: { scout: bot, muse: { ...bot, display_name: 'Muse', name: 'muse' } } })
    render(<ProfilePanel />)
    expect(screen.getByPlaceholderText('What Scout is for')).toBeVisible()

    act(() => useUi.setState({ openingShown: 'muse' }))
    expect(screen.getByPlaceholderText('What Muse is for')).toBeVisible()
    expect(screen.queryByPlaceholderText('What Scout is for')).toBeNull()

    // The click came to nothing: the chat shown before is back.
    act(() => useUi.setState({ openingShown: null }))
    expect(screen.getByPlaceholderText('What Scout is for')).toBeVisible()
  })

  it('says how to fill an empty Library', () => {
    seed([], false)
    render(<ProfilePanel />)

    fireEvent.click(screen.getByRole('tab', { name: 'Library' }))
    expect(
      screen.getByText('Visuals Scout draws and the images and files you share show up here.')
    ).toBeVisible()
  })

  it("shows the bots' computer live, with each bot's cursor, and shares it with you", async () => {
    const running = {
      activity: null,
      actor: null,
      available: true,
      control: 'bot' as const,
      cursors: [],
      error: null,
      size: 'small' as const,
      sizes: [],
      state: 'running' as const
    }

    api.computerStatus.mockResolvedValue(running)
    api.computerView.mockReset()
    api.computerView.mockImplementation((control: boolean) =>
      Promise.resolve({
        control,
        expires_at: 0,
        path: `/hexbot/computer/${control ? 'c' : 't'}/viewer/#ticket=v`
      })
    )
    api.computerControl.mockReset()
    api.computerControl.mockResolvedValue({ ...running, control: 'user' })
    useComputer.setState({ error: null, status: null })
    useConnection.setState({ target: { kind: 'local', origin: 'http://127.0.0.1:9119' } })
    seed(
      [
        call({ name: 'computer_use', summary: 'click', toolId: 'a' }),
        call({ summary: 'ls', toolId: 'b' })
      ],
      false
    )
    useBots.setState({
      byName: {
        owl: { ...bot, display_name: 'Owl', name: 'owl', tools: ['computer_use'] },
        scout: { ...bot, tools: ['computer_use'] }
      }
    })
    const { unmount } = render(<ProfilePanel />)
    fireEvent.click(screen.getByRole('tab', { name: 'Computer' }))

    // A small screen that only watches, through the daemon, without sound.
    // Its size and frame rate follow the connection.
    const frame = await screen.findByTitle("Your bots' screen")
    expect(frame).toHaveAttribute(
      'src',
      'http://127.0.0.1:9119/hexbot/computer/t/viewer/#ticket=v&audio=none'
    )
    expect(api.computerView).toHaveBeenCalledWith(false, 'auto')

    // Two bots on it: each has a cursor where it last acted, and the line
    // under the screen says who is acting.
    const now = Date.now() / 1000
    act(() =>
      useComputer.getState().apply({
        activity: 'click',
        actor: 'scout',
        cursors: [
          { action: 'click', at: now, bot: 'scout', x: 0.5, y: 0.25 },
          { action: 'type', at: now - 2, bot: 'owl', x: 0.1, y: 0.9 }
        ]
      })
    )
    expect(screen.getByTestId('computer-caption')).toHaveTextContent(
      'Scout is clicking on the computer'
    )
    const scout = screen.getByRole('img', { name: "Scout's cursor" })
    expect(scout).toHaveStyle({ left: '50%', top: '25%' })
    expect(scout.querySelector('.hex-cursor-press')).not.toBeNull()
    expect(screen.getByRole('img', { name: "Owl's cursor" })).toHaveAttribute('data-stale', 'false')

    // Opened large, the screen takes your clicks and keys, with sound, while
    // the bots keep working.
    fireEvent.click(screen.getByRole('button', { name: "Open your bots' computer" }))
    await waitFor(() => expect(api.computerView).toHaveBeenLastCalledWith(true, 'auto'))
    await waitFor(() =>
      expect(
        screen
          .getAllByTitle("Your bots' screen")
          .some(
            each =>
              each.getAttribute('src') ===
              'http://127.0.0.1:9119/hexbot/computer/c/viewer/#ticket=v'
          )
      ).toBe(true)
    )
    expect(api.computerControl).not.toHaveBeenCalled()
    expect(screen.getAllByText('Scout is clicking on the computer')).toHaveLength(2)
    // The small screen keeps playing under the window, so it is there when it closes.
    expect(screen.getByTestId('computer-screen')).toContainElement(frame)

    // Pausing the bots gives you the computer alone; the window and the line
    // under the small screen both say so.
    // The window is modal, so its button is the one you can reach.
    fireEvent.click(screen.getByRole('button', { name: 'Pause bots' }))
    expect(api.computerControl).toHaveBeenCalledWith('user')
    expect(await screen.findAllByText('Your bots are paused until you resume them.')).toHaveLength(
      2
    )
    expect(screen.getAllByRole('button', { hidden: true, name: 'Resume bots' })).toHaveLength(2)

    // Closing it, or the panel going away under it, leaves them paused.
    unmount()
    await act(async () => {})
    expect(api.computerControl).toHaveBeenCalledTimes(1)
  })

  it('streams the screen at the quality chosen on this device', async () => {
    api.computerStatus.mockResolvedValue(running)
    api.computerView.mockReset()
    api.computerView.mockImplementation((_control: boolean, quality: string) =>
      Promise.resolve({ control: false, expires_at: 0, path: `/v/${quality}/#t` })
    )
    useComputer.setState({ error: null, status: null })
    useConnection.setState({ target: { kind: 'local', origin: 'http://127.0.0.1:9119' } })
    useUi.setState({ computerQuality: 'auto' })
    seed([], false)
    useBots.setState({ byName: { scout: { ...bot, tools: ['computer_use'] } } })
    render(<ProfilePanel />)
    fireEvent.click(screen.getByRole('tab', { name: 'Computer' }))
    expect(await screen.findByTitle("Your bots' screen")).toHaveAttribute(
      'src',
      'http://127.0.0.1:9119/v/auto/#t&audio=none'
    )

    fireEvent.click(screen.getByRole('button', { name: 'Computer options' }))
    fireEvent.click(await screen.findByTestId('computer-quality-720p30'))
    // A new link at the chosen quality, kept for the next time. It loads
    // under the screen on show, which stays until the new picture is up.
    await waitFor(() => expect(api.computerView).toHaveBeenLastCalledWith(false, '720p30'))
    await waitFor(() => expect(screen.getAllByTitle("Your bots' screen")).toHaveLength(2))

    const [shown, next] = screen.getAllByTitle("Your bots' screen") as [
      HTMLIFrameElement,
      HTMLIFrameElement
    ]

    expect(shown).toHaveAttribute('src', 'http://127.0.0.1:9119/v/auto/#t&audio=none')
    expect(next).toHaveAttribute('src', 'http://127.0.0.1:9119/v/720p30/#t&audio=none')

    const tell = (status: string) =>
      act(() =>
        window.dispatchEvent(
          new MessageEvent('message', {
            data: { status, type: 'hexbot.computer.screen' },
            source: next.contentWindow
          })
        )
      )

    tell('connecting')
    expect(screen.getAllByTitle("Your bots' screen")).toHaveLength(2)
    tell('streaming')
    expect(screen.getByTitle("Your bots' screen")).toBe(next)
    expect(useUi.getState().computerQuality).toBe('720p30')
    useUi.setState({ computerQuality: 'auto' })
  })

  it('says why the screen cannot play over a plain HTTP connection', async () => {
    api.computerStatus.mockResolvedValue(running)
    api.computerView.mockReset()
    useComputer.setState({ error: null, status: null })
    // Paired over the LAN: a plain http:// address that is not this computer.
    useConnection.setState({
      target: { deviceToken: 't', host: '192.168.0.87', kind: 'remote', port: 9119, tls: false }
    })
    seed([], false)
    useBots.setState({ byName: { scout: { ...bot, tools: ['computer_use'] } } })
    render(<ProfilePanel />)
    fireEvent.click(screen.getByRole('tab', { name: 'Computer' }))
    expect(await screen.findByTestId('computer-insecure')).toHaveTextContent(
      'plays only over a secure connection'
    )
    expect(screen.queryByTitle("Your bots' screen")).toBeNull()
    expect(api.computerView).not.toHaveBeenCalled()
  })

  it('still pauses and resumes the bots over a plain HTTP connection', async () => {
    api.computerStatus.mockResolvedValue({ ...running, control: 'user' })
    api.computerControl.mockReset()
    api.computerControl.mockResolvedValue(running)
    useComputer.setState({ error: null, status: null })
    useConnection.setState({
      target: { deviceToken: 't', host: '192.168.0.87', kind: 'remote', port: 9119, tls: false }
    })
    seed([], false)
    useBots.setState({ byName: { scout: { ...bot, tools: ['computer_use'] } } })
    render(<ProfilePanel />)
    fireEvent.click(screen.getByRole('tab', { name: 'Computer' }))
    expect(await screen.findByTestId('computer-insecure')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Resume bots' }))
    expect(api.computerControl).toHaveBeenCalledWith('bot')
  })
})
