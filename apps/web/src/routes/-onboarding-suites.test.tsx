import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Plugin } from '../lib/types'
import { usePlugins } from '../stores/plugins'

// The sheet shows the account status of the plugin it is given.
vi.mock('../app/settings/plugin-sheet', () => ({
  PluginSheet: ({ plugin }: { plugin: Plugin }) => (
    <div data-testid="sheet">{plugin.connector?.account?.signed_in ? 'Signed in' : 'Sign-in stopped working'}</div>
  )
}))

import { AccountSuites } from './onboarding'

const outlook = (signedIn: boolean) =>
  ({
    connector: { account: { signed_in: signedIn }, family: 'microsoft' },
    icon: 'outlook',
    id: 'outlook',
    kind: 'connector',
    ready: signedIn
  }) as unknown as Plugin

describe('account suites in setup', () => {
  beforeEach(() => {
    usePlugins.setState({ plugins: [outlook(false)], refresh: async () => {} })
  })

  it('shows the new status in an open sheet once a sign-in refreshes the list', () => {
    render(<AccountSuites />)
    fireEvent.click(screen.getByTestId('onboarding-suite-microsoft'))
    expect(screen.getByTestId('sheet')).toHaveTextContent('Sign-in stopped working')
    // Signing in replaces the store's plugin objects.
    act(() => usePlugins.setState({ plugins: [outlook(true)] }))
    expect(screen.getByTestId('sheet')).toHaveTextContent('Signed in')
  })
})
