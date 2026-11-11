import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { connectStatus } from '../../lib/api'
import type { HexbotBridge } from '../../lib/bridge'
import type { Bot, Device } from '../../lib/types'
import { useBots } from '../../stores/bots'
import { useSettings } from '../../stores/settings'

import { NotificationsSettings } from './notifications'

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))
vi.mock('../../lib/api', async importOriginal => ({
  ...(await importOriginal()),
  connectStatus: vi.fn()
}))

const bot = (name: string, notify?: boolean) =>
  ({ display_name: name[0]!.toUpperCase() + name.slice(1), face: null, name, notify }) as Bot

beforeEach(() => {
  vi.mocked(connectStatus).mockResolvedValue({ registered: true } as never)
  useSettings.setState({
    devices: [
      { id: 'p1', name: 'Alex’s iPhone', platform: 'ios', push: true } as Device,
      { id: 'b1', name: 'Browser', platform: 'browser', push: false } as Device
    ],
    refreshDevices: vi.fn(async () => undefined)
  })
})
afterEach(() => {
  delete window.hexbot
})

describe('Settings, Notifications', () => {
  it('lists every bot’s Notify me and saves a change', async () => {
    const update = vi.fn(async () => bot('fox', false))
    useBots.setState({
      byName: { fox: bot('fox'), owl: bot('owl', false) },
      order: ['owl', 'fox'],
      update
    })
    render(<NotificationsSettings />)

    expect(screen.getByRole('switch', { name: 'Notify me about Owl' })).toHaveAttribute(
      'aria-checked',
      'false'
    )
    fireEvent.click(screen.getByRole('switch', { name: 'Notify me about Fox' }))
    expect(update).toHaveBeenCalledWith('fox', { notify: false })
    // Only phones that take pushes.
    expect(await screen.findByText('Alex’s iPhone')).toBeVisible()
    expect(screen.queryByText('Browser')).toBeNull()
  })

  it('sends a test from the app', () => {
    const notify = vi.fn()
    window.hexbot = { notify, platform: 'darwin' } as unknown as HexbotBridge
    useBots.setState({ byName: {}, order: [] })
    render(<NotificationsSettings />)

    expect(screen.getByText(/allow Hexbot in System Settings, Notifications/)).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Send a test' }))
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: 'Notifications are on' }))
    // An app from before it could open the system's settings only says where they are.
    expect(screen.queryByRole('button', { name: /^Open / })).toBeNull()
  })

  it('opens the system’s notification settings, where a hidden test is allowed', () => {
    const openNotificationSettings = vi.fn(async () => undefined)
    window.hexbot = {
      notify: vi.fn(),
      openNotificationSettings,
      platform: 'darwin'
    } as unknown as HexbotBridge
    useBots.setState({ byName: {}, order: [] })
    render(<NotificationsSettings />)

    fireEvent.click(screen.getByRole('button', { name: 'Open System Settings' }))
    expect(openNotificationSettings).toHaveBeenCalledOnce()
  })
})
