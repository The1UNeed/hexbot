import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { settingsGet, settingsSet } from '../../lib/api'
import type { HexbotBridge } from '../../lib/bridge'
import type { Settings } from '../../lib/types'
import { UsageStep } from '../../routes/onboarding'
import { useSettings } from '../../stores/settings'

import { PrivacySettings } from './privacy'

vi.mock('../../lib/api', async importOriginal => ({
  ...(await importOriginal()),
  settingsGet: vi.fn(),
  settingsSet: vi.fn()
}))

const daemon = (usage_data?: boolean) => ({ approval_mode: 'smart', usage_data }) as Settings

function appBridge(state = { crashReports: false, usageData: false }) {
  const bridge = {
    openExternal: vi.fn(),
    privacy: vi.fn(async () => ({
      ...state,
      crashReportsAvailable: true,
      usageDataAvailable: true
    })),
    setCrashReports: vi.fn(async (on: boolean) => void (state.crashReports = on)),
    setUsageData: vi.fn(async (on: boolean) => void (state.usageData = on))
  }

  window.hexbot = bridge as unknown as HexbotBridge

  return bridge
}

const switchNamed = (name: string) => screen.getByRole('switch', { name })

beforeEach(() => {
  vi.clearAllMocks()
  delete window.hexbot
})
afterEach(() => {
  delete window.hexbot
})

describe('Settings, Privacy', () => {
  it('shows the daemon switch off and saves a change to the daemon', async () => {
    const patch = vi.fn(async () => undefined)
    useSettings.setState({ patch, refresh: vi.fn(async () => undefined), settings: daemon(false) })
    render(<PrivacySettings />)

    const toggle = switchNamed('Share anonymous usage data from the daemon')
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    expect(screen.queryByText('This app')).toBeNull()
    fireEvent.click(toggle)
    expect(patch).toHaveBeenCalledWith({ usage_data: true })
  })

  it('asks for a daemon update instead of a switch when the daemon predates usage data', () => {
    useSettings.setState({
      patch: vi.fn(),
      refresh: vi.fn(async () => undefined),
      settings: daemon()
    })
    render(<PrivacySettings />)
    expect(screen.getByText('Update the daemon to choose what it shares.')).toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: /from the daemon/ })).toBeNull()
  })

  it("controls the desktop app's own usage data and crash reports", async () => {
    const bridge = appBridge()
    useSettings.setState({
      patch: vi.fn(),
      refresh: vi.fn(async () => undefined),
      settings: daemon(false)
    })
    render(<PrivacySettings />)

    const app = await screen.findByRole('switch', {
      name: 'Share anonymous usage data from this app'
    })

    expect(app).toHaveAttribute('aria-checked', 'false')
    await act(async () => fireEvent.click(app))
    expect(bridge.setUsageData).toHaveBeenCalledWith(true)
    await waitFor(() => expect(app).toHaveAttribute('aria-checked', 'true'))

    await act(async () => fireEvent.click(switchNamed('Send crash reports')))
    expect(bridge.setCrashReports).toHaveBeenCalledWith(true)
  })
})

describe('the setup step', () => {
  it('starts off and saves each flip to the app and its daemon', async () => {
    vi.mocked(settingsGet).mockResolvedValue(daemon(false))
    vi.mocked(settingsSet).mockResolvedValue(daemon(true))
    const bridge = appBridge()
    const onContinue = vi.fn()
    render(<UsageStep onContinue={onContinue} onError={vi.fn()} />)

    const toggle = switchNamed('Share anonymous usage data')
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    await waitFor(() => expect(toggle).toBeEnabled())
    expect(screen.getByText('From this app and its daemon.')).toBeInTheDocument()

    await act(async () => fireEvent.click(toggle))
    expect(settingsSet).toHaveBeenCalledWith({ usage_data: true })
    expect(bridge.setUsageData).toHaveBeenCalledWith(true)
    expect(toggle).toHaveAttribute('aria-checked', 'true')

    fireEvent.click(screen.getByTestId('onboarding-usage-continue'))
    expect(onContinue).toHaveBeenCalledTimes(1)
  })

  it('continuing without touching the switch sends nothing', async () => {
    vi.mocked(settingsGet).mockResolvedValue(daemon(false))
    const onContinue = vi.fn()
    render(<UsageStep onContinue={onContinue} onError={vi.fn()} />)
    await waitFor(() => expect(switchNamed('Share anonymous usage data')).toBeEnabled())
    fireEvent.click(screen.getByTestId('onboarding-usage-continue'))
    expect(settingsSet).not.toHaveBeenCalled()
    expect(onContinue).toHaveBeenCalledTimes(1)
  })

  it('skips itself in a browser on a daemon that predates usage data', async () => {
    vi.mocked(settingsGet).mockResolvedValue(daemon())
    const onContinue = vi.fn()
    render(<UsageStep onContinue={onContinue} onError={vi.fn()} />)
    await waitFor(() => expect(onContinue).toHaveBeenCalledTimes(1))
    expect(settingsSet).not.toHaveBeenCalled()
  })
})
