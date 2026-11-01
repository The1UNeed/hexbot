import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider
} from '@tanstack/react-router'
import type * as Router from '@tanstack/react-router'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentType } from 'react'

import { ChatChooser } from '../app/chat-chooser'
import { Avatar } from '../components/ui/avatar'
import { HEXBOT_ACT_NAMES } from '../components/ui/hexbot-act'
import { HexbotMark } from '../components/ui/wordmark'
import { setActiveRpc } from '../lib/rpc'
import type { Bot } from '../lib/types'
import {
  AboutStep,
  ChoiceStep,
  compileAboutYou,
  createHexBot,
  initialOnboardingStep,
  installFailure,
  installPercent,
  InstallStep,
  JobsStep,
  landingSection,
  MeetStep,
  Route,
  ToolsStep,
  WelcomeStep
} from '../routes/onboarding'
import { useBots } from '../stores/bots'
import { useConnection } from '../stores/connection'

const ui = vi.hoisted(() => ({
  lastSection: null as { bot: string; section: string } | null,
  setLastSection: vi.fn()
}))

const navigate = vi.hoisted(() => vi.fn())

vi.mock('../stores/ui', () => ({ uiActions: () => ui }))

vi.mock('@tanstack/react-router', async importOriginal => ({
  ...(await importOriginal<typeof Router>()),
  useNavigate: () => navigate
}))

async function renderPage(chooser = false) {
  const OnboardingPage = Route.options.component as ComponentType

  const root = createRootRoute({
    component: () => (
      <>
        <OnboardingPage />
        {chooser ? <ChatChooser /> : null}
      </>
    )
  })

  const page = createRoute({ getParentRoute: () => root, path: '/onboarding' })

  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ['/onboarding'] }),
    routeTree: root.addChildren([page])
  })

  await router.load()

  return render(<RouterProvider router={router} />)
}

describe('onboarding', () => {
  it.each([
    [{ connected: false, hasLocalRuntime: true, isElectron: true }, 'choice'],
    [{ connected: false, hasLocalRuntime: false, isElectron: true }, 'connect'],
    [{ connected: true, hasLocalRuntime: true, isElectron: true }, 'deciding'],
    [{ connected: false, hasLocalRuntime: false, isElectron: false }, 'deciding'],
    [{ connected: true, hasLocalRuntime: false, isElectron: false }, 'deciding']
  ] as const)('selects the initial step for %o', (input, expected) => {
    expect(initialOnboardingStep(input)).toBe(expected)
  })

  it('lands in the chat the daemon names for the bot the user was with', async () => {
    const bot = (name: string, sections: string[]) =>
      ({ name, sections_recent: sections.map(id => ({ id })) }) as unknown as Bot

    const call = vi.fn((method: string, params?: { bot?: string }) =>
      Promise.resolve(
        method === 'hexbot.info' ? { one_chat: true } : { section: { id: `chat-${params?.bot}` } }
      )
    )

    setActiveRpc({ call } as never)

    expect(await landingSection([])).toBeNull()

    // The section remembered here may be gone since the upgrade, or set aside by recovery.
    ui.lastSection = { bot: 'scout', section: 's-old' }
    expect(await landingSection([bot('bea', ['s-2']), bot('scout', [])])).toEqual({
      bot: 'scout',
      section: 'chat-scout'
    })
    expect(call).toHaveBeenCalledWith('hexbot.sections.create', { bot: 'scout' })

    // A bot talked to before, not its recent list: one recovery set aside is never its chat.
    ui.lastSection = { bot: 'gone', section: 's-x' }
    expect(await landingSection([bot('quiet', []), bot('bea', ['s-2'])])).toEqual({
      bot: 'bea',
      section: 'chat-bea'
    })

    expect(await landingSection([bot('quiet', [])])).toEqual({
      bot: 'quiet',
      section: 'chat-quiet'
    })
    expect(call).toHaveBeenCalledWith('hexbot.sections.create', { bot: 'quiet' })
    ui.lastSection = null
  })

  it('keeps the section the user was in on an older daemon, which names no chat', async () => {
    const call = vi.fn((_method: string) => Promise.resolve({ version: '0.1.6' }))
    setActiveRpc({ call } as never)
    ui.lastSection = { bot: 'scout', section: 's-picked' }

    expect(
      await landingSection([{ name: 'scout', sections_recent: [] } as unknown as Bot])
    ).toEqual({ bot: 'scout', section: 's-picked' })
    // Not asked again which section, and none made.
    expect(call.mock.calls.map(([method]) => method)).toEqual(['hexbot.info'])
    ui.lastSection = null
  })

  it('offers Continue, not provider setup, when no section is picked on an older daemon', async () => {
    const ada = { display_name: 'Ada', name: 'ada', sections_recent: [{ id: 'trip' }] } as never

    const said = (id: string, updated_at: number) => ({
      archived_at: null,
      bot: 'ada',
      id,
      message_count: 4,
      peer_bot: null,
      preview: '',
      title: id,
      updated_at
    })

    const call = vi.fn((method: string) =>
      Promise.resolve(
        {
          'hexbot.bots.list': { bots: [ada] },
          'hexbot.memory.user.get': { cap: 2000, text: 'Name: Alex', updated_at: 1 },
          'hexbot.sections.list': { sections: [said('Night notes', 9), said('Trip', 5)] },
          'hexbot.sections.unarchive': { section: said('Trip', 20) }
        }[method] ?? {}
      )
    )

    setActiveRpc({ call } as never)
    navigate.mockClear()
    ui.setLastSection.mockClear()
    useConnection.setState({ daemon: { version: '0.1.6' } as never, status: 'connected' })
    useBots.setState({ byName: { ada }, loaded: true, order: ['ada'] } as never)

    try {
      await renderPage(true)

      fireEvent.keyDown(await screen.findByRole('dialog'), { key: 'Escape' })

      expect(await screen.findByRole('heading', { name: 'Continue with Ada' })).toBeVisible()
      expect(screen.queryByText('Connect a provider')).toBeNull()
      expect(navigate).not.toHaveBeenCalled()
      expect(call).not.toHaveBeenCalledWith('hexbot.sections.create', expect.anything())
      expect(call).not.toHaveBeenCalledWith('hexbot.sections.unarchive', expect.anything())

      // Continue asks again, and opens what is picked.
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
      fireEvent.click(await screen.findByRole('button', { name: /Trip/ }))

      await waitFor(() =>
        expect(navigate).toHaveBeenCalledWith({
          params: { bot: 'ada', section: 'Trip' },
          to: '/b/$bot/s/$section'
        })
      )
      expect(ui.setLastSection).toHaveBeenCalledWith({ bot: 'ada', section: 'Trip' })
      expect(call).toHaveBeenCalledWith('hexbot.sections.unarchive', { id: 'Trip' })
      expect(call).not.toHaveBeenCalledWith('hexbot.sections.create', expect.anything())
    } finally {
      useConnection.setState({ daemon: null, status: 'idle' } as never)
      useBots.setState({ byName: {}, loaded: false, order: [] } as never)
    }
  })

  it('keeps a failed canonical chat on Continue and retries without opening the saved section', async () => {
    const bot = { display_name: 'Scout', name: 'scout', sections_recent: [] } as never
    const create = vi.fn().mockRejectedValueOnce(new Error('Chat unavailable'))

    const call = vi.fn((method: string) => {
      if (method === 'hexbot.sections.create') {
        return create()
      }

      return Promise.resolve(
        {
          'hexbot.bots.list': { bots: [bot] },
          'hexbot.memory.user.get': { cap: 2000, text: 'Name: Alex', updated_at: 1 }
        }[method] ?? {}
      )
    })

    setActiveRpc({ call } as never)
    navigate.mockClear()
    ui.setLastSection.mockClear()
    ui.lastSection = { bot: 'scout', section: 'quarantined' }
    useConnection.setState({ daemon: { one_chat: true } as never, status: 'connected' })
    useBots.setState({ byName: { scout: bot }, loaded: true, order: ['scout'] } as never)

    try {
      await renderPage()

      expect(await screen.findByRole('heading', { name: 'Continue with Scout' })).toBeVisible()
      expect(screen.getByRole('alert')).toHaveTextContent('Chat unavailable')
      expect(screen.queryByText('Connect a provider')).toBeNull()
      expect(navigate).not.toHaveBeenCalled()
      expect(ui.setLastSection).not.toHaveBeenCalled()

      let resolve!: (value: { section: { id: string } }) => void
      create.mockImplementationOnce(() => new Promise(done => (resolve = done)))
      const button = screen.getByRole('button', { name: 'Continue' })
      fireEvent.click(button)
      expect(button).toBeDisabled()
      await waitFor(() => expect(create).toHaveBeenCalledTimes(2))
      await act(async () => resolve({ section: { id: 'canonical' } }))

      expect(navigate).toHaveBeenCalledWith({
        params: { bot: 'scout', section: 'canonical' },
        to: '/b/$bot/s/$section'
      })
      expect(ui.setLastSection).toHaveBeenCalledWith({ bot: 'scout', section: 'canonical' })
      expect(call).not.toHaveBeenCalledWith('hexbot.sections.list', expect.anything())
    } finally {
      ui.lastSection = null
      useConnection.setState({ daemon: null, status: 'idle' } as never)
      useBots.setState({ byName: {}, loaded: false, order: [] } as never)
    }
  })

  it('compiles the init page answers into About you, skipping blanks', () => {
    expect(compileAboutYou({ name: ' Alex ', preferences: 'Short answers.', work: '' })).toBe(
      'Name: Alex\nHow to talk to me: Short answers.'
    )
    expect(compileAboutYou({ name: '', preferences: '', work: '' })).toBe('')
  })

  it('asks for a name and preferences and saves them as About you', async () => {
    const call = vi.fn(() => Promise.resolve({ cap: 2000, text: '', updated_at: 1 }))
    setActiveRpc({ call } as never)
    const onContinue = vi.fn()
    render(<AboutStep onContinue={onContinue} onError={vi.fn()} />)

    const submit = screen.getByRole('button', { name: 'Continue' })
    expect(submit).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Alex' } })
    fireEvent.change(screen.getByLabelText('What you do'), {
      target: { value: 'I run a small design studio.' }
    })
    fireEvent.change(screen.getByLabelText(/How your bots should talk to you/), {
      target: { value: 'Short, direct answers.' }
    })
    expect(submit).toBeEnabled()
    fireEvent.click(submit)

    await waitFor(() => expect(onContinue).toHaveBeenCalledOnce())
    expect(call).toHaveBeenCalledWith('hexbot.memory.user.set', {
      text: 'Name: Alex\nWhat I do: I run a small design studio.\nHow to talk to me: Short, direct answers.'
    })
  })

  it('saves the name first, and keeps About you unsaved if that fails', async () => {
    const call = vi.fn((method: string) =>
      method === 'hexbot.users.me.set'
        ? Promise.reject(new Error('connection lost'))
        : Promise.resolve({ cap: 2000, text: '', updated_at: 1 })
    )

    setActiveRpc({ call } as never)
    const onContinue = vi.fn()
    const onError = vi.fn()
    render(<AboutStep onContinue={onContinue} onError={onError} />)

    expect(screen.getByLabelText('Your name')).toHaveAttribute('maxLength', '64')
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Alex' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    await waitFor(() => expect(onError).toHaveBeenCalledOnce())
    expect(onContinue).not.toHaveBeenCalled()
    expect(call).not.toHaveBeenCalledWith('hexbot.memory.user.set', expect.anything())
  })

  it('saves legacy About you when the daemon has no rename method', async () => {
    const call = vi.fn((method: string) =>
      method === 'hexbot.users.me.set'
        ? Promise.reject({ code: -32601, message: 'Unknown method' })
        : Promise.resolve({ cap: 2000, text: 'Name: Alex', updated_at: 1 })
    )

    setActiveRpc({ call } as never)
    const onContinue = vi.fn()
    const onError = vi.fn()
    render(<AboutStep onContinue={onContinue} onError={onError} />)
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Alex' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(onContinue).toHaveBeenCalledOnce())
    expect(call).toHaveBeenCalledWith('hexbot.memory.user.set', { text: 'Name: Alex' })
    expect(onError).not.toHaveBeenCalled()
  })

  it('records a skip so the init page is not asked again', async () => {
    const call = vi.fn(() => Promise.resolve({ cap: 2000, text: '', updated_at: 1 }))
    setActiveRpc({ call } as never)
    const onContinue = vi.fn()
    render(<AboutStep onContinue={onContinue} onError={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Skip' }))
    await waitFor(() => expect(onContinue).toHaveBeenCalledOnce())
    expect(call).toHaveBeenCalledWith('hexbot.memory.user.set', { text: '' })
  })

  it('opens on a welcome screen with one way forward', () => {
    const onStart = vi.fn()
    render(<WelcomeStep onStart={onStart} />)

    expect(screen.getByText('Hexbot')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Get started/ }))
    expect(onStart).toHaveBeenCalledOnce()
  })

  it('walks the tour with Next and Back', () => {
    const next = vi.fn()
    const back = vi.fn()
    const { unmount } = render(<MeetStep back={back} next={next} />)

    expect(screen.getByRole('heading', { name: 'Meet Hexbot' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(next).toHaveBeenCalledOnce()
    unmount()

    render(<JobsStep back={back} next={next} />)
    expect(screen.getByText('Release notes')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(back).toHaveBeenCalledOnce()
  })

  it('offers this computer, another device, and a way back', () => {
    const [back, onConnect, onLocal] = [vi.fn(), vi.fn(), vi.fn()]
    render(<ChoiceStep back={back} onConnect={onConnect} onLocal={onLocal} />)

    fireEvent.click(screen.getByRole('button', { name: 'On this computer' }))
    fireEvent.click(screen.getByRole('button', { name: 'On another device' }))
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(onLocal).toHaveBeenCalledOnce()
    expect(onConnect).toHaveBeenCalledOnce()
    expect(back).toHaveBeenCalledOnce()
  })

  it('shows the install stage, its act, the live line, and a percentage', () => {
    const uv = { message: 'downloading uv 0.12.16 aarch64-apple-darwin', stage: 'uv' }
    const { rerender } = render(<InstallStep progress={[uv]} />)

    expect(screen.getByRole('status')).toHaveTextContent('Fetching the installer')
    expect(screen.getAllByText(/downloading uv 0\.12\.16/).length).toBeGreaterThan(0)
    expect(document.querySelector('[data-act]')).toHaveAttribute('data-act', 'catch')

    const before = Number(screen.getByRole('progressbar').getAttribute('aria-valuenow'))
    rerender(
      <InstallStep progress={[uv, { message: 'Installing voice tools', stage: 'dependencies' }]} />
    )
    expect(screen.getByRole('status')).toHaveTextContent('Installing voice tools')
    expect(document.querySelector('[data-act]')).toHaveAttribute('data-act', 'type')
    expect(Number(screen.getByRole('progressbar').getAttribute('aria-valuenow'))).toBeGreaterThan(
      before
    )
  })

  it('stops a failed install, says so plainly, keeps the cause in the log, and offers Try again', () => {
    const cause = installFailure(
      new Error(
        "Error invoking remote method 'hexbot:daemon:start': Error: C:\\Hexbot\\hexbot.exe exited with code 0xC0000135"
      )
    )

    expect(cause).toBe('C:\\Hexbot\\hexbot.exe exited with code 0xC0000135')
    const onRetry = vi.fn()
    render(
      <InstallStep
        error={cause}
        onRetry={onRetry}
        progress={[{ message: 'Preparing Hexbot runtime', stage: 'runtime' }]}
      />
    )

    expect(screen.getByRole('alert')).toHaveTextContent('Hexbot could not start on this computer.')
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
    expect(screen.queryByText('Unpacking Hexbot')).not.toBeInTheDocument()
    expect(document.querySelector('[data-act]')).toBeNull()
    expect(screen.getByText(/exited with code 0xC0000135/)).toBeVisible()
    expect(screen.queryByText(/Error invoking remote method/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('works through the acts of a long stage', () => {
    vi.useFakeTimers()
    render(<InstallStep progress={[{ message: 'resolving', stage: 'dependencies' }]} />)

    const seen = new Set<string>()

    for (let turn = 0; turn < 11; turn += 1) {
      seen.add(document.querySelector('[data-act]')!.getAttribute('data-act')!)
      act(() => void vi.advanceTimersByTime(6000))
    }

    expect(seen.size).toBe(11)
    vi.useRealTimers()
  })

  it('has at least twenty acts, and each one renders', () => {
    expect(HEXBOT_ACT_NAMES.length).toBeGreaterThanOrEqual(20)

    for (const name of HEXBOT_ACT_NAMES) {
      const { container, unmount } = render(<HexbotMark act={name} />)

      expect(container.querySelector(`[data-act="${name}"]`)?.childElementCount).toBeGreaterThan(0)
      unmount()
    }
  })

  it('plays a random act when any Hexbot is clicked, then stops', () => {
    vi.useFakeTimers()
    const { container } = render(<Avatar name="Scout" />)

    expect(container.querySelector('[data-act]')).toBeNull()
    fireEvent.click(screen.getByRole('img', { name: 'Scout' }))
    expect(container.querySelector('[data-act]')).not.toBeNull()
    act(() => void vi.advanceTimersByTime(4000))
    expect(container.querySelector('[data-act]')).toBeNull()
    vi.useRealTimers()
  })

  it('moves the install percentage forward and never back', () => {
    const line = (stage: string, percent?: number) => ({ message: stage, percent, stage })

    expect(installPercent([])).toBe(0)
    expect(installPercent([line('runtime', 50)])).toBe(10)
    expect(installPercent([line('runtime'), line('uv', 50)])).toBe(23)
    expect(installPercent([line('uv', 50), line('python')])).toBeGreaterThanOrEqual(5)
    expect(installPercent([line('dependencies'), line('error')])).toBeGreaterThanOrEqual(30)
    expect(installPercent([line('done', 100)])).toBe(95)

    // A first launch as the desktop reports it: stages in order, some with a
    // percent, some only with log lines.
    const progress = [
      line('runtime', 30),
      line('runtime', 90),
      line('uv'),
      line('uv', 50),
      line('python'),
      line('python'),
      line('python'),
      line('dependencies', 10),
      line('dependencies', 80),
      line('done', 100)
    ]

    const values = progress.map((_, index) => installPercent(progress.slice(0, index + 1)))
    expect(values).toEqual([6, 18, 20, 23, 26, 27, 27, 64, 88, 95])
  })

  it('creates HexBot, and an ordinary bot of that name on an older daemon', async () => {
    const created = { bot: { name: 'hexbot' }, section: { id: 'general' } }

    const call = vi.fn((method: string) =>
      method === 'hexbot.bots.create_primary'
        ? Promise.reject(Object.assign(new Error('unknown method'), { code: -32601 }))
        : Promise.resolve(created)
    )

    setActiveRpc({ call } as never)
    expect(await createHexBot('openai/gpt-5', null)).toEqual(created)
    expect(call).toHaveBeenCalledWith('hexbot.bots.create_primary', {
      model: 'gpt-5',
      provider: 'openai'
    })
    expect(call).toHaveBeenCalledWith('hexbot.bots.create', {
      display_name: 'HexBot',
      model: 'gpt-5',
      name: 'hexbot',
      provider: 'openai'
    })

    const face = { color: 'orange', shape: 'pill' }
    const picked = vi.fn(() => Promise.resolve(created))
    setActiveRpc({ call: picked } as never)
    await createHexBot(null, 'data:image/png;base64,iVBORw0KGgo=', face)
    expect(picked).toHaveBeenCalledWith('hexbot.bots.create_primary', {
      avatar: 'data:image/png;base64,iVBORw0KGgo=',
      face
    })

    const failing = vi.fn(() => Promise.reject(new Error('The daemon is stopping.')))
    setActiveRpc({ call: failing } as never)
    await expect(createHexBot(null, null)).rejects.toThrow('The daemon is stopping.')
    expect(failing).toHaveBeenCalledOnce()
  })

  it('opens HexBot when an earlier create went through, and says why when it cannot', async () => {
    const general = { id: 'general', bot: 'helper', message_count: 0 }
    const hexbot = { name: 'helper', primary: true }
    const taken = Object.assign(new Error('There is already a primary bot.'), { code: 4214 })

    // The daemon names HexBot's chat; its list could hold one recovery set aside.
    const answer = (bots: object[]) =>
      vi.fn((method: string) =>
        method === 'hexbot.bots.list'
          ? Promise.resolve({ bots })
          : method === 'hexbot.sections.create'
            ? Promise.resolve({ section: general })
            : Promise.reject(taken)
      )

    useConnection.setState({ daemon: { one_chat: true } as never })
    setActiveRpc({ call: answer([{ name: 'owl' }, hexbot]) } as never)
    expect(await createHexBot(null, null)).toEqual({ bot: hexbot, section: general })

    setActiveRpc({ call: answer([]) } as never)
    await expect(createHexBot(null, null)).rejects.toBe(taken)

    // An older daemon has no create_primary and refuses a second bot called hexbot.
    const exists = Object.assign(new Error('bot already exists: hexbot'), { code: 4208 })
    const kept = { id: 'general', bot: 'hexbot', message_count: 2 }

    const older = (bots: object[], sections: object[]) =>
      vi.fn((method: string) =>
        method === 'hexbot.bots.list'
          ? Promise.resolve({ bots })
          : method === 'hexbot.sections.list'
            ? Promise.resolve({ sections })
            : method === 'hexbot.sections.unarchive'
              ? Promise.resolve({ section: kept })
              : Promise.reject(
                  method === 'hexbot.bots.create_primary'
                    ? Object.assign(new Error('unknown method'), { code: -32601 })
                    : exists
                )
      )

    const plain = { name: 'hexbot' }
    useConnection.setState({ daemon: { one_chat: false } as never })
    setActiveRpc({ call: older([plain], [kept]) } as never)
    expect(await createHexBot(null, null)).toEqual({ bot: plain, section: kept })

    setActiveRpc({ call: older([], []) } as never)
    await expect(createHexBot(null, null)).rejects.toBe(exists)
    useConnection.setState({ daemon: null })
  })

  it('sets up web search before the first bot, and lets you skip', async () => {
    const tool = (patch: object) => ({
      description: 'Search the web and read pages.',
      enabled_bots: [],
      enabled_for_bot: null,
      fields: [
        {
          advanced: false,
          help: '',
          hint: null,
          key: 'TAVILY_API_KEY',
          label: 'Tavily API key',
          provider: 'tavily',
          secret: true,
          set: false,
          url: null
        }
      ],
      group: 'search',
      icon: 'glyph:search',
      id: 'web_search',
      last_error: null,
      name: 'Web search',
      provider: null,
      providers: [{ configured: false, id: 'tavily', label: 'Tavily' }],
      scope: 'daemon',
      state: 'not_set_up',
      state_text: 'Not set up',
      ...patch
    })

    const call = vi.fn((method: string) =>
      Promise.resolve(
        method === 'hexbot.connectors.list'
          ? { connectors: [tool({}), tool({ group: 'work', id: 'notion', name: 'Notion' })] }
          : {
              connector: tool({ state: 'ready', state_text: 'Key saved · Tavily' }),
              test: { message: 'Key saved.', ok: true }
            }
      )
    )

    setActiveRpc({ call } as never)

    const onContinue = vi.fn()
    render(<ToolsStep onContinue={onContinue} onError={vi.fn()} />)

    // Web search is open already; work connectors wait for bot settings.
    const key = await screen.findByLabelText('Tavily API key')
    expect(screen.queryByText('Notion')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Skip for now' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Save and test' })).toBeDisabled()

    fireEvent.change(key, { target: { value: ' tvly-1 ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save and test' }))
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('hexbot.connectors.setup', {
        id: 'web_search',
        provider: 'tavily',
        values: { TAVILY_API_KEY: 'tvly-1' }
      })
    )
    expect(await screen.findByText('Key saved · Tavily')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(onContinue).toHaveBeenCalledOnce()
  })
})
