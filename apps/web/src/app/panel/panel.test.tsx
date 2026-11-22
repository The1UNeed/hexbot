import { JsonRpcGatewayError } from '@hermes/shared'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { vi } from 'vitest'

import { clearPersonalState } from '../../lib/roster-cache'
import type { Bot, Computer, Section, ToolCall } from '../../lib/types'
import { useBots } from '../../stores/bots'
import { useComputer } from '../../stores/computer'
import { useComputers } from '../../stores/computers'
import { useConnection } from '../../stores/connection'
import { useEmotions } from '../../stores/emotions'
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
  computerView: vi.fn(),
  computersGrant: vi.fn(),
  connectorsSetForBot: vi.fn(),
  computersList: vi.fn()
}))

vi.mock('../../lib/api', async importOriginal => ({
  ...(await importOriginal<object>()),
  ...api
}))

// The route on screen; `seed` puts it back on no chat.
const route = vi.hoisted(() => ({ params: {} as { bot?: string; section?: string } }))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useParams: () => route.params
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

const olderDaemon = () =>
  new JsonRpcGatewayError('unknown method: hexbot.computers.list', { code: -32601 })

const vmComputer = (change: Partial<Computer> = {}): Computer => ({
  apps: {},
  available: true,
  desktop: { available: true, bots: [] },
  id: 'vm',
  kind: 'vm',
  name: "Bots' computer",
  on: true,
  online: true,
  os: 'linux',
  terminal: { available: true, bots: [] },
  ...change
})

function seed(calls: ToolCall[], streaming: boolean) {
  route.params = {}
  // A daemon from before computers, as the screen tests assume: it has no
  // list, and the tab goes by the bot's tools.
  api.computersList.mockReset()
  api.computersList.mockRejectedValue(olderDaemon())
  useComputers.setState({
    answered: null,
    computers: null,
    error: null,
    listFailed: null,
    older: false
  })
  useEmotions.setState({ feelings: {} })
  useBots.setState({ byName: { scout: bot } })
  useUi.setState({
    lastSection: { bot: 'scout', section: 'daily' },
    openingBot: null,
    panelTab: 'details'
  })
  useSections.setState({ byId: {}, liveSessionId: { daily: 's' } })
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
    useBots.setState({
      byName: { scout: bot, muse: { ...bot, display_name: 'Muse', name: 'muse' } }
    })
    render(<ProfilePanel />)
    expect(screen.getByPlaceholderText('What Scout is for')).toBeVisible()

    act(() => useUi.setState({ openingShown: 'muse' }))
    expect(screen.getByPlaceholderText('What Muse is for')).toBeVisible()
    expect(screen.queryByPlaceholderText('What Scout is for')).toBeNull()

    // The click came to nothing: the chat shown before is back.
    act(() => useUi.setState({ openingShown: null }))
    expect(screen.getByPlaceholderText('What Scout is for')).toBeVisible()
  })

  it('wears the face its roster row wears: the step the bot is on, then what it feels', () => {
    const daily = {
      archived_at: null,
      bot: 'scout',
      created_at: 0,
      id: 'daily',
      live_session_id: 's',
      message_count: 2,
      preview: '',
      title: '',
      title_by: null,
      updated_at: 0
    } satisfies Section

    seed(
      [call({ name: 'web_search', status: 'running', summary: 'gear ratios', toolId: 'w' })],
      true
    )
    useSections.setState({ byId: { daily } })
    useTranscripts.setState(state => ({
      bySession: { s: { ...state.bySession.s!, sectionId: 'daily' } }
    }))
    const { rerender } = render(<ProfilePanel />)

    const face = () =>
      screen.getByRole('button', { name: 'Change face' }).querySelector('[data-mood]')

    expect(face()).toHaveAttribute('data-mood', 'searching')

    act(() => useEmotions.getState().feel('scout', 'drowsy'))
    expect(face()).toHaveAttribute('data-mood', 'drowsy')

    // The reply ends and the feeling passes: the face rests, as the row's does.
    act(() => {
      useEmotions.getState().calm('scout')
      useTranscripts.setState(state => ({
        bySession: { s: { ...state.bySession.s!, streamingMessageId: null } }
      }))
    })
    expect(face()).toHaveAttribute('data-mood', 'idle')

    // A finished turn you have not seen, while the chat is not on screen: happy.
    act(() => useSections.setState({ byId: { daily: { ...daily, done_at: 1 } } }))
    expect(face()).toHaveAttribute('data-mood', 'happy')

    // With its chat on screen the row rests, and so does the face.
    route.params = { bot: 'scout', section: 'daily' }
    rerender(<ProfilePanel />)
    expect(face()).toHaveAttribute('data-mood', 'idle')

    // Another bot's chat opening from the roster takes the screen: happy again.
    act(() => useUi.setState({ openingBot: 'muse' }))
    expect(face()).toHaveAttribute('data-mood', 'happy')

    // This bot's chat opening from another bot's: it rests.
    route.params = { bot: 'muse', section: 'muse-chat' }
    act(() => useUi.setState({ openingBot: 'scout' }))
    expect(face()).toHaveAttribute('data-mood', 'idle')

    act(() => useUi.setState({ openingBot: null }))
    expect(face()).toHaveAttribute('data-mood', 'happy')
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

  it("goes by the bot's place on the bots' computer, not its desktop elsewhere", async () => {
    const vm = vmComputer({ on: false })

    api.computerStatus.mockResolvedValue(running)
    api.computerView.mockReset()
    api.computersGrant.mockReset()
    api.computersGrant.mockResolvedValue({ ok: true })
    api.connectorsSetForBot.mockReset()
    api.connectorsSetForBot.mockResolvedValue({ connector: {} })
    useComputer.setState({ error: null, status: null })
    useConnection.setState({ target: { kind: 'local', origin: 'http://127.0.0.1:9119' } })
    seed([], false)
    api.computersList.mockResolvedValue({ computers: [vm] })
    // computer_use from this computer's desktop, not the bots' computer.
    useBots.setState({ byName: { scout: { ...bot, tools: ['computer_use'] } } })
    render(<ProfilePanel />)
    fireEvent.click(screen.getByRole('tab', { name: 'Computer' }))
    // Off: turning it on happens in Settings, Computers, not here.
    expect(
      await screen.findByText(/Your bots aren't using their computer\. Turn on Use the bots'/)
    ).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Turn on Computer Use' })).toBeNull()

    // On, without this bot: no screen, and Turn on grants its desktop there.
    act(() => useComputers.setState({ computers: [{ ...vm, on: true }] }))
    fireEvent.click(await screen.findByRole('button', { name: 'Turn on Computer Use' }))
    // The bots' computer as one of its environments, then Computer Use.
    await waitFor(() =>
      expect(api.connectorsSetForBot).toHaveBeenCalledWith('computer_use', 'scout', true)
    )
    expect(api.computersGrant).toHaveBeenCalledWith('vm', 'terminal', 'scout', true)
    await waitFor(() =>
      expect(api.connectorsSetForBot).toHaveBeenCalledWith('computer_use', 'scout', true)
    )
    expect(screen.queryByTitle("Your bots' screen")).toBeNull()
    expect(api.computerView).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('offers Retry when the first computer status request fails', async () => {
    api.computerStatus
      .mockRejectedValueOnce(new Error('Connection lost'))
      .mockResolvedValue(running)
    useComputer.setState({ error: null, status: null })
    seed([], false)
    api.computersList.mockResolvedValue({ computers: [vmComputer()] })
    render(<ProfilePanel />)
    fireEvent.click(screen.getByRole('tab', { name: 'Computer' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Connection lost')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('button', { name: 'Turn on Computer Use' })).toBeVisible()
  })

  it('waits for the list of computers before it shows the screen', async () => {
    let answer: (value: { computers: Computer[] }) => void = () => {}

    api.computerStatus.mockResolvedValue(running)
    api.computerView.mockReset()
    api.computerView.mockResolvedValue({ control: false, expires_at: 0, path: '/v/#t' })
    useComputer.setState({ error: null, status: null })
    useConnection.setState({ target: { kind: 'local', origin: 'http://127.0.0.1:9119' } })
    seed([], false)
    api.computersList.mockReturnValue(
      new Promise(resolve => {
        answer = resolve
      })
    )
    useBots.setState({ byName: { scout: { ...bot, tools: ['computer_use'] } } })
    render(<ProfilePanel />)
    fireEvent.click(screen.getByRole('tab', { name: 'Computer' }))
    await waitFor(() => expect(useComputer.getState().status).not.toBeNull())
    expect(screen.getByText('Loading computer…')).toBeVisible()
    // The status is in; the bot's place on the computer is not.
    await act(async () => {})
    expect(screen.queryByTitle("Your bots' screen")).toBeNull()
    expect(screen.queryByRole('button', { name: 'Turn on Computer Use' })).toBeNull()
    expect(api.computerView).not.toHaveBeenCalled()

    await act(async () =>
      answer({ computers: [vmComputer({ desktop: { available: true, bots: ['scout'] } })] })
    )
    expect(await screen.findByTitle("Your bots' screen")).toBeVisible()
  })

  it("goes by the bot's tools on a daemon from before computers, and says nothing of it", async () => {
    const update = vi.fn().mockResolvedValue(bot)

    api.computerStatus.mockResolvedValue({ ...running, state: 'stopped' as const })
    api.computersGrant.mockReset()
    useComputer.setState({ error: null, status: null })
    useConnection.setState({ target: { kind: 'local', origin: 'http://127.0.0.1:9119' } })
    seed([], false)
    useBots.setState({ update })
    render(<ProfilePanel />)
    fireEvent.click(screen.getByRole('tab', { name: 'Computer' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Turn on Computer Use' }))
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith('scout', { tools: [...bot.tools, 'computer_use'] })
    )
    expect(api.computersGrant).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('says why when the list of computers fails, and shows no screen', async () => {
    api.computerStatus.mockResolvedValue(running)
    api.computerView.mockReset()
    useComputer.setState({ error: null, status: null })
    useConnection.setState({ target: { kind: 'local', origin: 'http://127.0.0.1:9119' } })
    seed([], false)
    api.computersList.mockRejectedValue(new Error('The daemon is busy'))
    useBots.setState({ byName: { scout: { ...bot, tools: ['computer_use'] } } })
    render(<ProfilePanel />)
    fireEvent.click(screen.getByRole('tab', { name: 'Computer' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('The daemon is busy')
    expect(screen.queryByTitle("Your bots' screen")).toBeNull()
    expect(api.computerView).not.toHaveBeenCalled()
  })

  it("waits for a reconnect's own list, not the grants it had before", async () => {
    let answer: (value: { computers: Computer[] }) => void = () => {}
    const granted = vmComputer({ desktop: { available: true, bots: ['scout'] } })

    api.computerStatus.mockResolvedValue(running)
    api.computerView.mockReset()
    api.computerView.mockResolvedValue({ control: false, expires_at: 0, path: '/v/#t' })
    useComputer.setState({ error: null, status: null })
    useConnection.setState({ target: { kind: 'local', origin: 'http://127.0.0.1:9119' } })
    seed([], false)
    api.computersList.mockResolvedValue({ computers: [granted] })
    useBots.setState({ byName: { scout: { ...bot, tools: ['computer_use'] } } })
    render(<ProfilePanel />)
    fireEvent.click(screen.getByRole('tab', { name: 'Computer' }))
    expect(await screen.findByTitle("Your bots' screen")).toBeVisible()

    // Back after a while away: the bot may have lost the computer meanwhile.
    const views = api.computerView.mock.calls.length

    api.computersList.mockReturnValue(
      new Promise(resolve => {
        answer = resolve
      })
    )
    act(() => useConnection.setState(state => ({ connects: state.connects + 1 })))
    await act(async () => {})
    expect(screen.queryByTitle("Your bots' screen")).toBeNull()
    expect(api.computerView).toHaveBeenCalledTimes(views)

    await act(async () => answer({ computers: [vmComputer()] }))
    expect(await screen.findByRole('button', { name: 'Turn on Computer Use' })).toBeVisible()
    expect(screen.queryByTitle("Your bots' screen")).toBeNull()
  })

  it("shows no screen from the grants it had when a reconnect's list fails", async () => {
    api.computerStatus.mockResolvedValue(running)
    api.computerView.mockReset()
    api.computerView.mockResolvedValue({ control: false, expires_at: 0, path: '/v/#t' })
    useComputer.setState({ error: null, status: null })
    useConnection.setState({ target: { kind: 'local', origin: 'http://127.0.0.1:9119' } })
    seed([], false)
    api.computersList.mockResolvedValue({
      computers: [vmComputer({ desktop: { available: true, bots: ['scout'] } })]
    })
    useBots.setState({ byName: { scout: { ...bot, tools: ['computer_use'] } } })
    render(<ProfilePanel />)
    fireEvent.click(screen.getByRole('tab', { name: 'Computer' }))
    expect(await screen.findByTitle("Your bots' screen")).toBeVisible()

    api.computersList.mockRejectedValue(new Error('The daemon is busy'))
    act(() => useConnection.setState(state => ({ connects: state.connects + 1 })))
    expect(await screen.findByRole('alert')).toHaveTextContent('The daemon is busy')
    expect(screen.queryByTitle("Your bots' screen")).toBeNull()
  })

  it('forgets a daemon from before computers when the app leaves it', async () => {
    useConnection.setState({ target: { kind: 'local', origin: 'http://127.0.0.1:9119' } })
    seed([], false)
    await useComputers.getState().refresh()
    expect(useComputers.getState()).toMatchObject({ older: true })

    clearPersonalState()
    expect(useComputers.getState()).toMatchObject({ answered: null, computers: null, older: false })

    // A later failure of another kind is not a daemon from before computers.
    useComputers.setState({ older: true })
    api.computersList.mockRejectedValue(new Error('The daemon is busy'))
    await useComputers.getState().refresh()
    expect(useComputers.getState()).toMatchObject({ answered: null, older: false })
  })

  it('keeps only the latest read of the computers, whichever answers last', async () => {
    const answers: ((value: { computers: Computer[] }) => void)[] = []

    useConnection.setState({ target: { kind: 'local', origin: 'http://127.0.0.1:9119' } })
    seed([], false)
    api.computersList.mockImplementation(
      () =>
        new Promise(resolve => {
          answers.push(resolve)
        })
    )
    // The first read still names the grant; the second, after it was taken back, doesn't.
    const first = useComputers.getState().refresh()
    const second = useComputers.getState().refresh()

    answers[1]?.({ computers: [vmComputer()] })
    await second
    answers[0]?.({ computers: [vmComputer({ desktop: { available: true, bots: ['scout'] } })] })
    await first
    expect(useComputers.getState().computers?.[0]?.desktop.bots).toEqual([])
  })

  it("shows no earlier connection's error while this one's list is on its way", async () => {
    api.computerStatus.mockResolvedValue(running)
    useComputer.setState({ error: null, status: null })
    useConnection.setState({ target: { kind: 'local', origin: 'http://127.0.0.1:9119' } })
    seed([], false)
    api.computersList.mockReturnValue(new Promise(() => {}))
    useComputers.setState({
      error: 'Could not forget the computer',
      listFailed: { connects: useConnection.getState().connects - 1, message: 'The daemon is busy' }
    })
    useBots.setState({ byName: { scout: { ...bot, tools: ['computer_use'] } } })
    render(<ProfilePanel />)
    fireEvent.click(screen.getByRole('tab', { name: 'Computer' }))
    await waitFor(() => expect(useComputer.getState().status).not.toBeNull())
    await act(async () => {})
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByTitle("Your bots' screen")).toBeNull()
  })

  it('reads a failed list again when the computers change, or on Try again', async () => {
    api.computerStatus.mockResolvedValue({ ...running, state: 'stopped' as const })
    useComputer.setState({ error: null, status: null })
    useConnection.setState({ target: { kind: 'local', origin: 'http://127.0.0.1:9119' } })
    seed([], false)
    api.computersList.mockRejectedValue(new Error('The daemon is busy'))
    render(<ProfilePanel />)
    fireEvent.click(screen.getByRole('tab', { name: 'Computer' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('The daemon is busy')

    const reads = api.computersList.mock.calls.length

    await useComputers.getState().refreshLoaded()
    expect(api.computersList).toHaveBeenCalledTimes(reads + 1)

    api.computersList.mockResolvedValue({ computers: [vmComputer()] })
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('button', { name: 'Turn on Computer Use' })).toBeVisible()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('reads again when the computers change during the first read', async () => {
    const answers: ((value: { computers: Computer[] }) => void)[] = []

    useConnection.setState({ target: { kind: 'local', origin: 'http://127.0.0.1:9119' } })
    seed([], false)
    api.computersList.mockImplementation(
      () =>
        new Promise(resolve => {
          answers.push(resolve)
        })
    )
    // The first read names the grant; it is taken back before that read answers.
    const first = useComputers.getState().refresh()
    const changed = useComputers.getState().refreshLoaded()

    expect(api.computersList).toHaveBeenCalledTimes(2)
    answers[0]?.({ computers: [vmComputer({ desktop: { available: true, bots: ['scout'] } })] })
    await first
    expect(useComputers.getState().computers).toBeNull()
    answers[1]?.({ computers: [vmComputer()] })
    await changed
    expect(useComputers.getState().computers?.[0]?.desktop.bots).toEqual([])
  })

  it('drops the list it had when the daemon turns out to be from before computers', async () => {
    api.computerStatus.mockResolvedValue(running)
    api.computerView.mockReset()
    api.computerView.mockResolvedValue({ control: false, expires_at: 0, path: '/v/#t' })
    useComputer.setState({ error: null, status: null })
    useConnection.setState({ target: { kind: 'local', origin: 'http://127.0.0.1:9119' } })
    seed([], false)
    // A current daemon with the bots' computer off.
    api.computersList.mockResolvedValue({ computers: [vmComputer({ on: false })] })
    useBots.setState({ byName: { scout: { ...bot, tools: ['computer_use'] } } })
    render(<ProfilePanel />)
    fireEvent.click(screen.getByRole('tab', { name: 'Computer' }))
    expect(await screen.findByText(/Your bots aren't using their computer/)).toBeVisible()

    // Rolled back: the same address now answers without computers.
    api.computersList.mockRejectedValue(olderDaemon())
    act(() => useConnection.setState(state => ({ connects: state.connects + 1 })))
    expect(await screen.findByTitle("Your bots' screen")).toBeVisible()
    expect(useComputers.getState().computers).toBeNull()
  })

  it('drops a failure from a daemon the app has since left', async () => {
    let fail: (reason: Error) => void = () => {}

    useConnection.setState({ target: { kind: 'local', origin: 'http://127.0.0.1:9119' } })
    seed([], false)
    api.computersGrant.mockReset()
    api.computersGrant.mockReturnValue(
      new Promise((_, reject) => {
        fail = reject
      })
    )
    const change = useComputers.getState().grant('vm', 'terminal', 'scout', true)

    // Switched to another daemon while it waited; that one starts clean.
    useConnection.setState({
      target: { deviceToken: 't', host: '192.168.0.9', kind: 'remote', port: 9119, tls: true }
    })
    clearPersonalState()
    fail(new Error('daemon A connection closed'))
    await change
    expect(useComputers.getState()).toMatchObject({ error: null, notices: [] })
  })
})
