import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, vi } from 'vitest'

import {
  connectRegisterPoll,
  connectRegisterStart,
  connectStatus,
  daemonInfo,
  modelsList,
  pairingCode,
  updateRequest
} from '../../lib/api'
import type { UpdateState } from '../../lib/bridge'
import { pairWithDaemon } from '../../lib/connection'
import type { DaemonInfo } from '../../lib/types'
import { useConnection } from '../../stores/connection'
import { useSettings } from '../../stores/settings'
import { useUpdates } from '../../stores/updates'
import { useUsers } from '../../stores/users'

import {
  AboutSettings,
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
    // Saving marks the provider configured, as the daemon does; the row must
    // stay put (and open) instead of jumping to the Connected group.
    const setProviderKey = vi.fn(async () => {
      useSettings.setState(state => ({
        providers: state.providers.map(item => ({ ...item, configured: true }))
      }))
    })

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
    // The key field is behind the row's "Add key" so the list stays one line per provider.
    fireEvent.click(screen.getByRole('button', { name: 'Add key' }))
    fireEvent.change(screen.getByLabelText('OpenAI API key'), { target: { value: 'secret' } })
    fireEvent.click(screen.getByRole('button', { name: 'Test' }))
    await waitFor(() => expect(setProviderKey).toHaveBeenCalledWith('openai', 'secret'))
    expect(await screen.findByText('1 models available.')).toBeVisible()
  })

  it('shows LAN off and explains the reconnect when enabled', async () => {
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
      await screen.findByText(
        'Reconnecting to the daemon at its new address. Running bot turns continue.'
      )
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

  it('maps Auto approvals to smart and offers Bypass to the admin only', () => {
    const patch = vi.fn().mockResolvedValue(undefined)
    useSettings.setState({
      patch,
      refresh: vi.fn().mockResolvedValue(undefined),
      settings: {
        approval_mode: 'manual',
        billing_notice_ack: false,
        dream_enabled: true,
        dream_time: '03:00',
        lan_enabled: false,
        service_installed: false,
        workspace_dir: ''
      }
    })
    useUsers.setState({
      current: { display_name: 'Ana', id: 'ana', role: 'member' } as never,
      supported: true
    })
    const { unmount } = render(<ApprovalsSettings />)
    expect(screen.queryByRole('radio', { name: /^Bypass/ })).toBeNull()
    fireEvent.click(screen.getByRole('radio', { name: /^Auto/ }))
    expect(patch).toHaveBeenCalledWith({ approval_mode: 'smart' })
    unmount()
    useUsers.setState({ current: { display_name: 'Ana', id: 'ana', role: 'admin' } as never })
    render(<ApprovalsSettings />)
    fireEvent.click(screen.getByRole('radio', { name: /^Bypass/ }))
    expect(patch).toHaveBeenCalledWith({ approval_mode: 'off' })
    expect(screen.queryByText(/approver model/i)).toBeNull()
  })

  it('warns when the daemon has no OS sandbox, and only then', async () => {
    useSettings.setState({ refresh: vi.fn().mockResolvedValue(undefined) })
    vi.mocked(daemonInfo).mockResolvedValueOnce({
      approvals: 'sandbox',
      sandbox: null,
      version: '0.1.5'
    } as DaemonInfo)
    const { unmount } = render(<ApprovalsSettings />)
    expect(await screen.findByRole('status')).toHaveTextContent(
      'No OS sandbox is available, so Manual and Auto ask before every shell command and code run. Install bubblewrap on the computer running the daemon, then restart the daemon to restore isolation.'
    )
    unmount()
    vi.mocked(daemonInfo).mockResolvedValueOnce({
      approvals: 'sandbox',
      sandbox: 'bubblewrap',
      version: '0.1.5'
    } as DaemonInfo)
    const second = render(<ApprovalsSettings />)
    await act(async () => {
      await vi.mocked(daemonInfo).mock.results.at(-1)?.value
    })
    expect(screen.queryByRole('status')).toBeNull()
    second.unmount()
    // A daemon from before sandboxed approvals is told apart from one without a sandbox.
    vi.mocked(daemonInfo).mockResolvedValueOnce({
      sandbox: 'sandbox-exec',
      version: '0.1.4'
    } as DaemonInfo)
    render(<ApprovalsSettings />)
    expect(await screen.findByRole('status')).toHaveTextContent(/older than the app/)
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

  it('shows an identity conflict even while the registered tunnel is running', async () => {
    const conflict = 'Hex Connect has a different key for this daemon. Disconnect and connect again.'
    vi.mocked(connectStatus).mockResolvedValue({
      registered: true,
      daemon_id: 'd1',
      slug: 'home',
      tunnel_hostname: 'home.connect.hexbot.app',
      tunnel_running: true,
      last_heartbeat_at: 1,
      last_error: null,
      identity_error: conflict
    })
    render(<ConnectSettings />)
    expect(await screen.findByText(conflict)).toBeVisible()
    expect(screen.getByText('Running')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeVisible()
  })

  it('says why Connect is not connected after the daemon was revoked', async () => {
    vi.mocked(connectStatus).mockResolvedValue({
      registered: false,
      daemon_id: null,
      slug: null,
      tunnel_hostname: null,
      tunnel_running: false,
      last_heartbeat_at: null,
      last_error: 'Removed in Hex Connect'
    })
    render(<ConnectSettings />)
    expect(await screen.findByText('Removed in Hex Connect. Sign in to register it again.')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Sign in and register' })).toBeVisible()
  })

  it('does not explain other errors as a revocation', async () => {
    vi.mocked(connectStatus).mockResolvedValue({
      registered: false,
      daemon_id: null,
      slug: null,
      tunnel_hostname: null,
      tunnel_running: false,
      last_heartbeat_at: null,
      last_error: 'Hex Connect service unreachable'
    })
    render(<ConnectSettings />)
    expect(await screen.findByRole('button', { name: 'Sign in and register' })).toBeVisible()
    expect(screen.getByText('Sign in to get an address for this daemon.')).toBeVisible()
    expect(screen.queryByText(/Removed in Hex Connect/)).toBeNull()
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
          state: vi.fn(async () => useUpdates.getState().app!)
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
      fireEvent.click(screen.getByRole('button', { name: 'Update' }))
      const question = 'Are you sure you want to update to version 0.1.5-nightly.20260916.9?'
      expect(await screen.findByText(question)).toBeVisible()
      fireEvent.click(screen.getByRole('button', { name: 'No' }))
      await waitFor(() => expect(screen.queryByText(question)).toBeNull())
      expect(download).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole('button', { name: 'Update' }))
      fireEvent.click(await screen.findByRole('button', { name: 'Yes' }))
      await waitFor(() => expect(install).toHaveBeenCalledTimes(1))
      expect(download).toHaveBeenCalledTimes(1)
      expect(install.mock.invocationCallOrder[0]).toBeGreaterThan(
        download.mock.invocationCallOrder[0]!
      )
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

  it('lists open source licenses with GitHub links and returns to About', async () => {
    render(<AboutSettings />)
    await act(async () => {})
    fireEvent.click(screen.getByRole('button', { name: 'Licenses' }))
    expect(screen.getByRole('heading', { name: 'Licenses' })).toBeVisible()
    expect(screen.getByRole('link', { name: 'Pi, MIT' })).toHaveAttribute(
      'href',
      'https://github.com/earendil-works/pi'
    )
    fireEvent.click(screen.getByRole('button', { name: 'About' }))
    expect(screen.getByRole('heading', { name: 'About' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Website' })).toBeVisible()
  })
})

it('refreshes delayed identity and tunnel errors, clears recovery, and stops on unmount', async () => {
  vi.useFakeTimers()

  const healthy = {
    registered: true, daemon_id: 'd1', slug: 'home', tunnel_hostname: 'home.connect.hexbot.app',
    tunnel_running: true, last_heartbeat_at: 1, last_error: null, identity_error: null
  }

  const conflict = 'Hex Connect has a different key for this daemon. Disconnect and connect again.'
  vi.mocked(connectStatus).mockResolvedValue(healthy)
  const view = render(<ConnectSettings />)

  try {
    await act(async () => {})
    expect(screen.queryByText(conflict)).toBeNull()
    vi.mocked(connectStatus).mockResolvedValue({ ...healthy, last_error: 'cloudflared exited: exit status: 1', identity_error: conflict })
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(screen.getByText(conflict)).toBeVisible()
    expect(screen.getByText('The tunnel is not connected.')).toBeVisible()
    expect(screen.queryByText('cloudflared exited: exit status: 1')).toBeNull()
    vi.mocked(connectStatus).mockResolvedValue(healthy)
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(screen.queryByText(conflict)).toBeNull()
    expect(screen.queryByText('The tunnel is not connected.')).toBeNull()
    view.unmount()
    const calls = vi.mocked(connectStatus).mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(10000) })
    expect(connectStatus).toHaveBeenCalledTimes(calls)
  } finally {
    view.unmount()
    vi.useRealTimers()
  }
})
