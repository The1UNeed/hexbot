import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, vi } from 'vitest'

import { connectRegisterPoll, connectRegisterStart, connectStatus, modelsList } from '../../lib/api'
import { useSettings } from '../../stores/settings'
import { useUsers } from '../../stores/users'

import {
  AppearanceSettings,
  ApprovalsSettings,
  ConnectSettings,
  NetworkSettings,
  ProvidersSettings,
  UsersSettings
} from './index'

vi.mock('../../lib/api', async importOriginal => ({
  ...(await importOriginal()),
  modelsList: vi.fn(),
  connectStatus: vi.fn(),
  connectRegisterStart: vi.fn(),
  connectRegisterPoll: vi.fn(),
  pairingCode: vi
    .fn()
    .mockResolvedValue({ code: '123456', expires_at: Date.now() + 600_000, link: 'hexbot://pair' })
}))

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

  it('shows LAN off and reveals network details when enabled', () => {
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
    useSettings.setState({
      network: { addresses: ['192.168.1.2'], bind_host: '0.0.0.0', lan_enabled: true, port: 8000 }
    })
    rerender(<NetworkSettings />)
    expect(screen.getByText('Addresses')).toBeVisible()
    expect(screen.getByText('192.168.1.2:8000')).toBeVisible()
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
