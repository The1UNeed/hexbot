import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { HexbotBridge } from '../../../lib/bridge'

import { useNotificationsNotice, waitingNotice } from './chat-notices'
import type { Notice } from './notice'
import { NoticeDock } from './notice-dock'

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))

afterEach(() => {
  delete window.hexbot
  localStorage.clear()
  sessionStorage.clear()
})

const stopped = (onRetry = vi.fn(), onDismiss = vi.fn()): Notice => ({
  actions: [{ label: 'Retry', onSelect: onRetry, primary: true }],
  detail: 'Codex error: The usage limit has been reached',
  id: 'stopped',
  onDismiss,
  time: Date.UTC(2026, 10, 27, 3),
  title: 'English stopped',
  tone: 'danger'
})

const tools: Notice = {
  detail: 'The server did not answer.',
  id: 'tools',
  title: 'Notion tools didn’t connect',
  tone: 'warning'
}

describe('NoticeDock', () => {
  it('draws nothing without notices', () => {
    render(<NoticeDock notices={[]} />)
    expect(screen.queryByTestId('notice-dock')).toBeNull()
  })

  it('shows a failure with its reason, Retry and close', () => {
    const onRetry = vi.fn()
    const onDismiss = vi.fn()
    render(<NoticeDock notices={[stopped(onRetry, onDismiss)]} />)

    const card = screen.getByRole('alert')
    expect(card).toHaveTextContent('English stopped')
    expect(card).toHaveTextContent('Codex error: The usage limit has been reached')

    fireEvent.click(within(card).getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalledOnce()
    fireEvent.click(within(card).getByRole('button', { name: 'Dismiss' }))
    expect(onDismiss).toHaveBeenCalledOnce()
  })

  it('puts a failure in front of quieter notices, and lists them all on request', () => {
    render(<NoticeDock notices={[tools, waitingNotice('Scout'), stopped()]} />)

    // One card in front; the others wait behind it.
    expect(screen.getAllByTestId('notice')).toHaveLength(1)
    expect(screen.getByTestId('notice')).toHaveTextContent('English stopped')

    fireEvent.click(screen.getByRole('button', { name: '2 more' }))
    expect(screen.getAllByTestId('notice').map(card => card.textContent)).toEqual([
      expect.stringContaining('English stopped'),
      expect.stringContaining('Scout is waiting on you'),
      expect.stringContaining('Notion tools didn’t connect')
    ])

    fireEvent.click(screen.getByRole('button', { name: 'Show less' }))
    expect(screen.getAllByTestId('notice')).toHaveLength(1)
  })
})

function app(platform = 'darwin') {
  const bridge = { notify: vi.fn(), openNotificationSettings: vi.fn(async () => undefined), platform }
  window.hexbot = bridge as unknown as HexbotBridge

  return bridge
}

function NotificationsDock() {
  const notice = useNotificationsNotice()

  return <NoticeDock notices={notice ? [notice] : []} />
}

describe('the app’s notifications notice', () => {
  it('sends a test and goes once you saw it', () => {
    const bridge = app()
    render(<NotificationsDock />)

    fireEvent.click(screen.getByRole('button', { name: 'Enable' }))
    expect(bridge.notify).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Notifications are on' })
    )
    expect(screen.getByText('Did a test notification appear?')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Yes' }))
    expect(screen.queryByTestId('notice-dock')).toBeNull()
  })

  it('leads a test macOS hid to System Settings, and to another test', () => {
    const bridge = app()
    render(<NotificationsDock />)

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
    render(<NotificationsDock />)

    fireEvent.click(screen.getByRole('button', { name: 'Enable' }))
    fireEvent.click(screen.getByRole('button', { name: 'No' }))
    expect(screen.getByText('Your system is not showing them')).toBeVisible()
    expect(screen.queryByRole('button', { name: /^Open / })).toBeNull()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible()
  })

  it('hides until Hexbot opens again when closed', () => {
    app()
    const { unmount } = render(<NotificationsDock />)

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByTestId('notice-dock')).toBeNull()
    unmount()

    render(<NotificationsDock />)
    expect(screen.queryByTestId('notice-dock')).toBeNull()
  })
})
