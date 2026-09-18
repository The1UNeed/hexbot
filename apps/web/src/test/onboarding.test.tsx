import { act, fireEvent, render, screen } from '@testing-library/react'

import {
  initialOnboardingStep,
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

  it('shows what the install is doing and for how long', () => {
    vi.useFakeTimers()
    render(
      <InstallStep
        progress={[{ message: 'downloading uv 0.12.16 aarch64-apple-darwin', stage: 'uv' }]}
      />
    )

    expect(screen.getByRole('status')).toHaveTextContent('Fetching the installer')
    expect(screen.getByRole('timer')).toHaveTextContent('0:00')
    act(() => void vi.advanceTimersByTime(65_000))
    expect(screen.getByRole('timer')).toHaveTextContent('1:05')
    expect(screen.getByText(/downloading uv 0\.12\.16/)).toBeInTheDocument()
    vi.useRealTimers()
  })
})
