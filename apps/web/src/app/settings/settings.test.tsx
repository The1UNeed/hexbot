import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, vi } from 'vitest'

import {
  connectRegisterPoll,
  connectRegisterStart,
  connectStatus,
  modelsList,
  pairingCode,
  updateRequest
} from '../../lib/api'
import type { UpdateState } from '../../lib/bridge'
import { pairWithDaemon } from '../../lib/connection'
import { useConnection } from '../../stores/connection'
import { useSettings } from '../../stores/settings'
import { useUpdates } from '../../stores/updates'
import { useUsers } from '../../stores/users'

import {
  AppearanceSettings,
  ApprovalsSettings,
  ConnectSettings,
  NetworkSettings,
  ProvidersSettings,
  UpdatesSettings,
  UsersSettings
} from './index'

vi.mock('../../lib/api', async importOriginal => ({
  ...(await importOriginal()),
  daemonInfo: vi.fn().mockResolvedValue({ version: '0.1.5-alpha.1' }),
  modelsList: vi.fn(),
  connectStatus: vi.fn(),
  connectRegisterStart: vi.fn(),
  connectRegisterPoll: vi.fn(),
  pairingCode: vi
    .fn()
    .mockResolvedValue({ code: '123456', expires_at: Date.now() + 600_000, link: 'hexbot://pair' }),
  updateRequest: vi.fn(),
  updateStatus: vi.fn().mockResolvedValue({ status: 'idle' })
}))

vi.mock('../../lib/connection', async importOriginal => ({
  ...(await importOriginal()),
  pairWithDaemon: vi.fn().mockResolvedValue({ deviceToken: '', deviceId: '', daemonName: 'local' })
}))

vi.mock('qrcode', () => ({ default: { toCanvas: vi.fn().mockResolvedValue(undefined) } }))

vi.mock('../../stores/ui', () => ({
  useUi: (selector: (state: object) => unknown) =>
    selector({
      setTheme: (theme: string) => {
        if (theme === 'system') {
          document.documentElement.removeAttribute('data-theme')
        } else {
          document.documentElement.setAttribute('data-theme', theme)
        }
      },
      theme: 'system'
    })
}))

describe('settings', () => {
  beforeEach(() => {
    const values = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      key: () => null,
      length: 0,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, value)
    })
    useSettings.setState({
      devices: [],
      models: { all: [], curated: [] },
      network: null,
      providers: [],
      settings: null
    })
    useConnection.setState({ status: 'connected', target: null })
    document.documentElement.removeAttribute('data-theme')
    vi.clearAllMocks()
  })

  it('adds and tests a provider key', async () => {
    const setProviderKey = vi.fn().mockResolvedValue(undefined)
    useSettings.setState({
      providers: [
        { auth_type: 'key', configured: false, id: 'openai', label: 'OpenAI', models_source: 'api' }
      ],
      refreshProviders: vi.fn().mockResolvedValue(undefined),
      setProviderKey
    })
    vi.mocked(modelsList).mockResolvedValue({
      all: [{ id: 'gpt', label: 'GPT', provider: 'openai' }],
      curated: []
    })
    render(<ProvidersSettings />)
    fireEvent.change(screen.getByLabelText('OpenAI API key'), { target: { value: 'secret' } })
    fireEvent.click(screen.getByRole('button', { name: 'Test' }))
    await waitFor(() => expect(setProviderKey).toHaveBeenCalledWith('openai', 'secret'))
    expect(await screen.findByText('1 models available.')).toBeVisible()
  })

  it('shows LAN off and explains the automatic restart when enabled', async () => {
    const setLanEnabled = vi.fn().mockResolvedValue(undefined)
    useSettings.setState({
      network: { addresses: [], bind_host: '127.0.0.1', lan_enabled: false, port: 8000 },
      refreshDevices: vi.fn().mockResolvedValue(undefined),
      refreshNetwork: vi.fn().mockResolvedValue(undefined),
      setLanEnabled
    })
    const { rerender } = render(<NetworkSettings />)
    expect(screen.queryByText('Addresses')).not.toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Allow other devices on this network'))
    expect(setLanEnabled).toHaveBeenCalledWith(true)
    expect(
      await screen.findByText('Hexbot is restarting and will reconnect automatically.')
    ).toBeVisible()
    useSettings.setState({
      network: { addresses: ['192.168.1.2'], bind_host: '0.0.0.0', lan_enabled: true, port: 8000 }
    })
    rerender(<NetworkSettings />)
    expect(screen.getByText('Addresses')).toBeVisible()
    expect(screen.getByText('192.168.1.2:8000')).toBeVisible()
  })

  it('pairs the local browser before enabling LAN and refreshes after reconnect', async () => {
    const setLanEnabled = vi.fn().mockResolvedValue(undefined)
    const refreshNetwork = vi.fn().mockResolvedValue(undefined)
    useConnection.setState({ status: 'connected', target: { kind: 'local' } })
    useSettings.setState({
      network: { addresses: [], bind_host: '127.0.0.1', lan_enabled: false, port: 9119 },
      refreshDevices: vi.fn().mockResolvedValue(undefined),
      refreshNetwork,
      setLanEnabled
    })
    render(<NetworkSettings />)
    fireEvent.click(screen.getByLabelText('Allow other devices on this network'))
    await waitFor(() => expect(setLanEnabled).toHaveBeenCalledWith(true))
    expect(pairWithDaemon).toHaveBeenCalled()
    expect(vi.mocked(pairWithDaemon).mock.invocationCallOrder[0]).toBeLessThan(
      setLanEnabled.mock.invocationCallOrder[0]!
    )
    vi.mocked(pairingCode).mockClear()
    act(() => {
      useConnection.setState({ status: 'reconnecting' })
      useSettings.setState({
        network: { addresses: [], bind_host: '0.0.0.0', lan_enabled: true, port: 9119 }
      })
    })
    expect(pairingCode).not.toHaveBeenCalled()
    act(() => {
      useConnection.setState({ status: 'connected' })
    })
    await waitFor(() =>
      expect(screen.getByLabelText('Allow other devices on this network')).toBeEnabled()
    )
    expect(pairingCode).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Create link' }))
    await waitFor(() => expect(pairingCode).toHaveBeenCalledTimes(1))
    expect(refreshNetwork).toHaveBeenCalledTimes(2)
  })

  it('creates a copyable link on demand and retries after a failure', async () => {
    useSettings.setState({
      network: { addresses: ['192.168.1.2'], bind_host: '0.0.0.0', lan_enabled: true, port: 9119 },
      refreshDevices: vi.fn().mockResolvedValue(undefined),
      refreshNetwork: vi.fn().mockResolvedValue(undefined)
    })
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    vi.mocked(pairingCode).mockRejectedValueOnce(new Error('Connection lost'))
    render(<NetworkSettings />)
    expect(pairingCode).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Create link' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Connection lost')
    fireEvent.click(screen.getByRole('button', { name: 'Create link' }))
    expect(await screen.findByLabelText('Pairing link')).toHaveValue('hexbot://pair')
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('hexbot://pair'))
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeVisible()
  })

  it('shows clients with LAN off and revokes only other devices', async () => {
    const revokeDevice = vi.fn().mockResolvedValue(undefined)
    useSettings.setState({
      network: { addresses: [], bind_host: '127.0.0.1', lan_enabled: false, port: 9119 },
      refreshDevices: vi.fn().mockResolvedValue(undefined),
      refreshNetwork: vi.fn().mockResolvedValue(undefined),
      revokeDevice,
      devices: [
        {
          id: 'self',
          name: 'Hexbot Desktop',
          platform: 'Desktop',
          current: true,
          created_at: 1,
          last_seen_at: 1
        },
        {
          id: 'other',
          name: 'Laptop',
          platform: 'Browser',
          current: false,
          created_at: 1,
          last_seen_at: 1
        }
      ]
    })
    render(<NetworkSettings />)
    expect(screen.getByText('This device')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Create link' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Revoke others' }))
    await waitFor(() => expect(revokeDevice).toHaveBeenCalledExactlyOnceWith('other'))
  })

  it('maps Auto approvals to smart', () => {
    const patch = vi.fn().mockResolvedValue(undefined)
    useSettings.setState({
      patch,
      refresh: vi.fn().mockResolvedValue(undefined),
      refreshModels: vi.fn().mockResolvedValue(undefined),
      settings: {
        approval_mode: 'manual',
        auto_approver_model: null,
        billing_notice_ack: false,
        dream_enabled: true,
        dream_time: '03:00',
        lan_enabled: false,
        service_installed: false,
        workspace_dir: ''
      }
    })
    render(<ApprovalsSettings />)
    fireEvent.click(screen.getByRole('radio', { name: /^Auto/ }))
    expect(patch).toHaveBeenCalledWith({ approval_mode: 'smart' })
  })

  it('applies a selected theme to the document', () => {
    render(<AppearanceSettings />)
    fireEvent.click(screen.getByRole('radio', { name: 'dark' }))
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
  })

  it('registers Connect and polls until approval', async () => {
    vi.mocked(connectStatus)
      .mockResolvedValueOnce({
        registered: false,
        daemon_id: null,
        slug: null,
        tunnel_hostname: null,
        tunnel_running: false,
        last_heartbeat_at: null,
        last_error: null
      })
      .mockResolvedValueOnce({
        registered: true,
        daemon_id: 'd1',
        slug: 'home',
        tunnel_hostname: 'home.connect.hexbot.app',
        tunnel_running: true,
        last_heartbeat_at: 1,
        last_error: null
      })
    vi.mocked(connectRegisterStart).mockResolvedValue({
      device_code: 'device',
      user_code: 'ABCD',
      verify_url: 'https://hexbot.app/verify',
      interval: 0
    })
    vi.mocked(connectRegisterPoll).mockResolvedValue({ status: 'approved' })
    render(<ConnectSettings />)
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in and register' }))
    expect(await screen.findByText('ABCD')).toBeVisible()
    await waitFor(() => expect(connectRegisterPoll).toHaveBeenCalledWith('device'), {
      timeout: 2500
    })
    expect(await screen.findByText('home.connect.hexbot.app')).toBeVisible()
  })

  it('walks an app update from check to restart', async () => {
    const idle: UpdateState = {
      availableVersion: null,
      channel: 'nightly',
      checkedAt: null,
      currentVersion: '0.1.5-nightly.20260914.6',
      downloadedVersion: null,
      errorContext: null,
      message: null,
      percent: null,
      status: 'idle'
    }

    const available: UpdateState = {
      ...idle,
      availableVersion: '0.1.5-nightly.20260916.9',
      checkedAt: '2026-09-17T09:00:00.000Z',
      status: 'available'
    }

    const downloaded: UpdateState = {
      ...available,
      downloadedVersion: '0.1.5-nightly.20260916.9',
      percent: 100,
      status: 'downloaded'
    }

    const check = vi.fn(async () => {
      useUpdates.getState().setApp(available)

      return available
    })

    const download = vi.fn(async () => {
      useUpdates.getState().setApp(downloaded)

      return downloaded
    })

    const install = vi.fn().mockResolvedValue(downloaded)
    Object.defineProperty(window, 'hexbot', {
      configurable: true,
      value: {
        updater: {
          channel: vi.fn().mockResolvedValue('nightly'),
          check,
          download,
          install,
          onStatus: () => () => undefined,
          setChannel: vi.fn().mockResolvedValue(idle),
          state: vi.fn().mockResolvedValue(idle)
        },
        version: '0.1.5-nightly.20260914.6'
      }
    })
    useUpdates.setState({ app: idle, daemon: null })
    useConnection.setState({
      daemon: {
        addresses: [],
        auth_required: false,
        daemon_name: 'studio',
        hermes_version: null,
        home: '/home/me/.hexbot',
        install_id: 'i1',
        lan_enabled: false,
        platform: 'darwin',
        update_capability: 'desktop',
        version: '0.1.5-nightly.20260914.6'
      }
    })

    try {
      render(<UpdatesSettings />)
      expect(screen.getByText('Not checked yet.')).toBeVisible()
      expect(screen.getByText('The daemon is up to date with this app.')).toBeVisible()
      fireEvent.click(screen.getByRole('button', { name: 'Check now' }))
      expect(
        await screen.findByText('Version 0.1.5-nightly.20260916.9 is available.')
      ).toBeVisible()
      fireEvent.click(screen.getByRole('button', { name: 'Download update' }))
      expect(download).toHaveBeenCalledTimes(1)
      expect(
        await screen.findByText(
          'Version 0.1.5-nightly.20260916.9 is downloaded. Restart to install it.'
        )
      ).toBeVisible()
      fireEvent.click(screen.getByRole('button', { name: 'Restart and install' }))
      expect(install).toHaveBeenCalledTimes(1)
    } finally {
      delete (window as { hexbot?: unknown }).hexbot
      useUpdates.setState({ app: null, daemon: null })
      useConnection.setState({ daemon: null })
    }
  })

  it('offers to update a daemon that is behind the app', async () => {
    Object.defineProperty(window, 'hexbot', {
      configurable: true,
      value: {
        updater: {
          channel: vi.fn(),
          check: vi.fn(),
          download: vi.fn(),
          install: vi.fn(),
          onStatus: () => () => undefined,
          setChannel: vi.fn(),
          state: vi.fn()
        },
        version: '0.1.5-nightly.20260916.9'
      }
    })
    useUpdates.setState({ app: null, daemon: null })
    useConnection.setState({
      daemon: {
        addresses: [],
        auth_required: false,
        daemon_name: 'studio',
        hermes_version: null,
        home: '/home/me/.hexbot',
        install_id: 'i1',
        lan_enabled: false,
        platform: 'darwin',
        update_capability: 'service',
        version: '0.1.5-nightly.20260914.6'
      }
    })
    vi.mocked(updateRequest).mockResolvedValue({
      accepted: true,
      method: 'service',
      version: '0.1.5-nightly.20260916.9'
    })

    try {
      render(<UpdatesSettings />)
      fireEvent.click(screen.getByRole('button', { name: 'Update daemon' }))
      await waitFor(() => expect(updateRequest).toHaveBeenCalledWith('0.1.5-nightly.20260916.9'))
      expect(await screen.findByText('Asking the daemon…')).toBeVisible()
      useConnection.setState({
        daemon: { ...useConnection.getState().daemon!, update_capability: null }
      })
      act(() => useUpdates.getState().setDaemon(null))
      expect(
        await screen.findByText(
          /This daemon cannot update itself; update Hexbot on studio by hand./
        )
      ).toBeVisible()
    } finally {
      delete (window as { hexbot?: unknown }).hexbot
      useUpdates.setState({ app: null, daemon: null })
      useConnection.setState({ daemon: null })
    }
  })

  it('gates user management to administrators', () => {
    useUsers.setState({
      current: { display_name: 'Member', id: 'u1', role: 'member' },
      refresh: vi.fn().mockResolvedValue(undefined),
      supported: true,
      users: []
    })
    render(<UsersSettings />)
    expect(screen.getByText('Only administrators can manage users.')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Invite' })).not.toBeInTheDocument()
  })
})
