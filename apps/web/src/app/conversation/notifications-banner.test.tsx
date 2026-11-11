import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { HexbotBridge } from '../../lib/bridge'

import { NotificationsBanner } from './notifications-banner'

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))

afterEach(() => {
  delete window.hexbot
  localStorage.clear()
  sessionStorage.clear()
})

function app(platform = 'darwin') {
  const bridge = { notify: vi.fn(), openNotificationSettings: vi.fn(async () => undefined), platform }
  window.hexbot = bridge as unknown as HexbotBridge

  return bridge
}

describe('the app’s notifications banner', () => {
  it('sends a test and goes once you saw it', () => {
    const bridge = app()
    render(<NotificationsBanner />)

    fireEvent.click(screen.getByRole('button', { name: 'Enable' }))
    expect(bridge.notify).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Notifications are on' })
    )
    expect(screen.getByText('Did a test notification appear?')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Yes' }))
    expect(screen.queryByTestId('notifications-banner')).toBeNull()
  })

  it('leads a test macOS hid to System Settings, and to another test', () => {
    const bridge = app()
    render(<NotificationsBanner />)

    fireEvent.click(screen.getByRole('button', { name: 'Enable' }))
    fireEvent.click(screen.getByRole('button', { name: 'No' }))
    expect(screen.getByText('macOS is not showing them')).toBeVisible()
    expect(screen.getByText('Allow Hexbot in System Settings, then try again.')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Open System Settings' }))
    expect(bridge.openNotificationSettings).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(bridge.notify).toHaveBeenCalledTimes(2)
    expect(screen.getByText('Did a test notification appear?')).toBeVisible()
  })

  it('only says where to allow Hexbot on a system whose settings it cannot open', () => {
    app('linux')
    render(<NotificationsBanner />)

    fireEvent.click(screen.getByRole('button', { name: 'Enable' }))
    fireEvent.click(screen.getByRole('button', { name: 'No' }))
    expect(screen.getByText('Your system is not showing them')).toBeVisible()
    expect(screen.queryByRole('button', { name: /^Open / })).toBeNull()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible()
  })
})
