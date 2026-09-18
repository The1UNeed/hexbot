import { act, fireEvent, render, screen } from '@testing-library/react'

import { Avatar } from '../components/ui/avatar'
import { HEXBOT_ACT_NAMES } from '../components/ui/hexbot-act'
import { HexbotMark } from '../components/ui/wordmark'
import {
  initialOnboardingStep,
  installPercent,
  InstallStep,
  JobsStep,
  MeetStep,
  OnboardingChoiceCards,
  WelcomeStep
} from '../routes/onboarding'

describe('onboarding', () => {
  it.each([
    [{ connected: false, hasBots: false, hasLocalRuntime: true, isElectron: true }, 'choice'],
    [{ connected: false, hasBots: false, hasLocalRuntime: false, isElectron: true }, 'connect'],
    [{ connected: true, hasBots: false, hasLocalRuntime: true, isElectron: true }, 'providers'],
    [{ connected: false, hasBots: false, hasLocalRuntime: false, isElectron: false }, 'providers'],
    [{ connected: true, hasBots: true, hasLocalRuntime: false, isElectron: false }, 'existing']
  ] as const)('selects the initial step for %o', (input, expected) => {
    expect(initialOnboardingStep(input)).toBe(expected)
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

  it('renders the two Electron choices as descriptive cards', () => {
    render(<OnboardingChoiceCards onConnect={vi.fn()} onLocal={vi.fn()} />)

    expect(screen.getByRole('button', { name: /Connect to a Hexbot daemon/ })).toHaveTextContent(
      'Pair with a daemon on your network or a Tailscale address.'
    )
    expect(screen.getByRole('button', { name: /Run Hexbot on this machine/ })).toHaveTextContent(
      'Install the runtime on this computer and run bots here.'
    )
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
})
