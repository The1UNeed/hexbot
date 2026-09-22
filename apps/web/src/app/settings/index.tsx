import { Copy, ExternalLink, Plus, Trash2 } from 'lucide-react'
import QRCode from 'qrcode'
import { useEffect, useRef, useState } from 'react'

import { isSubscription, ProviderPanel, supportsApiKey } from '../../components/provider-panel'
import { Button } from '../../components/ui/button'
import { Chip } from '../../components/ui/chip'
import { Input } from '../../components/ui/input'
import { Select } from '../../components/ui/select'
import { SkeletonLines } from '../../components/ui/skeleton'
import {
  connectDisconnect,
  connectRegisterPoll,
  connectRegisterStart,
  connectStatus,
  daemonInfo,
  modelsList,
  pairingCode,
  usageSummary,
  userMemoryGet,
  userMemorySet,
  usersInvite,
  usersUpdate
} from '../../lib/api'
import {
  defaultDeviceName,
  getBridge,
  updateAction,
  type UpdateChannel,
  type UpdateState
} from '../../lib/bridge'
import { cn } from '../../lib/cn'
import { pairWithDaemon, targetOrigin } from '../../lib/connection'
import type { ApprovalMode, ModelOption, PairingCode, Provider } from '../../lib/types'
import { daemonBehind } from '../../lib/version-skew'
import { useBots } from '../../stores/bots'
import { useConnection } from '../../stores/connection'
import { useSettings } from '../../stores/settings'
import { type ThemePreference, useUi } from '../../stores/ui'
import {
  type DaemonUpdate,
  dismissDaemonUpdate,
  updateDaemon,
  useUpdates
} from '../../stores/updates'
import { useUsers } from '../../stores/users'
import { MemoryEditor } from '../bot-settings/memory'

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
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Complete settings body; the file route owns the surrounding dialog and navigation. */
export function SettingsPanel({ tab }: { tab: string }): React.JSX.Element {
  return (
    <section aria-label={`${tab} settings`} className="min-w-0 max-w-3xl p-8">
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
  const [about, setAbout] = useState<Awaited<ReturnType<typeof userMemoryGet>> | null>(null)
  const [aboutError, setAboutError] = useState<string | null>(null)
  useEffect(() => {
    void refresh()
    void userMemoryGet()
      .then(setAbout)
      .catch(cause => setAboutError(errorText(cause)))
  }, [refresh])

  return (
    <>
      <Heading description="About you goes to every bot you own. Each bot keeps its own memory in its settings.">
        Memory
      </Heading>
      <h3 className="mb-1 font-semibold">About you</h3>
      <p className="mb-3 text-muted">
        Your name, what you do, and how you like to be spoken to. Only you write this.
      </p>
      {aboutError ? (
        <p className="text-danger" role="alert">
          {aboutError}
        </p>
      ) : about ? (
        <MemoryEditor
          cap={about.cap}
          label="About you"
          onSave={async text => setAbout(await userMemorySet(text))}
          value={about.text}
        />
      ) : (
        <SkeletonLines label="Loading memory" />
      )}
      <h3 className="mt-8 mb-1 font-semibold">Dreaming</h3>
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

  const bots = useBots(state => state.byName)

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
                  <td className="py-2">{bots[row.bot]?.display_name ?? row.bot}</td>
                  <td>{row.input_tokens.toLocaleString()}</td>
                  <td>{row.output_tokens.toLocaleString()}</td>
                  <td>${(row.estimated_cost_usd ?? 0).toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : (
        <SkeletonLines label="Loading usage" />
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
  const [query, setQuery] = useState('')
  useEffect(() => {
    void refresh()
  }, [refresh])

  return (
    <>
      <Heading description="Connect the model providers your bots can use.">Providers</Heading>
      <Input
        aria-label="Search providers"
        className="mb-3"
        onChange={event => setQuery(event.target.value)}
        placeholder="Search providers"
        value={query}
      />
      <div className="divide-y divide-border">
        {providers
          .filter(provider => {
            const needle = query.trim().toLowerCase()

            return !needle || `${provider.label} ${provider.id}`.toLowerCase().includes(needle)
          })
          .map(provider =>
            isSubscription(provider) ? (
              <SubscriptionRow
                clearKey={clearKey}
                key={provider.id}
                provider={provider}
                refresh={refresh}
              />
            ) : (
              <ProviderRow
                clearKey={clearKey}
                key={provider.id}
                provider={provider}
                setKey={setKey}
              />
            )
          )}
      </div>
      <p className="mt-6 text-[length:var(--text-secondary)] text-muted">
        Hexbot does not include any model credits. Usage is billed by your providers.
      </p>
      <DefaultModels />
    </>
  )
}

function SubscriptionRow({
  clearKey,
  provider,
  refresh
}: {
  clearKey: (provider: string) => Promise<void>
  provider: Provider
  refresh: () => Promise<void>
}) {
  return (
    <div className="py-4">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="font-medium">{provider.label}</h3>
          <Chip className="mt-1" tone={provider.configured ? 'success' : 'accent'}>
            {provider.configured ? 'Signed in' : 'Subscription'}
          </Chip>
        </div>
        {provider.configured && (
          <Button
            aria-label={`Sign out of ${provider.label}`}
            icon={<Trash2 size={14} />}
            onClick={() => void clearKey(provider.id)}
            size="sm"
            variant="ghost"
          >
            Sign out
          </Button>
        )}
      </div>
      <div className="mt-3">
        <ProviderPanel onConfigured={refresh} provider={provider} />
      </div>
    </div>
  )
}

function DefaultModels() {
  const settings = useSettings(state => state.settings)
  const providers = useSettings(state => state.providers)
  const refresh = useSettings(state => state.refresh)
  const patch = useSettings(state => state.patch)
  const [choices, setChoices] = useState<{ label: string; value: string }[]>([])
  useEffect(() => {
    void refresh()
  }, [refresh])
  useEffect(() => {
    const configured = providers.filter(item => item.configured === true)
    void Promise.all(
      configured.map(provider =>
        modelsList(provider.id)
          .then(result => (result.curated.length ? result.curated : result.all))
          .catch(() => [] as ModelOption[])
          .then(models =>
            models.map(model => ({
              label: `${provider.label} · ${model.label}`,
              value: `${provider.id}/${model.id}`
            }))
          )
      )
    ).then(lists => setChoices(lists.flat()))
  }, [providers])

  return (
    <div className="mt-8 space-y-4">
      <Heading description="The model new bots start with, and where a bot goes when its own provider fails.">
        Defaults
      </Heading>
      <label className="block space-y-2">
        <span className="font-medium">Default model</span>
        <Select
          label="Default model"
          onValueChange={value => void patch({ default_model: value })}
          options={choices}
          placeholder="Choose a model"
          value={settings?.default_model ?? undefined}
        />
      </label>
      <label className="block space-y-2">
        <span className="font-medium">
          Fallback <span className="text-muted">(optional)</span>
        </span>
        <Select
          label="Fallback model"
          onValueChange={value =>
            void patch({ fallback_model: value === '__none__' ? null : value })
          }
          options={[
            { label: 'None', value: '__none__' },
            ...choices.filter(item => item.value !== settings?.default_model)
          ]}
          placeholder="None"
          value={settings?.fallback_model ?? '__none__'}
        />
      </label>
    </div>
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

  if (!supportsApiKey(provider)) {
    return (
      <div className="py-4">
        <h3 className="font-medium">{provider.label}</h3>
        <div className="mt-2">
          <ProviderPanel onConfigured={() => Promise.resolve()} provider={provider} />
        </div>
      </div>
    )
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
      <div className="mt-3 flex flex-wrap gap-2">
        <Input
          aria-label={`${provider.label} API key`}
          className="min-w-56 flex-1"
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
  const [creating, setCreating] = useState(false)
  const [revoking, setRevoking] = useState(false)
  const [copied, setCopied] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [restarting, setRestarting] = useState(false)
  const connectionStatus = useConnection(state => state.status)
  const target = useConnection(state => state.target)
  const sawDisconnect = useRef(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!restarting) {
      return
    }

    if (connectionStatus !== 'connected') {
      sawDisconnect.current = true
    } else if (sawDisconnect.current) {
      setRestarting(false)
      sawDisconnect.current = false
      setCode(null)
      void Promise.all([refreshNetwork(), refreshDevices()]).catch(cause =>
        setError(errorText(cause))
      )
    }
  }, [connectionStatus, refreshDevices, refreshNetwork, restarting])
  useEffect(() => {
    void Promise.all([refreshNetwork(), refreshDevices()]).catch(cause =>
      setError(errorText(cause))
    )
  }, [refreshDevices, refreshNetwork])
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

  const createLink = async () => {
    setCreating(true)
    setError(null)
    setCopied(false)
    setCode(null)

    try {
      setCode(await pairingCode())
      setNow(Date.now())
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setCreating(false)
    }
  }

  const copyLink = async () => {
    if (!code || seconds === 0) {
      return
    }

    setError(null)

    try {
      await navigator.clipboard.writeText(code.link)
      setCopied(true)
    } catch {
      setError('Could not copy the link. Select the link below and copy it manually.')
    }
  }

  const revokeClients = async (ids: string[]) => {
    setRevoking(true)
    setError(null)

    try {
      await Promise.all(ids.map(id => revoke(id)))
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setRevoking(false)
    }
  }

  const toggle = async (enabled: boolean) => {
    setError(null)
    setRestarting(true)

    try {
      // Preserve this browser's access before the listener begins requiring
      // authentication. The existing pairing endpoint sets an HttpOnly cookie.
      if (enabled && !getBridge() && target?.kind === 'local') {
        const origin = new URL(targetOrigin(target))
        const pairing = await pairingCode()
        await pairWithDaemon(
          origin.hostname,
          Number(origin.port || 80),
          pairing.code,
          defaultDeviceName()
        )
      }

      await setLan(enabled)
    } catch (cause) {
      setRestarting(false)
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
          disabled={restarting}
          onChange={event => void toggle(event.target.checked)}
          type="checkbox"
        />
      </label>
      {restarting && (
        <p className="mt-4 rounded-control bg-warning/12 p-3 text-warning" role="status">
          Hexbot is restarting and will reconnect automatically.
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
        </div>
      )}
      <div className="mt-6">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-[length:var(--text-secondary)] text-muted">Authorized clients</h3>
          <div className="flex gap-2">
            <Button
              className="border border-border text-danger"
              disabled={revoking || !devices.some(device => !device.current)}
              onClick={() =>
                void revokeClients(
                  devices.filter(device => !device.current).map(device => device.id)
                )
              }
              size="sm"
              variant="ghost"
            >
              Revoke others
            </Button>
            <Button
              busy={creating}
              className="bg-blue-600 text-white hover:bg-blue-500"
              disabled={!network?.lan_enabled || restarting || connectionStatus !== 'connected'}
              icon={<Plus size={14} />}
              onClick={() => void createLink()}
              size="sm"
            >
              Create link
            </Button>
          </div>
        </div>
        {!network?.lan_enabled && (
          <p className="mb-3 text-[length:var(--text-secondary)] text-muted">
            Enable network access above to create a link for another device.
          </p>
        )}
        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface/30">
          {devices.map(device => (
            <li className="flex items-center gap-3 px-4 py-3" key={device.id}>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    aria-hidden="true"
                    className={`size-2 shrink-0 rounded-full ${device.current ? 'bg-emerald-500' : 'bg-muted/50'}`}
                  />
                  <span className="break-words">{device.name}</span>
                  {device.current && <Chip>This device</Chip>}
                </div>
                <p className="mt-1 text-[length:var(--text-meta)] text-muted">
                  {device.platform} · Last seen {formatDate(device.last_seen_at)}
                </p>
              </div>
              {!device.current && (
                <Button
                  disabled={revoking}
                  onClick={() => void revokeClients([device.id])}
                  size="sm"
                  variant="ghost"
                >
                  Revoke
                </Button>
              )}
            </li>
          ))}
          {devices.length === 0 && <li className="px-4 py-4 text-muted">No paired clients yet.</li>}
        </ul>
        {code && network?.lan_enabled && !restarting && (
          <div className="mt-4 rounded-xl border border-border p-4">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <h3 className="font-medium">Pair another device</h3>
                <p className="mt-1 font-mono text-2xl tracking-[0.2em]">{code.code}</p>
                <p className="mt-1 text-[length:var(--text-secondary)] text-muted" role="status">
                  {seconds > 0
                    ? `Single-use link. Expires in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
                    : 'This link has expired. Create a new link to pair a device.'}
                </p>
              </div>
              {seconds > 0 && <PairingQr link={code.link} />}
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <Input
                aria-label="Pairing link"
                className="min-w-0 flex-1 font-mono"
                onFocus={event => event.target.select()}
                readOnly
                value={code.link}
              />
              <Button
                disabled={seconds === 0}
                icon={<Copy size={14} />}
                onClick={() => void copyLink()}
                size="sm"
              >
                {copied ? 'Copied' : 'Copy link'}
              </Button>
            </div>
          </div>
        )}
      </div>
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
      <div
        aria-label="Theme"
        className="inline-flex gap-0.5 rounded-full bg-surface-2 p-0.5"
        role="radiogroup"
      >
        {(['system', 'light', 'dark'] as ThemePreference[]).map(item => (
          <button
            aria-checked={theme === item}
            className={cn(
              'h-8 min-w-24 rounded-full px-4 capitalize outline-none transition-colors focus-visible:ring-2 focus-visible:ring-foreground/40',
              theme === item
                ? 'bg-background text-foreground shadow-[0_1px_2px_rgb(0_0_0/0.08)]'
                : 'text-muted hover:text-foreground'
            )}
            key={item}
            onClick={() => setTheme(item)}
            role="radio"
            type="button"
          >
            {item}
          </button>
        ))}
      </div>
    </>
  )
}

const UPDATE_CHANNELS: { label: string; value: UpdateChannel }[] = [
  { label: 'Stable', value: 'stable' },
  { label: 'Nightly', value: 'nightly' }
]

function checkedAtLabel(at: null | string): string {
  const time = at ? new Date(at) : null

  if (!time || Number.isNaN(time.getTime())) {
    return ''
  }

  return ` Checked at ${time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`
}

export function updateLabel(state: null | UpdateState): string {
  if (!state) {
    return 'Not checked yet.'
  }

  switch (state.status) {
    case 'disabled':
      return state.message ?? 'Updates are off.'

    case 'checking':
      return 'Checking for updates…'

    case 'available':
      return `Version ${state.availableVersion} is available.`

    case 'downloading':
      return `Downloading version ${state.availableVersion}… ${state.percent ?? 0}%`

    case 'downloaded':
      return `Version ${state.downloadedVersion} is downloaded. Restart to install it.`

    case 'installing':
      return `Installing version ${state.downloadedVersion}. Hexbot restarts when it is done.`

    case 'error':
      return `${state.errorContext === 'download' ? 'Download' : state.errorContext === 'install' ? 'Install' : 'Update check'} failed: ${state.message ?? 'unknown error'}`

    case 'up-to-date':
      return `Up to date.${checkedAtLabel(state.checkedAt)}`

    default:
      return 'Not checked yet.'
  }
}

const DAEMON_STAGES: Record<DaemonUpdate['status'], string> = {
  checking: 'Checking for the update…',
  downloading: 'Downloading…',
  failed: 'Failed.',
  idle: 'Waiting…',
  installing: 'Installing…',
  requested: 'Asking the daemon…',
  restarting: 'Restarting the daemon…',
  'up-to-date': 'Nothing to install.'
}

export function daemonUpdateLabel(update: DaemonUpdate): string {
  if (update.status === 'failed') {
    return `Daemon update failed: ${update.message ?? 'unknown error'}`
  }

  const stage = DAEMON_STAGES[update.status]

  return update.status === 'downloading' && update.percent !== null
    ? `${stage} ${update.percent}%`
    : stage
}

function DaemonUpdates({ appVersion }: { appVersion: null | string }): React.JSX.Element {
  const daemon = useConnection(state => state.daemon)
  const update = useUpdates(state => state.daemon)

  if (!daemon) {
    return <p className="text-muted">Not connected to a daemon.</p>
  }

  const behind = daemonBehind(appVersion, daemon.version)
  const canUpdate = Boolean(daemon.update_capability)

  return (
    <>
      <p>
        {daemon.daemon_name} runs <strong>{daemon.version}</strong>.
      </p>
      {update ? (
        <>
          <p className="mt-2 text-muted" role="status">
            {daemonUpdateLabel(update)}
          </p>
          {update.status === 'failed' ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {canUpdate && appVersion ? (
                <Button onClick={() => void updateDaemon(appVersion)} variant="primary">
                  Try again
                </Button>
              ) : null}
              <Button onClick={dismissDaemonUpdate}>Dismiss</Button>
            </div>
          ) : null}
        </>
      ) : !appVersion ? (
        <p className="mt-2 text-muted">Updates are handled by the app running this browser.</p>
      ) : !behind ? (
        <p className="mt-2 text-muted">The daemon is up to date with this app.</p>
      ) : canUpdate ? (
        <>
          <p className="mt-2 text-muted">
            This app is {appVersion}. The daemon can update itself to match
            {daemon.update_capability === 'desktop'
              ? `: the Hexbot app on ${daemon.daemon_name} downloads the update, then closes and reopens on the new version.`
              : `: it downloads the new version, installs it, and restarts.`}{' '}
            Bots stop while it restarts.
          </p>
          <div className="mt-3">
            <Button onClick={() => void updateDaemon(appVersion)} variant="primary">
              Update daemon
            </Button>
          </div>
        </>
      ) : (
        <p className="mt-2 text-muted">
          This app is {appVersion}. This daemon cannot update itself; update Hexbot on{' '}
          {daemon.daemon_name} by hand.
        </p>
      )}
    </>
  )
}

export function UpdatesSettings(): React.JSX.Element {
  const bridge = getBridge()
  const app = useUpdates(state => state.app)
  const [pending, setPending] = useState(false)
  const action = app ? updateAction(app) : 'check'
  const busy = pending || app?.status === 'checking' || app?.status === 'downloading'

  const run = (call: () => Promise<unknown>) => {
    setPending(true)
    void call()
      .catch(() => undefined)
      .finally(() => setPending(false))
  }

  return (
    <>
      <Heading description="Version and release status for Hexbot.">Updates</Heading>
      {bridge ? (
        <div>
          <p>
            App version: <strong>{bridge.version}</strong>
            {app ? ` · ${app.channel === 'nightly' ? 'Nightly' : 'Stable'} track` : ''}
          </p>
          <p className="mt-2 text-muted" role="status">
            {updateLabel(app)}
          </p>
          {app?.status !== 'disabled' ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {action === 'download' ? (
                <Button
                  disabled={busy}
                  onClick={() => run(() => bridge.updater.download())}
                  variant="primary"
                >
                  {app?.errorContext === 'download' ? 'Retry download' : 'Download update'}
                </Button>
              ) : null}
              {action === 'install' ? (
                <Button
                  disabled={busy}
                  onClick={() => run(() => bridge.updater.install())}
                  variant="primary"
                >
                  Restart and install
                </Button>
              ) : null}
              <Button
                busy={app?.status === 'checking'}
                disabled={busy}
                onClick={() => run(() => bridge.updater.check())}
              >
                Check now
              </Button>
            </div>
          ) : null}
          <label className="mt-6 block max-w-xs space-y-2">
            <span className="font-medium">Update track</span>
            <Select
              disabled={busy || !app || app.status === 'disabled'}
              label="Update track"
              onValueChange={value =>
                run(() => bridge.updater.setChannel(value === 'nightly' ? 'nightly' : 'stable'))
              }
              options={UPDATE_CHANNELS}
              value={app?.channel}
            />
            <span className="block text-muted">
              Stable is tagged releases. Nightly is built from main every day and may break;
              switching tracks replaces the app at the next update.
            </span>
          </label>
        </div>
      ) : null}
      <h3 className={cn('font-medium', bridge ? 'mt-8' : '')}>Daemon</h3>
      <div className="mt-2">
        <DaemonUpdates appVersion={bridge?.version ?? null} />
      </div>
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
      <Heading description="Hexbot is a self-hosted multi-agent app built on Hermes Agent.">
        About
      </Heading>
      <dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-2">
        <dt className="text-muted">Hexbot</dt>
        <dd>{bridge?.version ?? info?.version ?? '—'}</dd>
        {bridge ? (
          <>
            <dt className="text-muted">Package</dt>
            <dd>{bridge.edition === 'client' ? 'Client only' : 'Full'}</dd>
          </>
        ) : null}
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
