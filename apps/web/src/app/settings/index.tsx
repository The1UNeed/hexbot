import { ChevronDown, ChevronLeft, Copy, ExternalLink, Plus, Scale, Search } from 'lucide-react'
import QRCode from 'qrcode'
import { useEffect, useRef, useState } from 'react'

import { isSubscription, ProviderPanel, supportsApiKey } from '../../components/provider-panel'
import { Button } from '../../components/ui/button'
import { Chip } from '../../components/ui/chip'
import { Input } from '../../components/ui/input'
import { Select } from '../../components/ui/select'
import { settingsPageClass } from '../../components/ui/settings-shell'
import { SkeletonLines } from '../../components/ui/skeleton'
import { Switch } from '../../components/ui/switch'
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
import { useApprovalModes } from '../../lib/approval-modes'
import {
  defaultDeviceName,
  getBridge,
  updateAction,
  type UpdateChannel,
  type UpdateState
} from '../../lib/bridge'
import { cn } from '../../lib/cn'
import { connectStatusMessage } from '../../lib/connect-status'
import { connectBaseUrl } from '../../lib/connect-url'
import { pairWithDaemon, targetOrigin } from '../../lib/connection'
import type { DaemonInfo, ModelOption, PairingCode, Provider } from '../../lib/types'
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
import { ChoiceRow, dividerClass, Group, Heading, Row, rowFieldClass } from '../bot-settings/shared'
import { ConfirmUpdate, updateNow, updateTarget } from '../confirm-update'

import { ArchiveSettings } from './archive'
import { OPEN_SOURCE } from './licenses'

export const SETTINGS_TABS = [
  'providers',
  'network',
  'connect',
  'memory',
  'archive',
  'users',
  'usage',
  'approvals',
  'appearance',
  'updates',
  'about'
] as const

export type SettingsTab = (typeof SETTINGS_TABS)[number]

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** A short notice under a heading: a warning, or progress the user should know about. */
function Notice({
  children,
  role,
  tone = 'warning'
}: {
  children: React.ReactNode
  role?: 'alert' | 'status'
  tone?: 'danger' | 'warning'
}) {
  return (
    <p
      className={cn(
        'mb-5 rounded-[12px] px-4 py-3 text-[length:var(--text-secondary)]',
        tone === 'danger' ? 'bg-danger/10 text-danger' : 'bg-warning/10 text-warning'
      )}
      role={role}
    >
      {children}
    </p>
  )
}

function ErrorLine({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-3 text-[length:var(--text-secondary)] text-danger" role="alert">
      {children}
    </p>
  )
}

/** Complete settings body; the file route owns the surrounding window and navigation. */
export function SettingsPanel({ tab }: { tab: string }): React.JSX.Element {
  return (
    <section aria-label={`${tab} settings`} className={settingsPageClass}>
      {tab === 'providers' && <ProvidersSettings />}
      {tab === 'network' && <NetworkSettings />}
      {tab === 'connect' && <ConnectSettings />}
      {tab === 'memory' && <MemorySettings />}
      {tab === 'archive' && <ArchiveSettings />}
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
      <div className="space-y-8">
        <div>
          <p className="mb-2 px-1 text-[length:var(--text-meta)] font-medium text-muted">
            About you
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
              placeholder="Your name, what you do, and how you like to be spoken to."

              value={about.text}
            />
          ) : (
            <SkeletonLines label="Loading memory" />
          )}
          <p className="mt-2 px-1 text-[length:var(--text-meta)] text-muted">
            Your name, what you do, and how you like to be spoken to. Only you write this.
          </p>
        </div>
        <Group title="Dreaming">
          <Row
            control={
              <Switch
                aria-label="Enable dreaming globally"
                checked={settings?.dream_enabled ?? false}
                onCheckedChange={checked => void patch({ dream_enabled: checked })}
              />
            }
            description="Each day, every bot with dreaming on folds its conversations into its memory."
            title="Dreaming"
          />
          <Row
            control={
              <Input
                aria-label="Daily dream time"
                className="w-32"
                defaultValue={settings?.dream_time ?? '03:00'}
                onBlur={event => void patch({ dream_time: event.target.value })}
                type="time"
              />
            }
            description="When the daily pass runs, in the daemon's time zone."
            title="Dream time"
          />
        </Group>
      </div>
    </>
  )
}

/** The daemon's `last_error` after the owner revoked it on the Connect dashboard (services.rs). */
const REVOKED_REASON = 'Removed in Hex Connect'

export function ConnectSettings() {
  const [status, setStatus] = useState<Awaited<ReturnType<typeof connectStatus>> | null>(null)

  const [registration, setRegistration] = useState<Awaited<
    ReturnType<typeof connectRegisterStart>
  > | null>(null)

  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [statusError, setStatusError] = useState<string | null>(null)
  useEffect(() => {
    let stopped = false
    let timer: number | undefined

    const refresh = async () => {
      try {
        const next = await connectStatus()

        if (!stopped) {
          setStatus(next)
          setStatusError(null)
        }
      } catch {
        if (!stopped) {
          setStatusError('The daemon could not be reached.')
        }
      } finally {
        if (!stopped) {
          timer = window.setTimeout(() => void refresh(), 5000)
        }
      }
    }

    void refresh()

    return () => {
      stopped = true
      window.clearTimeout(timer)
    }
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

  const external = (url: string, text: string) => (
    <a
      className="text-accent hover:underline"
      href={url}
      onClick={event => {
        if (getBridge()) {
          event.preventDefault()
          void open(url)
        }
      }}
      rel="noreferrer"
      target="_blank"
    >
      {text}
    </a>
  )

  return (
    <>
      <Heading description="Reach this daemon from outside your network. Chat traffic never passes through Connect.">
        Hex Connect
      </Heading>
      {status?.registered ? (
        <Group
          footer={
            <>
              Open the address in any browser and sign in with Hex Connect. Manage this daemon and
              your signed-in apps at{' '}
              {external(
                `${connectBaseUrl()}/connect`,
                connectBaseUrl().replace(/^https?:\/\//, '')
              )}
              .
            </>
          }
          title="This daemon"
        >
          <Row
            control={external(`https://${status.tunnel_hostname}`, status.tunnel_hostname ?? '')}
            title="Address"
          />
          <Row
            control={
              <span className="text-[length:var(--text-secondary)] text-muted">
                {status.tunnel_running ? 'Running' : 'Stopped'}
              </span>
            }
            title="Tunnel"
          />
          <Row
            control={
              <Button
                onClick={() =>
                  void connectDisconnect().then(() => setStatus({ ...status, registered: false }))
                }
                size="sm"
                variant="danger"
              >
                Disconnect
              </Button>
            }
            description="Removes this daemon from your Hex Connect account."
            title="Disconnect"
          />
        </Group>
      ) : registration ? (
        <Group title="Sign in">
          <div className="px-4 py-5 text-center">
            <p className="text-[length:var(--text-secondary)] text-muted">
              Open the verification page and enter this code.
            </p>
            <p className="mt-3 font-mono text-[28px] tracking-[0.2em]">{registration.user_code}</p>
            <div className="mt-4">
              {getBridge() ? (
                <Button onClick={() => void open(registration.verify_url)} variant="primary">
                  Open verification page
                </Button>
              ) : (
                <a className="text-accent underline" href={registration.verify_url}>
                  {registration.verify_url}
                </a>
              )}
            </div>
            <p className="mt-4 text-[length:var(--text-secondary)] text-muted">
              Waiting for approval…
            </p>
          </div>
        </Group>
      ) : (
        <Group>
          <Row
            control={
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
            }
            description={
              status?.last_error === REVOKED_REASON
                ? `${REVOKED_REASON}. Sign in to register it again.`
                : 'Sign in to get an address for this daemon.'
            }
            title="Not connected"
          />
        </Group>
      )}
      {error || statusError ? <ErrorLine>{error ?? statusError}</ErrorLine> : null}
      {status?.registered && status.last_error ? (
        <ErrorLine>{connectStatusMessage(status.last_error)}</ErrorLine>
      ) : null}
      {status?.registered && status.identity_error ? (
        <ErrorLine>{connectStatusMessage(status.identity_error, true)}</ErrorLine>
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
      <Heading description="Invite the people in your household and set their daily token budgets.">
        Users
      </Heading>
      <div className="space-y-8">
        <Group title="Invite">
          <form
            className="flex items-center gap-2 px-4 py-2.5"
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
              className={rowFieldClass}
              onChange={event => setName(event.target.value)}
              placeholder="Display name"
              value={name}
            />
            <Button disabled={!name.trim()} size="sm" type="submit" variant="primary">
              Invite
            </Button>
          </form>
          {invite ? (
            <div className="px-4 py-4 text-center">
              <p className="text-[length:var(--text-secondary)] text-muted">
                Pairing code for the new user's device
              </p>
              <p className="mt-2 font-mono text-[28px] tracking-[0.2em]">{invite.code}</p>
              {network?.addresses[0] ? (
                <a
                  className="mt-2 inline-block break-all text-[length:var(--text-secondary)] text-accent hover:underline"
                  href={`hexbot://pair?host=${encodeURIComponent(network.addresses[0])}&port=${network.port}#code=${encodeURIComponent(invite.code)}`}
                >
                  Open pairing link
                </a>
              ) : null}
            </div>
          ) : null}
        </Group>
        <Group footer="A budget is tokens per day. Leave it empty for no limit." title="People">
          {users.map(user => (
            <div
              className="grid min-h-[52px] grid-cols-[1fr_120px_auto] items-center gap-3 px-4 py-2"
              key={user.id}
            >
              <Input
                aria-label={`Name for ${user.display_name}`}
                className={rowFieldClass}
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
                className="h-[32px] text-[length:var(--text-secondary)]"
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
            </div>
          ))}
        </Group>
      </div>
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

  const number = (value: number) => (
    <span className="font-mono text-[length:var(--text-secondary)] tabular-nums">
      {value.toLocaleString()}
    </span>
  )

  return (
    <>
      <Heading description="Token use reported by this daemon.">Usage</Heading>
      {summary ? (
        <div className="space-y-8">
          <Group title="This daemon">
            <Row control={number(summary.input_tokens)} title="Input tokens" />
            <Row control={number(summary.output_tokens)} title="Output tokens" />
            <Row
              control={
                <span className="font-mono text-[length:var(--text-secondary)] tabular-nums">
                  ${summary.estimated_cost_usd.toFixed(2)}
                </span>
              }
              title="Estimated cost"
            />
          </Group>
          {rows.length ? (
            <Group title="By bot">
              {rows.map(row => (
                <Row
                  control={
                    <span className="font-mono text-[length:var(--text-secondary)] tabular-nums">
                      ${(row.estimated_cost_usd ?? 0).toFixed(2)}
                    </span>
                  }
                  description={`${row.input_tokens.toLocaleString()} in · ${row.output_tokens.toLocaleString()} out`}
                  key={row.bot}
                  title={bots[row.bot]?.display_name ?? row.bot}
                />
              ))}
            </Group>
          ) : null}
        </div>
      ) : (
        <SkeletonLines label="Loading usage" />
      )}
    </>
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

  const needle = query.trim().toLowerCase()

  const visible = providers.filter(
    provider => !needle || `${provider.label} ${provider.id}`.toLowerCase().includes(needle)
  )

  // The groups are fixed when the page opens: a row that gets its first key
  // stays where it is, so its open editor and test result are not remounted.
  const [connectedIds, setConnectedIds] = useState<null | Set<string>>(null)
  useEffect(() => {
    if (!connectedIds && providers.length) {
      setConnectedIds(
        new Set(providers.filter(item => item.configured === true).map(item => item.id))
      )
    }
  }, [connectedIds, providers])

  const isConnected = (provider: Provider) =>
    connectedIds ? connectedIds.has(provider.id) : provider.configured === true

  const connected = visible.filter(isConnected)
  const rest = visible.filter(provider => !isConnected(provider))

  const row = (provider: Provider) =>
    isSubscription(provider) ? (
      <SubscriptionRow
        clearKey={clearKey}
        key={provider.id}
        provider={provider}
        refresh={refresh}
      />
    ) : (
      <ProviderRow clearKey={clearKey} key={provider.id} provider={provider} setKey={setKey} />
    )

  return (
    <>
      <Heading description="The model providers your bots can use. Usage is billed by them; Hexbot includes no credits.">
        Providers
      </Heading>
      <div className="space-y-8">
        <label className="relative block">
          <Search
            className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-muted"
            size={15}
          />
          <Input
            aria-label="Search providers"
            className="rounded-full pl-9"
            onChange={event => setQuery(event.target.value)}
            placeholder="Search providers"
            value={query}
          />
        </label>
        {connected.length ? <Group title="Connected">{connected.map(row)}</Group> : null}
        {rest.length ? (
          <Group title={connected.length ? 'More providers' : 'All providers'}>
            {rest.map(row)}
          </Group>
        ) : null}
        {!visible.length ? (
          <p className="px-1 text-[length:var(--text-secondary)] text-muted">
            No provider matches that.
          </p>
        ) : null}
        <DefaultModels />
      </div>
    </>
  )
}

/** One provider in the list: the name and state, a control, and details on click. */
function ExpandableRow({
  children,
  control,
  description,
  expanded,
  onToggle,
  title
}: {
  children: React.ReactNode
  control?: React.ReactNode
  description: React.ReactNode
  expanded: boolean
  onToggle: () => void
  title: string
}) {
  return (
    <div>
      <div className="flex min-h-[52px] items-center gap-4 px-4 py-2.5">
        <button
          aria-expanded={expanded}
          className="min-w-0 flex-1 text-left outline-none"
          onClick={onToggle}
          type="button"
        >
          <span className="block text-[length:var(--text-body)]">{title}</span>
          <span className="mt-0.5 block text-[length:var(--text-secondary)] text-muted">
            {description}
          </span>
        </button>
        {control}
        <ChevronDown
          aria-hidden
          className={cn(
            'shrink-0 text-muted transition-transform duration-[var(--hex-motion-fast)]',
            expanded && 'rotate-180'
          )}
          size={15}
        />
      </div>
      {expanded ? <div className="hex-fade px-4 pt-1 pb-4">{children}</div> : null}
    </div>
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
  const [open, setOpen] = useState(false)

  return (
    <ExpandableRow
      control={
        provider.configured ? (
          <Chip tone="success">Signed in</Chip>
        ) : (
          <Button onClick={() => setOpen(true)} size="sm">
            Sign in
          </Button>
        )
      }
      description={
        provider.configured ? 'Subscription' : 'Subscription, sign in through your browser'
      }
      expanded={open}
      onToggle={() => setOpen(value => !value)}
      title={provider.label}
    >
      {provider.configured ? (
        <Button
          aria-label={`Sign out of ${provider.label}`}
          onClick={() => void clearKey(provider.id)}
          size="sm"
          variant="ghost"
        >
          Sign out
        </Button>
      ) : (
        <ProviderPanel onConfigured={refresh} provider={provider} />
      )}
    </ExpandableRow>
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
    <Group
      footer="New bots start on the default model. A bot falls back when its own provider fails."
      title="Defaults"
    >
      <Row
        control={
          <div className="w-[min(260px,42vw)]">
            <Select
              label="Default model"
              onValueChange={value => void patch({ default_model: value })}
              options={choices}
              placeholder="Choose a model"
              value={settings?.default_model ?? undefined}
            />
          </div>
        }
        title="Default model"
      />
      <Row
        control={
          <div className="w-[min(260px,42vw)]">
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
          </div>
        }
        title="Fallback"
      />
    </Group>
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
  const [open, setOpen] = useState(false)
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
      <ExpandableRow
        description="Configured on the daemon"
        expanded={open}
        onToggle={() => setOpen(value => !value)}
        title={provider.label}
      >
        <ProviderPanel onConfigured={() => Promise.resolve()} provider={provider} />
      </ExpandableRow>
    )
  }

  return (
    <ExpandableRow
      control={
        provider.configured ? (
          <Chip tone="success">Connected</Chip>
        ) : (
          <Button onClick={() => setOpen(true)} size="sm">
            Add key
          </Button>
        )
      }
      description={provider.configured ? 'API key saved' : 'Needs an API key'}
      expanded={open}
      onToggle={() => setOpen(value => !value)}
      title={provider.label}
    >
      <form
        className="flex flex-wrap gap-2"
        onSubmit={event => {
          event.preventDefault()
          void save()
        }}
      >
        <Input
          aria-label={`${provider.label} API key`}
          autoFocus
          className="min-w-56 flex-1 font-mono text-[length:var(--text-secondary)]"
          onChange={event => setDraft(event.target.value)}
          placeholder={provider.configured ? 'Replace the saved key' : 'API key'}
          type="password"
          value={key}
        />
        <Button busy={busy} disabled={!key} type="submit" variant="primary">
          Save
        </Button>
        <Button busy={busy} onClick={() => void test()}>
          Test
        </Button>
      </form>
      <div className="mt-2 flex min-h-5 items-center justify-between gap-3">
        {result ? (
          <p className="text-[length:var(--text-secondary)] text-muted" role="status">
            {result}
          </p>
        ) : (
          <span />
        )}
        {provider.configured ? (
          <Button
            aria-label={`Remove ${provider.label} key`}
            onClick={() => void clearKey(provider.id)}
            size="sm"
            variant="ghost"
          >
            Remove key
          </Button>
        ) : null}
      </div>
    </ExpandableRow>
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
  const [reconnecting, setReconnecting] = useState(false)
  const connectionStatus = useConnection(state => state.status)
  const target = useConnection(state => state.target)
  const sawDisconnect = useRef(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!reconnecting) {
      return
    }

    if (connectionStatus !== 'connected') {
      sawDisconnect.current = true
    } else if (sawDisconnect.current) {
      setReconnecting(false)
      sawDisconnect.current = false
      setCode(null)
      void Promise.all([refreshNetwork(), refreshDevices()]).catch(cause =>
        setError(errorText(cause))
      )
    }
  }, [connectionStatus, refreshDevices, refreshNetwork, reconnecting])
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
    setReconnecting(true)

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
      setReconnecting(false)
      setError(errorText(cause))
    }
  }

  return (
    <>
      <Heading description="Pair devices with this daemon over your local network.">
        Network
      </Heading>
      {reconnecting ? (
        <Notice role="status">
          Reconnecting to the daemon at its new address. Running bot turns continue.
        </Notice>
      ) : null}
      {error ? (
        <Notice role="alert" tone="danger">
          {error}
        </Notice>
      ) : null}
      <div className="space-y-8">
        <Group>
          <Row
            control={
              <Switch
                aria-label="Allow other devices on this network"
                checked={network?.lan_enabled ?? false}
                disabled={reconnecting}
                onCheckedChange={checked => void toggle(checked)}
              />
            }
            description="Direct LAN HTTP does not encrypt sign-ins or chat. Use Tailscale or HTTPS on untrusted networks."
            title="Allow other devices on this network"
          />
          {network?.lan_enabled ? (
            <Row
              control={
                <ul className="text-right font-mono text-[length:var(--text-secondary)] text-muted">
                  {network.addresses.map(address => (
                    <li key={address}>
                      {address}:{network.port}
                    </li>
                  ))}
                </ul>
              }
              title="Addresses"
            />
          ) : null}
        </Group>
        <Group
          action={
            <div className="flex gap-1.5">
              <Button
                className="text-danger hover:text-danger"
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
                disabled={!network?.lan_enabled || reconnecting || connectionStatus !== 'connected'}
                icon={<Plus size={14} />}
                onClick={() => void createLink()}
                size="sm"
                variant="primary"
              >
                Create link
              </Button>
            </div>
          }
          footer={
            network?.lan_enabled
              ? undefined
              : 'Turn on network access above to create a link for another device.'
          }
          title="Paired devices"
        >
          {devices.map(device => (
            <Row
              control={
                device.current ? (
                  <Chip>This device</Chip>
                ) : (
                  <Button
                    disabled={revoking}
                    onClick={() => void revokeClients([device.id])}
                    size="sm"
                    variant="ghost"
                  >
                    Revoke
                  </Button>
                )
              }
              description={`${device.platform} · Last seen ${formatDate(device.last_seen_at)}`}
              key={device.id}
              title={
                <span className="flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className={cn(
                      'size-2 shrink-0 rounded-full',
                      device.current ? 'bg-success' : 'bg-foreground/20'
                    )}
                  />
                  <span className="break-words">{device.name}</span>
                </span>
              }
            />
          ))}
          {devices.length === 0 ? (
            <Row title={<span className="text-muted">No paired devices yet.</span>} />
          ) : null}
        </Group>
        {code && network?.lan_enabled && !reconnecting ? (
          <Group title="Pair another device">
            <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-4">
              <div>
                <p className="font-mono text-[28px] tracking-[0.2em]">{code.code}</p>
                <p className="mt-1 text-[length:var(--text-secondary)] text-muted" role="status">
                  {seconds > 0
                    ? `Single-use link. Expires in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
                    : 'This link has expired. Create a new link to pair a device.'}
                </p>
              </div>
              {seconds > 0 ? <PairingQr link={code.link} /> : null}
            </div>
            <div className="flex flex-wrap gap-2 px-4 py-3">
              <Input
                aria-label="Pairing link"
                className="min-w-0 flex-1 font-mono text-[length:var(--text-secondary)]"
                onFocus={event => event.target.select()}
                readOnly
                value={code.link}
              />
              <Button
                disabled={seconds === 0}
                icon={<Copy size={14} />}
                onClick={() => void copyLink()}
              >
                {copied ? 'Copied' : 'Copy link'}
              </Button>
            </div>
          </Group>
        ) : null}
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

  return <canvas aria-label="Pairing QR code" className="rounded-[10px]" ref={canvas} />
}

function formatDate(value: null | number): string {
  return value ? new Date(value * (value < 10_000_000_000 ? 1000 : 1)).toLocaleString() : 'never'
}

export function ApprovalsSettings(): React.JSX.Element {
  const settings = useSettings(state => state.settings)
  const refresh = useSettings(state => state.refresh)
  const patch = useSettings(state => state.patch)
  const modes = useApprovalModes(settings?.approval_mode)
  const [info, setInfo] = useState<DaemonInfo | undefined>(undefined)
  useEffect(() => {
    void refresh()
    // Without daemon info, as from an older daemon, there is nothing to warn about.
    void daemonInfo()
      .then(setInfo)
      .catch(() => {})
  }, [refresh])

  return (
    <>
      <Heading description="Choose when Hexbot asks before a bot acts. Bots and rooms can override it.">
        Approvals
      </Heading>
      {info && info.approvals !== 'sandbox' ? (
        <Notice role="status">
          This daemon is older than the app and still uses its previous approval rules. Update the
          daemon to get the sandbox these modes describe.
        </Notice>
      ) : null}
      {info?.approvals === 'sandbox' && info.sandbox === null ? (
        <Notice role="status">
          No OS sandbox is available, so Manual and Auto ask before every shell command and code
          run. Install bubblewrap on the computer running the daemon, then restart the daemon to
          restore isolation.
        </Notice>
      ) : null}
      <Group title="Mode">
        <div aria-label="Approval mode" className={dividerClass} role="radiogroup">
          {modes.map(mode => (
            <ChoiceRow
              checked={settings?.approval_mode === mode.value}
              description={mode.description}
              key={mode.value}
              onSelect={() => void patch({ approval_mode: mode.value })}
              title={mode.label}
            />
          ))}
        </div>
      </Group>
    </>
  )
}

export function AppearanceSettings(): React.JSX.Element {
  const theme = useUi(state => state.theme)
  const setTheme = useUi(state => state.setTheme)

  return (
    <>
      <Heading description="How this window looks.">Appearance</Heading>
      <Group>
        <Row
          control={
            <div
              aria-label="Theme"
              className="inline-flex gap-0.5 rounded-full bg-foreground/[0.06] p-0.5"
              role="radiogroup"
            >
              {(['system', 'light', 'dark'] as ThemePreference[]).map(item => (
                <button
                  aria-checked={theme === item}
                  className={cn(
                    'h-7 min-w-[72px] rounded-full px-3 text-[length:var(--text-secondary)] capitalize outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/50',
                    theme === item
                      ? 'bg-background text-foreground shadow-card'
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
          }
          description="System follows the computer's setting."
          title="Theme"
        />
      </Group>
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
    return (
      <Group title="Daemon">
        <Row title={<span className="text-muted">Not connected to a daemon.</span>} />
      </Group>
    )
  }

  const behind = daemonBehind(appVersion, daemon.version)
  const canUpdate = Boolean(daemon.update_capability)

  const title = (
    <>
      {daemon.daemon_name} runs <strong className="font-semibold">{daemon.version}</strong>
    </>
  )

  if (update) {
    return (
      <Group title="Daemon">
        <Row
          control={
            update.status === 'failed' ? (
              <>
                {canUpdate && appVersion ? (
                  <Button onClick={() => void updateDaemon(appVersion)} size="sm" variant="primary">
                    Try again
                  </Button>
                ) : null}
                <Button onClick={dismissDaemonUpdate} size="sm">
                  Dismiss
                </Button>
              </>
            ) : undefined
          }
          description={<span role="status">{daemonUpdateLabel(update)}</span>}
          title={title}
        />
      </Group>
    )
  }

  return (
    <Group
      footer={
        appVersion && behind && canUpdate
          ? daemon.update_capability === 'desktop'
            ? `The Hexbot app on ${daemon.daemon_name} downloads the update, then closes and reopens on the new version. Bots stop while it restarts.`
            : 'The daemon downloads the new version, installs it, and restarts. Bots stop while it restarts.'
          : undefined
      }
      title="Daemon"
    >
      <Row
        control={
          appVersion && behind && canUpdate ? (
            <Button onClick={() => void updateDaemon(appVersion)} size="sm" variant="primary">
              Update daemon
            </Button>
          ) : undefined
        }
        description={
          !appVersion
            ? 'Updates are handled by the app running this browser.'
            : !behind
              ? 'The daemon is up to date with this app.'
              : canUpdate
                ? `This app is ${appVersion}. The daemon can update itself to match.`
                : `This app is ${appVersion}. This daemon cannot update itself; update Hexbot on ${daemon.daemon_name} by hand.`
        }
        title={title}
      />
    </Group>
  )
}

export function UpdatesSettings(): React.JSX.Element {
  const bridge = getBridge()
  const app = useUpdates(state => state.app)
  const [pending, setPending] = useState(false)
  const [confirming, setConfirming] = useState(false)
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
      <div className="space-y-8">
        {bridge ? (
          <Group
            footer="Stable is tagged releases. Nightly is built from main every day and may break; switching tracks replaces the app at the next update."
            title="App"
          >
            <Row
              control={
                app?.status !== 'disabled' ? (
                  <>
                    {action === 'download' || action === 'install' ? (
                      <Button
                        disabled={busy}
                        onClick={() => setConfirming(true)}
                        size="sm"
                        variant="primary"
                      >
                        {action === 'install'
                          ? 'Restart and install'
                          : app?.errorContext === 'download'
                            ? 'Retry update'
                            : 'Update'}
                      </Button>
                    ) : null}
                    <Button
                      busy={app?.status === 'checking'}
                      disabled={busy}
                      onClick={() => run(() => bridge.updater.check())}
                      size="sm"
                    >
                      Check now
                    </Button>
                  </>
                ) : undefined
              }
              description={<span role="status">{updateLabel(app)}</span>}
              title={
                <>
                  Hexbot <strong className="font-semibold">{bridge.version}</strong>
                </>
              }
            />
            <Row
              control={
                <div className="w-[160px]">
                  <Select
                    disabled={busy || !app || app.status === 'disabled'}
                    label="Update track"
                    onValueChange={value =>
                      run(() =>
                        bridge.updater.setChannel(value === 'nightly' ? 'nightly' : 'stable')
                      )
                    }
                    options={UPDATE_CHANNELS}
                    value={app?.channel}
                  />
                </div>
              }
              title="Update track"
            />
          </Group>
        ) : null}
        {bridge ? (
          <ConfirmUpdate
            onClose={() => setConfirming(false)}
            onConfirm={() => run(() => updateNow(bridge))}
            version={confirming ? updateTarget(app) : null}
          />
        ) : null}
        <DaemonUpdates appVersion={bridge?.version ?? null} />
      </div>
    </>
  )
}

export function AboutSettings(): React.JSX.Element {
  const bridge = getBridge()
  const [info, setInfo] = useState<{ hermes_version: null | string; version: string } | null>(null)
  const [licenses, setLicenses] = useState(false)
  useEffect(() => {
    void daemonInfo().then(setInfo)
  }, [])

  const open = (url: string) =>
    bridge ? bridge.openExternal(url) : window.open(url, '_blank', 'noopener,noreferrer')

  const value = (text: string) => (
    <span className="text-[length:var(--text-secondary)] text-muted">{text}</span>
  )

  if (licenses) {
    return <Licenses onBack={() => setLicenses(false)} />
  }

  return (
    <>
      <Heading description="Hexbot is a self-hosted multi-agent app.">About</Heading>
      <div className="space-y-8">
        <Group>
          <Row control={value(bridge?.version ?? info?.version ?? '—')} title="Hexbot" />
          {bridge ? (
            <Row
              control={value(bridge.edition === 'client' ? 'Client only' : 'Full')}
              title="Package"
            />
          ) : null}
          <Row control={value(info?.hermes_version ?? '—')} title="Agent core" />
          <Row control={value('AGPL-3.0')} title="License" />
        </Group>
        <div className="flex gap-2">
          <Button
            icon={<ExternalLink size={14} />}
            onClick={() => void open('https://github.com/The1UNeed/hexbot')}
          >
            Source
          </Button>
          <Button icon={<ExternalLink size={14} />} onClick={() => void open('https://hexbot.app')}>
            Website
          </Button>
          <Button icon={<Scale size={14} />} onClick={() => setLicenses(true)}>
            Licenses
          </Button>
        </div>
      </div>
    </>
  )
}

/** The open source projects Hexbot ships or is built on, each linked to its repository. */
function Licenses({ onBack }: { onBack: () => void }) {
  const bridge = getBridge()

  return (
    <>
      <Button
        className="-ml-2 mb-3"
        icon={<ChevronLeft size={14} />}
        onClick={onBack}
        size="sm"
        variant="ghost"
      >
        About
      </Button>
      <Heading description="Hexbot is AGPL-3.0 software built with these open source projects. Each project's license is in its repository.">
        Licenses
      </Heading>
      <div className="space-y-8">
        {OPEN_SOURCE.map(group => (
          <Group key={group.title} title={group.title}>
            {group.projects.map(project => (
              <a
                aria-label={`${project.name}, ${project.license}`}
                className="hex-focus flex min-h-[44px] items-center gap-3 px-4 py-2.5 first:rounded-t-2xl last:rounded-b-2xl hover:bg-foreground/[0.04]"
                href={project.repository}
                key={project.name}
                onClick={event => {
                  if (bridge) {
                    event.preventDefault()
                    void bridge.openExternal(project.repository)
                  }
                }}
                rel="noopener noreferrer"
                target="_blank"
              >
                <span className="min-w-0 flex-1 truncate text-[length:var(--text-body)]">
                  {project.name}
                </span>
                <span className="shrink-0 text-[length:var(--text-secondary)] text-muted">
                  {project.license}
                </span>
                <ExternalLink aria-hidden className="shrink-0 text-muted" size={14} />
              </a>
            ))}
          </Group>
        ))}
      </div>
    </>
  )
}
