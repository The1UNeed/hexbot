import { render, screen } from '@testing-library/react'

import { initialOnboardingStep, OnboardingChoiceCards } from '../routes/onboarding'

describe('onboarding', () => {
  it.each([
    [{ connected: false, hasBots: false, isElectron: true }, 'choice'],
    [{ connected: true, hasBots: false, isElectron: true }, 'providers'],
    [{ connected: false, hasBots: false, isElectron: false }, 'providers'],
    [{ connected: true, hasBots: true, isElectron: false }, 'existing']
  ] as const)('selects the initial step for %o', (input, expected) => {
    expect(initialOnboardingStep(input)).toBe(expected)
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
})
