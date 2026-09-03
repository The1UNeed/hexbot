import { ExternalLink, RefreshCw, Trash2 } from 'lucide-react'
import QRCode from 'qrcode'
import { useEffect, useRef, useState } from 'react'

import { Button } from '../../components/ui/button'
import { Chip } from '../../components/ui/chip'
import { Input } from '../../components/ui/input'
import { Select } from '../../components/ui/select'
import {
  connectDisconnect,
  connectRegisterPoll,
  connectRegisterStart,
  connectStatus,
  daemonInfo,
  modelsList,
  pairingCode,
  usageSummary,
  usersInvite,
  usersUpdate
} from '../../lib/api'
import { getBridge } from '../../lib/bridge'
import type { ApprovalMode, ModelOption, PairingCode, Provider } from '../../lib/types'
import { useSettings } from '../../stores/settings'
import { type ThemePreference, useUi } from '../../stores/ui'
import { useUsers } from '../../stores/users'

export const SETTINGS_TABS = [
  'providers',
  'network',
  'connect',
  'memory',
  'users',
  'usage',
  'approvals',
  'appearance',
  'updates',
  'about'
] as const
export type SettingsTab = (typeof SETTINGS_TABS)[number]
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Complete settings body; the file route owns the surrounding dialog and navigation. */
export function SettingsPanel({ tab }: { tab: string }): React.JSX.Element {
  return (
    <section aria-label={`${tab} settings`} className="min-w-0 p-6">
      {tab === 'providers' && <ProvidersSettings />}
      {tab === 'network' && <NetworkSettings />}
      {tab === 'connect' && <ConnectSettings />}
      {tab === 'memory' && <MemorySettings />}
      {tab === 'users' && <UsersSettings />}
      {tab === 'usage' && <UsageSettings />}
      {tab === 'approvals' && <ApprovalsSettings />}
      {tab === 'appearance' && <AppearanceSettings />}
      {tab === 'updates' && <UpdatesSettings />}
      {tab === 'about' && <AboutSettings />}
    </section>
  )
}

export function MemorySettings() {
  const settings = useSettings(state => state.settings)
  const refresh = useSettings(state => state.refresh)
  const patch = useSettings(state => state.patch)
  useEffect(() => {
    void refresh()
  }, [refresh])

  return (
    <>
      <Heading description="Set when bots review the day's conversations and write to their memory.">
        Memory
      </Heading>
      <label className="flex items-center justify-between border-b border-border py-3">
        <span>
          <strong className="block">Dreaming</strong>
          <span className="text-muted">Run scheduled memory reviews for enabled bots.</span>
        </span>
        <input
          aria-label="Enable dreaming globally"
          checked={settings?.dream_enabled ?? false}
          onChange={event => void patch({ dream_enabled: event.target.checked })}
          type="checkbox"
        />
      </label>
      <label className="mt-4 block">
        <span className="mb-2 block font-medium">Daily dream time</span>
        <Input
          aria-label="Daily dream time"
          defaultValue={settings?.dream_time ?? '03:00'}
          onBlur={event => void patch({ dream_time: event.target.value })}
          type="time"
        />
      </label>
    </>
  )
}

export function ConnectSettings() {
  const [status, setStatus] = useState<Awaited<ReturnType<typeof connectStatus>> | null>(null)

  const [registration, setRegistration] = useState<Awaited<
    ReturnType<typeof connectRegisterStart>
  > | null>(null)

  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    void connectStatus()
      .then(setStatus)
      .catch(cause => setError(errorText(cause)))
  }, [])
  useEffect(() => {
    if (!registration) {
      return
    }

    let stopped = false

    const poll = async () => {
      try {
        const result = await connectRegisterPoll(registration.device_code)

        if (stopped) {
          return
        }

        if (result.status === 'approved') {
          setRegistration(null)
          setStatus(await connectStatus())
          setBusy(false)

          return
        }

        window.setTimeout(() => void poll(), Math.max(1, registration.interval) * 1000)
      } catch (cause) {
        if (!stopped) {
          setError(errorText(cause))
          setBusy(false)
        }
      }
    }

    const timer = window.setTimeout(() => void poll(), Math.max(1, registration.interval) * 1000)

    return () => {
      stopped = true
      window.clearTimeout(timer)
    }
  }, [registration])
  const open = (url: string) => (getBridge() ? getBridge()?.openExternal(url) : undefined)

  return (
    <>
      <Heading description="Reach this daemon securely when you are away from your local network.">
        Hexbot Connect
      </Heading>
      {status?.registered ? (
        <div>
          <dl className="grid grid-cols-[auto_1fr] gap-2">
            <dt className="text-muted">Tunnel</dt>
            <dd>{status.tunnel_hostname}</dd>
            <dt className="text-muted">Status</dt>
            <dd>{status.tunnel_running ? 'Running' : 'Stopped'}</dd>
          </dl>
          <Button
            className="mt-5"
            onClick={() =>
              void connectDisconnect().then(() => setStatus({ ...status, registered: false }))
            }
            variant="danger"
          >
            Disconnect
          </Button>
        </div>
      ) : registration ? (
        <div>
          <p>Open this page and enter the code:</p>
          {getBridge() ? (
            <Button className="mt-3" onClick={() => void open(registration.verify_url)}>
              Open verification page
            </Button>
          ) : (
            <a className="mt-3 block text-accent underline" href={registration.verify_url}>
              {registration.verify_url}
            </a>
          )}
          <p className="mt-4 font-mono text-2xl tracking-[0.2em]">{registration.user_code}</p>
          <p className="mt-2 text-muted">Waiting for approval…</p>
        </div>
      ) : (
        <Button
          busy={busy}
          onClick={() => {
            setBusy(true)
            void connectRegisterStart()
              .then(setRegistration)
              .catch(cause => {
                setError(errorText(cause))
                setBusy(false)
              })
          }}
          variant="primary"
        >
          Sign in and register
        </Button>
      )}
      {error ? (
        <p className="mt-3 text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </>
  )
}

export function UsersSettings() {
  const current = useUsers(state => state.current)
  const users = useUsers(state => state.users)
  const refresh = useUsers(state => state.refresh)
  const network = useSettings(state => state.network)
  const refreshNetwork = useSettings(state => state.refreshNetwork)
  const [name, setName] = useState('')
  const [invite, setInvite] = useState<{ code: string; expires_at: number } | null>(null)
  useEffect(() => {
    void Promise.all([refresh(), refreshNetwork()])
  }, [refresh, refreshNetwork])

  if (current?.role !== 'admin') {
    return <p className="text-muted">Only administrators can manage users.</p>
  }

  return (
    <>
      <Heading description="Invite household members and set their daily token budgets.">
        Users
      </Heading>
      <form
        className="flex gap-2"
        onSubmit={event => {
          event.preventDefault()
          void usersInvite(name).then(result => {
            setInvite(result)
            setName('')
            void refresh()
          })
        }}
      >
        <Input
          aria-label="New user name"
          onChange={event => setName(event.target.value)}
          placeholder="Display name"
          value={name}
        />
        <Button disabled={!name.trim()} type="submit">
          Invite
        </Button>
      </form>
      {invite ? (
        <div className="mt-3 bg-surface-2 p-3">
          <p>Pairing code</p>
          <p className="font-mono text-xl">{invite.code}</p>
          <p className="text-muted">Use this code on the new user's device.</p>
          {network?.addresses[0] ? (
            <a
              className="mt-2 block break-all text-accent underline"
              href={`hexbot://pair?host=${encodeURIComponent(network.addresses[0])}&port=${network.port}#code=${encodeURIComponent(invite.code)}`}
            >
              Open pairing link
            </a>
          ) : null}
        </div>
      ) : null}
      <ul className="mt-5 divide-y divide-border">
        {users.map(user => (
          <li className="grid grid-cols-[1fr_120px_auto] items-center gap-2 py-3" key={user.id}>
            <Input
              aria-label={`Name for ${user.display_name}`}
              defaultValue={user.display_name}
              onBlur={event =>
                event.target.value !== user.display_name &&
                void usersUpdate(user.id, { display_name: event.target.value }).then(() =>
                  refresh()
                )
              }
            />
            <Input
              aria-label={`Daily token budget for ${user.display_name}`}
              defaultValue={user.limits?.daily_tokens ?? ''}
              min="0"
              onBlur={event =>
                void usersUpdate(user.id, {
                  limits: { daily_tokens: event.target.value ? Number(event.target.value) : null }
                }).then(() => refresh())
              }
              placeholder="No limit"
              type="number"
            />
            <Button
              onClick={() =>
                void usersUpdate(user.id, {
                  disabled: !(user.disabled_at ?? user.disabled)
                }).then(() => refresh())
              }
              size="sm"
              variant="ghost"
            >
              {user.disabled_at || user.disabled ? 'Enable' : 'Disable'}
            </Button>
          </li>
        ))}
      </ul>
    </>
  )
}

export function UsageSettings() {
  const [summary, setSummary] = useState<Awaited<ReturnType<typeof usageSummary>> | null>(null)
  useEffect(() => {
    void usageSummary().then(setSummary)
  }, [])

  const rows = summary
    ? Array.isArray(summary.by_bot)
      ? summary.by_bot
      : Object.entries(summary.by_bot).map(([bot, value]) => ({ bot, ...value }))
    : []

  return (
    <>
      <Heading description="Token use reported by this daemon.">Usage</Heading>
      {summary ? (
        <>
          <p>
            {summary.input_tokens.toLocaleString()} input · {summary.output_tokens.toLocaleString()}{' '}
            output · ${summary.estimated_cost_usd.toFixed(2)}
          </p>
          <table className="mt-5 w-full text-left">
            <thead>
              <tr className="border-b border-border">
                <th className="py-2">Bot</th>
                <th>Input</th>
                <th>Output</th>
                <th>Cost</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr className="border-b border-border" key={row.bot}>
                  <td className="py-2">{row.bot}</td>
                  <td>{row.input_tokens.toLocaleString()}</td>
                  <td>{row.output_tokens.toLocaleString()}</td>
                  <td>${(row.estimated_cost_usd ?? 0).toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : (
        <p className="text-muted">Loading usage…</p>
      )}
    </>
  )
}

function Heading({ children, description }: { children: React.ReactNode; description: string }) {
  return (
    <header className="mb-6">
      <h2 className="text-[length:var(--text-title)] font-semibold">{children}</h2>
      <p className="mt-1 text-muted">{description}</p>
    </header>
  )
}

export function ProvidersSettings(): React.JSX.Element {
  const providers = useSettings(state => state.providers)
  const refresh = useSettings(state => state.refreshProviders)
  const setKey = useSettings(state => state.setProviderKey)
  const clearKey = useSettings(state => state.clearProviderKey)
  useEffect(() => {
    void refresh()
  }, [refresh])

  return (
    <>
      <Heading description="Connect the model providers your bots can use.">Providers</Heading>
      <div className="divide-y divide-border">
        {providers.map(provider => (
          <ProviderRow clearKey={clearKey} key={provider.id} provider={provider} setKey={setKey} />
        ))}
      </div>
      <p className="mt-6 text-[length:var(--text-secondary)] text-muted">
        Hexbot does not include any model credits. Usage is billed by your providers.
      </p>
    </>
  )
}

function ProviderRow({
  clearKey,
  provider,
  setKey
}: {
  clearKey: (provider: string) => Promise<void>
  provider: Provider
  setKey: (provider: string, key: string) => Promise<void>
}) {
  const [key, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  const save = async () => {
    setBusy(true)
    setResult(null)

    try {
      await setKey(provider.id, key)
      setDraft('')
      setResult('Key saved.')
    } catch (error) {
      setResult(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  const test = async () => {
    setBusy(true)
    setResult(null)

    try {
      if (key) {
        await setKey(provider.id, key)
      }

      const models = await modelsList(provider.id)
      setResult(`${models.all.length} models available.`)
      setDraft('')
    } catch (error) {
      setResult(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="py-4">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="font-medium">{provider.label}</h3>
          <Chip className="mt-1" tone={provider.configured ? 'success' : 'neutral'}>
            {provider.configured ? 'Configured' : 'Not configured'}
          </Chip>
        </div>
        {provider.configured && (
          <Button
            aria-label={`Remove ${provider.label} key`}
            icon={<Trash2 size={14} />}
            onClick={() => void clearKey(provider.id)}
            size="sm"
            variant="ghost"
          >
            Remove
          </Button>
        )}
      </div>
      <div className="mt-3 flex gap-2">
        <Input
          aria-label={`${provider.label} API key`}
          onChange={event => setDraft(event.target.value)}
          placeholder="API key"
          type="password"
          value={key}
        />
        <Button busy={busy} disabled={!key} onClick={() => void save()}>
          Save
        </Button>
        <Button busy={busy} onClick={() => void test()}>
          Test
        </Button>
      </div>
      {result && (
        <p className="mt-2 text-[length:var(--text-secondary)] text-muted" role="status">
          {result}
        </p>
      )}
    </div>
  )
}

export function NetworkSettings(): React.JSX.Element {
  const network = useSettings(state => state.network)
  const devices = useSettings(state => state.devices)
  const refreshNetwork = useSettings(state => state.refreshNetwork)
  const refreshDevices = useSettings(state => state.refreshDevices)
  const setLan = useSettings(state => state.setLanEnabled)
  const revoke = useSettings(state => state.revokeDevice)
  const [code, setCode] = useState<PairingCode | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [restartRequired, setRestartRequired] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    void Promise.all([refreshNetwork(), refreshDevices()])
  }, [refreshDevices, refreshNetwork])
  useEffect(() => {
    if (network?.lan_enabled) {
      void pairingCode()
        .then(setCode)
        .catch(cause => setError(errorText(cause)))
    }
  }, [network?.lan_enabled])
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)

    return () => window.clearInterval(timer)
  }, [])

  const seconds = code
    ? Math.max(
        0,
        Math.ceil((code.expires_at * (code.expires_at < 10_000_000_000 ? 1000 : 1) - now) / 1000)
      )
    : 0

  const toggle = async (enabled: boolean) => {
    try {
      await setLan(enabled)
      setRestartRequired(true)
    } catch (cause) {
      setError(errorText(cause))
    }
  }

  return (
    <>
      <Heading description="Pair devices directly with this daemon on your local network.">
        Network
      </Heading>
      <label className="flex items-center justify-between gap-4 border-b border-border pb-4">
        <span>
          <strong className="block">Allow other devices on this network</strong>
          <span className="text-[length:var(--text-secondary)] text-muted">
            Makes this daemon reachable from your LAN.
          </span>
        </span>
        <input
          aria-label="Allow other devices on this network"
          checked={network?.lan_enabled ?? false}
          className="size-5 accent-accent"
          onChange={event => void toggle(event.target.checked)}
          type="checkbox"
        />
      </label>
      {restartRequired && (
        <p className="mt-4 rounded-control bg-warning/12 p-3 text-warning" role="status">
          Restart the daemon for this network change to take effect.
        </p>
      )}
      {error && (
        <p className="mt-4 text-danger" role="alert">
          {error}
        </p>
      )}
      {network?.lan_enabled && (
        <div className="mt-5 space-y-6">
          <div>
            <h3 className="font-medium">Addresses</h3>
            <ul className="mt-2 font-mono text-[length:var(--text-secondary)]">
              {network.addresses.map(address => (
                <li key={address}>
                  {address}:{network.port}
                </li>
              ))}
            </ul>
          </div>
          {code && (
            <div className="grid grid-cols-[1fr_auto] items-center gap-5">
              <div>
                <h3 className="font-medium">Pairing code</h3>
                <p className="mt-1 font-mono text-2xl tracking-[0.2em]">{code.code}</p>
                <p className="mt-1 text-muted">
                  Expires in {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
                </p>
                <Button
                  className="mt-3"
                  icon={<RefreshCw size={14} />}
                  onClick={() => void pairingCode().then(setCode)}
                  size="sm"
                >
                  Regenerate
                </Button>
              </div>
              <PairingQr link={code.link} />
            </div>
          )}
          <div>
            <h3 className="font-medium">Paired devices</h3>
            <ul className="mt-2 divide-y divide-border">
              {devices.map(device => (
                <li className="flex items-center gap-3 py-3" key={device.id}>
                  <div className="flex-1">
                    <span>{device.name}</span>
                    {device.current && <Chip className="ml-2">This device</Chip>}
                    <p className="text-[length:var(--text-meta)] text-muted">
                      Last seen {formatDate(device.last_seen_at)}
                    </p>
                  </div>
                  {!device.current && (
                    <Button onClick={() => void revoke(device.id)} size="sm" variant="ghost">
                      Revoke
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </>
  )
}

function PairingQr({ link }: { link: string }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    if (canvas.current) {
      void QRCode.toCanvas(canvas.current, link, { margin: 1, width: 132 })
    }
  }, [link])

  return <canvas aria-label="Pairing QR code" ref={canvas} />
}

function formatDate(value: null | number): string {
  return value ? new Date(value * (value < 10_000_000_000 ? 1000 : 1)).toLocaleString() : 'never'
}

const MODES: { description: string; label: string; value: ApprovalMode }[] = [
  {
    description: 'Ask before every tool action that needs permission.',
    label: 'Manual',
    value: 'manual'
  },
  {
    description: 'Let a small model approve low-risk actions and ask you about the rest.',
    label: 'Auto',
    value: 'smart'
  },
  { description: 'Run actions without approval prompts.', label: 'Off', value: 'off' }
]

export function ApprovalsSettings(): React.JSX.Element {
  const settings = useSettings(state => state.settings)
  const models = useSettings(state => state.models)
  const refresh = useSettings(state => state.refresh)
  const refreshModels = useSettings(state => state.refreshModels)
  const patch = useSettings(state => state.patch)
  useEffect(() => {
    void Promise.all([refresh(), refreshModels()])
  }, [refresh, refreshModels])
  const curated = models.curated.length ? models.curated : models.all

  return (
    <>
      <Heading description="Choose when Hexbot asks before a bot uses a protected tool.">
        Approvals
      </Heading>
      <fieldset className="space-y-1">
        <legend className="sr-only">Approval mode</legend>
        {MODES.map(mode => (
          <label className="flex cursor-pointer gap-3 border-b border-border py-3" key={mode.value}>
            <input
              checked={settings?.approval_mode === mode.value}
              name="approval-mode"
              onChange={() => void patch({ approval_mode: mode.value })}
              type="radio"
              value={mode.value}
            />
            <span>
              <strong className="block">{mode.label}</strong>
              <span className="text-[length:var(--text-secondary)] text-muted">
                {mode.description}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
      {settings?.approval_mode === 'smart' && (
        <label className="mt-5 block">
          <span className="mb-2 block font-medium">Auto approver model</span>
          <Select
            label="Auto approver model"
            onValueChange={model => void patch({ auto_approver_model: model })}
            options={modelOptions(curated)}
            placeholder="Choose a model"
            value={settings.auto_approver_model ?? undefined}
          />
        </label>
      )}
    </>
  )
}

function modelOptions(models: ModelOption[]) {
  return models.map(model => ({ label: model.label, value: model.id }))
}

export function AppearanceSettings(): React.JSX.Element {
  const theme = useUi(state => state.theme)
  const setTheme = useUi(state => state.setTheme)

  return (
    <>
      <Heading description="Set the colour theme for this window.">Appearance</Heading>
      <fieldset className="flex gap-3">
        <legend className="sr-only">Theme</legend>
        {(['system', 'light', 'dark'] as ThemePreference[]).map(item => (
          <label
            className="flex min-w-28 cursor-pointer items-center gap-2 rounded-control border border-border p-3 capitalize"
            key={item}
          >
            <input
              checked={theme === item}
              name="theme"
              onChange={() => setTheme(item)}
              type="radio"
            />
            {item}
          </label>
        ))}
      </fieldset>
    </>
  )
}

export function UpdatesSettings(): React.JSX.Element {
  const bridge = getBridge()
  const [version, setVersion] = useState<string>('—')
  const [status, setStatus] = useState('Up to date')
  useEffect(() => {
    void daemonInfo().then(info => setVersion(info.version))

    if (!bridge) {
      return
    }

    return bridge.updater.onStatus(next => setStatus(next.message ?? next.state))
  }, [bridge])

  return (
    <>
      <Heading description="Version and release status for Hexbot.">Updates</Heading>
      <p>
        Daemon version: <strong>{version}</strong>
      </p>
      {bridge ? (
        <div className="mt-4">
          <p className="text-muted" role="status">
            {status}
          </p>
          <Button
            className="mt-3"
            onClick={() =>
              void bridge.updater.check().then(next => setStatus(next.message ?? next.state))
            }
          >
            Check now
          </Button>
        </div>
      ) : (
        <p className="mt-3 text-muted">Updates are handled by the app running this browser.</p>
      )}
    </>
  )
}

export function AboutSettings(): React.JSX.Element {
  const bridge = getBridge()
  const [info, setInfo] = useState<{ hermes_version: null | string; version: string } | null>(null)
  useEffect(() => {
    void daemonInfo().then(setInfo)
  }, [])

  const open = (url: string) =>
    bridge ? bridge.openExternal(url) : window.open(url, '_blank', 'noopener,noreferrer')

  return (
    <>
      <Heading description="Hexbot is a personal AI agent built on Hermes Agent.">About</Heading>
      <dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-2">
        <dt className="text-muted">Hexbot</dt>
        <dd>{bridge?.version ?? info?.version ?? '—'}</dd>
        <dt className="text-muted">Hermes Agent</dt>
        <dd>{info?.hermes_version ?? '—'}</dd>
        <dt className="text-muted">License</dt>
        <dd>MIT</dd>
      </dl>
      <div className="mt-6 flex gap-2">
        <Button
          icon={<ExternalLink size={14} />}
          onClick={() => void open('https://github.com/NousResearch/hermes-agent')}
        >
          Source
        </Button>
        <Button icon={<ExternalLink size={14} />} onClick={() => void open('https://hexbot.app')}>
          Website
        </Button>
      </div>
    </>
  )
}
