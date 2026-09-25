import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { Avatar } from '../components/ui/avatar'
import { HEXBOT_ACT_NAMES } from '../components/ui/hexbot-act'
import { HexbotMark } from '../components/ui/wordmark'
import { setActiveRpc } from '../lib/rpc'
import {
  AboutStep,
  ChoiceStep,
  compileAboutYou,
  initialOnboardingStep,
  installPercent,
  InstallStep,
  JobsStep,
  MeetStep,
  ToolsStep,
  WelcomeStep
} from '../routes/onboarding'

describe('onboarding', () => {
  it.each([
    [{ connected: false, hasBots: false, hasLocalRuntime: true, isElectron: true }, 'choice'],
    [{ connected: false, hasBots: false, hasLocalRuntime: false, isElectron: true }, 'connect'],
    [{ connected: true, hasBots: false, hasLocalRuntime: true, isElectron: true }, 'about'],
    [{ connected: false, hasBots: false, hasLocalRuntime: false, isElectron: false }, 'about'],
    [{ connected: true, hasBots: true, hasLocalRuntime: false, isElectron: false }, 'existing']
  ] as const)('selects the initial step for %o', (input, expected) => {
    expect(initialOnboardingStep(input)).toBe(expected)
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
      <InstallStep
        progress={[uv, { message: 'Installing locked dependencies', stage: 'dependencies' }]}
      />
    )
    expect(screen.getByRole('status')).toHaveTextContent('Installing dependencies')
    expect(document.querySelector('[data-act]')).toHaveAttribute('data-act', 'type')
    expect(Number(screen.getByRole('progressbar').getAttribute('aria-valuenow'))).toBeGreaterThan(
      before
    )
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
    expect(installPercent([line('uv', 50)])).toBe(3)
    expect(installPercent([line('uv', 50), line('python')])).toBeGreaterThanOrEqual(5)
    expect(installPercent([line('dependencies'), line('error')])).toBeGreaterThanOrEqual(30)
    expect(installPercent([line('done', 100)])).toBe(95)
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
