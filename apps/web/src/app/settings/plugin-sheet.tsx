import { Check, X } from 'lucide-react'
import { useMemo, useState } from 'react'

import { OwnClientForm } from '../../components/account-connect'
import { AccountSignInPanel } from '../../components/account-sign-in'
import { Avatar } from '../../components/ui/avatar'
import { Button } from '../../components/ui/button'
import { confirm } from '../../components/ui/confirm'
import { ConnectorIcon } from '../../components/ui/connector-icon'
import { Dialog } from '../../components/ui/dialog'
import { Input } from '../../components/ui/input'
import { Switch } from '../../components/ui/switch'
import {
  accountsDisconnect,
  connectorsClear,
  connectorsRemoveMcp,
  connectorsTest,
  pluginsSetBots,
  skillsSetGlobal
} from '../../lib/api'
import { botFace } from '../../lib/avatar-builder'
import { cn } from '../../lib/cn'
import {
  ACCOUNT_NAMES,
  accountProvider,
  accountSiblings,
  canGive,
  shownBots,
  withWaiting
} from '../../lib/plugin-rows'
import type { AccountSignIn, Bot, Plugin, PluginValue } from '../../lib/types'
import { usePlugins } from '../../stores/plugins'
import { ConnectorSetupSheet } from '../bot-settings/connector-setup'
import { cardClass, dividerClass, errorText } from '../bot-settings/shared'

const keyOf = (plugin: Plugin) => `${plugin.kind}:${plugin.id}`

const label = 'mb-2 text-[length:var(--text-meta)] font-medium text-muted'

/**
 * One plugin, opened from its card or row: what bots can do with it, how it
 * is connected, and the bots that have it. A Google or Microsoft connector
 * is connected here, alone or with others of its account in one sign-in.
 */
export function PluginSheet({
  bots,
  focus,
  onClose,
  plugin
}: {
  bots: Bot[]
  /** The bot the page is showing plugins for, given a new connector first. */
  focus: Bot | null
  onClose: () => void
  plugin: Plugin
}) {
  const refresh = usePlugins(state => state.refresh)
  const remove = usePlugins(state => state.remove)
  const setBots = usePlugins(state => state.setBots)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<null | { ok: boolean; text: string }>(null)
  const [setup, setSetup] = useState(false)
  const connector = plugin.connector
  const account = plugin.kind === 'connector' ? (connector?.account ?? null) : null
  // Signed in with a sign-in that still works. One that stopped working is
  // signed in but not ready; a failed test alone leaves it connected.
  const connected = Boolean(account?.signed_in && plugin.ready)

  const run = (action: () => Promise<unknown>) => {
    setBusy(true)
    setMessage(null)
    void action()
      .catch(cause => setMessage({ ok: false, text: errorText(cause) }))
      .finally(() => setBusy(false))
  }

  const test = () =>
    run(async () => {
      const result = await connectorsTest(connector!.id)

      setMessage({ ok: result.ok, text: result.message })
      await refresh()
    })

  const choose = (next: string[], keepWaiting = true) => {
    setMessage(null)
    void setBots(plugin, next, keepWaiting).catch(cause =>
      setMessage({ ok: false, text: errorText(cause) })
    )
  }

  // A server added on its own; a package goes with its server and skills.
  const looseServer = plugin.kind === 'connector' && Boolean(plugin.server)
  const removable = plugin.kind === 'package' || looseServer
  const keyed = plugin.kind === 'connector' && !account && Boolean(connector?.fields.length)
  const hasKeys = Boolean(connector?.fields.some(field => field.set))
  const givable = (bot: string) => canGive(plugin, bot)

  const shown = shownBots(plugin)

  const showBots = bots.length > 0 && (bots.some(bot => givable(bot.name)) || shown.bots.length > 0)

  return (
    <>
      <Dialog
        description={plugin.description || undefined}
        onOpenChange={open => !open && onClose()}
        open
        title={
          <span className="flex items-center gap-3">
            <ConnectorIcon className="size-9" icon={plugin.icon} />
            <span className="min-w-0">
              <span className="block truncate">{plugin.name}</span>
              <StateLine plugin={plugin} />
            </span>
          </span>
        }
      >
        <div
          className="grid gap-6 px-6 pt-4 pb-6 text-[length:var(--text-secondary)]"
          data-testid={`sheet-${keyOf(plugin)}`}
        >
          {connector?.abilities?.length ? (
            <section>
              <p className={label}>What bots can do</p>
              <ul className="grid gap-1.5">
                {connector.abilities.map(ability => (
                  <li className="flex items-start gap-2" key={ability}>
                    <Check aria-hidden className="mt-0.5 shrink-0 text-success" size={14} />
                    {ability}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {account && !connected ? (
            <AccountConnect
              bots={bots}
              focus={focus}
              onError={text => setMessage({ ok: false, text })}
              onNote={text => setMessage({ ok: true, text })}
              plugin={plugin}
            />
          ) : null}

          {/* Disconnecting needs no working sign-in: a broken one can go too. */}
          {account?.signed_in ? (
            <section>
              <p className={label}>Account</p>
              <div className={cn(cardClass, 'flex min-h-[52px] items-center gap-3 px-4 py-2.5')}>
                <span className="min-w-0 flex-1 truncate">
                  {account.email
                    ? `Signed in as ${account.email}`
                    : `Signed in to ${ACCOUNT_NAMES[accountProvider(account)]}`}
                </span>
                <Button
                  onClick={() =>
                    void confirm({
                      detail: `Bots lose ${plugin.name} until you connect it again. Your other connectors stay connected.`,
                      title: `Disconnect ${plugin.name}?`
                    }).then(yes =>
                      yes ? run(() => accountsDisconnect(account.service).then(refresh)) : undefined
                    )
                  }
                  size="sm"
                  variant="ghost"
                >
                  Disconnect
                </Button>
              </div>
            </section>
          ) : null}

          {keyed && connector ? (
            <section>
              <p className={label}>Set-up</p>
              <div className={cn(cardClass, 'grid gap-2 px-4 py-3')}>
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
                  {connector.fields
                    .filter(field => !field.provider || field.provider === connector.provider)
                    .map(field => (
                      <div className="contents" key={field.key}>
                        <dt className="text-muted">{field.label}</dt>
                        <dd>
                          {field.set ? (field.hint ? `Saved ${field.hint}` : 'Saved') : 'Not set'}
                        </dd>
                      </div>
                    ))}
                </dl>
                <div className="flex flex-wrap gap-2 pt-1">
                  <Button
                    onClick={() => setSetup(true)}
                    size="sm"
                    variant={plugin.state === 'ready' ? 'secondary' : 'primary'}
                  >
                    {plugin.state === 'not_set_up' ? 'Set up' : 'Edit'}
                  </Button>
                  {plugin.state !== 'not_set_up' && hasKeys ? (
                    <Button
                      onClick={() =>
                        void confirm({ title: `Remove the keys for ${plugin.name}?` }).then(yes =>
                          yes ? run(() => connectorsClear(plugin.id).then(refresh)) : undefined
                        )
                      }
                      size="sm"
                      variant="ghost"
                    >
                      Remove keys
                    </Button>
                  ) : null}
                </div>
              </div>
            </section>
          ) : null}

          {plugin.server ? (
            <section className="grid gap-3">
              <p className={cn(label, 'mb-0')}>Server</p>
              <p className="font-mono break-all text-muted">
                {plugin.server.url ??
                  [plugin.server.command, ...(plugin.server.args ?? [])].join(' ')}
              </p>
              <ServerValues plugin={plugin} />
            </section>
          ) : null}

          {plugin.skills?.length ? (
            <section>
              <p className={label}>Skills</p>
              <ul className="grid gap-1">
                {plugin.skills.map(skill => (
                  <li key={skill.name}>
                    <span className="font-medium">{skill.name}</span>
                    {skill.description ? (
                      <span className="text-muted"> · {skill.description}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {showBots && (!account || account.signed_in) ? (
            <BotSwitches
              bots={bots}
              canGive={givable}
              chosen={shown.bots}
              name={plugin.name}
              onChange={(next, keepWaiting) => choose(next, shown.exact ? false : keepWaiting)}
            />
          ) : null}
          {!plugin.ready && !account && plugin.kind !== 'skill' ? (
            <p className="text-muted">Set up {plugin.name} before giving it to a bot.</p>
          ) : null}

          {plugin.installed_by ? (
            <p className="text-muted">
              Asked for by{' '}
              {bots.find(bot => bot.name === plugin.installed_by)?.display_name ??
                plugin.installed_by}
              .
            </p>
          ) : null}
          {plugin.kind === 'skill' ? (
            <p className="text-muted">
              {plugin.disabled_globally
                ? 'Off for every bot in Settings, whatever its switch here says.'
                : plugin.source === 'bundled'
                  ? 'Comes with Hexbot.'
                  : 'In your skill library.'}
            </p>
          ) : null}

          {message ? (
            <p
              className={message.ok ? 'text-success' : 'text-danger'}
              role={message.ok ? 'status' : 'alert'}
            >
              {message.text}
            </p>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            {plugin.kind === 'skill' && plugin.disabled_globally ? (
              <Button
                busy={busy}
                onClick={() => run(() => skillsSetGlobal(plugin.id, true).then(refresh))}
                size="sm"
                variant="primary"
              >
                Undo Off for every bot
              </Button>
            ) : null}
            {connector && (plugin.kind !== 'connector' || plugin.state !== 'not_set_up') ? (
              <Button busy={busy} onClick={test} size="sm">
                Test
              </Button>
            ) : null}
            {account && hasKeys ? (
              <Button
                onClick={() =>
                  void confirm({
                    detail: `Every ${ACCOUNT_NAMES[accountProvider(account)]} connector goes back to Hexbot's own client. Connectors you signed in to with yours need signing in again.`,
                    title: 'Remove your own OAuth client?'
                  }).then(yes =>
                    yes ? run(() => connectorsClear(plugin.id).then(refresh)) : undefined
                  )
                }
                size="sm"
                variant="ghost"
              >
                Remove your client
              </Button>
            ) : null}
            {removable ? (
              <Button
                onClick={() =>
                  void confirm({ title: `Remove ${plugin.name} for every bot?` }).then(yes =>
                    yes
                      ? run(async () => {
                          await (looseServer
                            ? connectorsRemoveMcp(plugin.name).then(refresh)
                            : remove(plugin))
                          onClose()
                        })
                      : undefined
                  )
                }
                size="sm"
                variant="ghost"
              >
                Remove
              </Button>
            ) : null}
            <Button className="ml-auto" onClick={onClose} size="sm" variant="ghost">
              Done
            </Button>
          </div>
        </div>
      </Dialog>
      {setup && connector ? (
        <ConnectorSetupSheet
          connector={connector}
          onClose={() => {
            setSetup(false)
            void refresh()
          }}
        />
      ) : null}
    </>
  )
}

/** The words under a plugin's name: its account, its state, or what is wrong. */
function StateLine({ plugin }: { plugin: Plugin }) {
  return (
    <span
      className={cn(
        'block truncate text-[length:var(--text-meta)] font-normal',
        plugin.state === 'error' ? 'text-danger' : 'text-muted'
      )}
    >
      {plugin.state_text}
    </span>
  )
}

/**
 * Connects a Google or Microsoft connector: the bots that get it, the
 * account's other connectors to connect with the same sign-in, then the
 * sign-in. A connector whose sign-in stopped working is signed in again and
 * keeps the bots it had.
 */
function AccountConnect({
  bots,
  focus,
  onError,
  onNote,
  plugin
}: {
  bots: Bot[]
  focus: Bot | null
  onError: (text: string) => void
  /** Something to tell the user that outlasts this form, which goes once connected. */
  onNote: (text: string) => void
  plugin: Plugin
}) {
  const plugins = usePlugins(state => state.plugins)
  const refresh = usePlugins(state => state.refresh)
  const connector = plugin.connector!
  const account = connector.account!
  const provider = accountProvider(account)
  const again = account.signed_in

  // The bot in view, or the primary bot, which the list starts with.
  const [give, setGive] = useState<string[]>(() => {
    const first = focus ?? bots[0]

    return first ? [first.name] : []
  })

  const [also, setAlso] = useState<string[]>([])
  const [advanced, setAdvanced] = useState(false)

  // The account's other connectors that still wait for a sign-in.
  const siblings = useMemo(() => accountSiblings(plugin, plugins), [plugin, plugins])

  const done = async (login: AccountSignIn) => {
    // An older daemon connects the one connector and does not say so.
    const ids = login.connected ?? [plugin.id]

    try {
      if (!again && give.length) {
        const current = usePlugins.getState().plugins

        for (const id of ids) {
          const item = current.find(row => row.kind === 'connector' && row.id === id)

          await pluginsSetBots(
            'connector',
            id,
            item ? withWaiting(item, [...new Set([...item.bots, ...give])]) : give
          )
        }
      }

      // Which connectors the provider left out, and what to do about it.
      if (login.skipped?.length) {
        onNote(login.message)
      }

      await refresh()
    } catch (cause) {
      onError(errorText(cause))
      await refresh()
    }
  }

  return (
    <section className="grid gap-5">
      {again ? (
        <p className="text-muted">
          {account.email ? `The sign-in for ${account.email}` : 'The sign-in'} stopped working. Sign
          in again; the bots that had {plugin.name} keep it.
        </p>
      ) : null}
      {!again && bots.length > 1 ? (
        <div>
          <p className={label}>Bots that get it</p>
          <div
            aria-label={`Bots that get ${plugin.name}`}
            className="flex flex-wrap gap-1.5"
            role="group"
          >
            {bots.map(bot => {
              const on = give.includes(bot.name)

              return (
                <button
                  aria-pressed={on}
                  className={cn(
                    'flex h-[32px] items-center gap-1.5 rounded-full pr-3 pl-1.5 whitespace-nowrap transition-colors',
                    on
                      ? 'bg-foreground text-background'
                      : 'bg-foreground/[0.07] text-foreground hover:bg-foreground/[0.11]'
                  )}
                  key={bot.name}
                  onClick={() =>
                    setGive(on ? give.filter(name => name !== bot.name) : [...give, bot.name])
                  }
                  type="button"
                >
                  <span aria-hidden className="inline-flex">
                    <Avatar {...botFace(bot)} name={bot.display_name} size="sm" />
                  </span>
                  {bot.display_name}
                </button>
              )
            })}
          </div>
        </div>
      ) : null}
      {!again && siblings.length ? (
        <div>
          <p className={label}>Connect with the same sign-in</p>
          <div className={cn(cardClass, dividerClass)}>
            {siblings.map(item => (
              <label
                className="flex min-h-[44px] cursor-pointer items-center gap-3 px-4 py-2"
                key={item.id}
              >
                <ConnectorIcon className="size-6" icon={item.icon} />
                <span className="min-w-0 flex-1 truncate">{item.name}</span>
                <input
                  aria-label={`Also connect ${item.name}`}
                  checked={also.includes(item.id)}
                  className="size-4 accent-[var(--hex-text)]"
                  onChange={event =>
                    setAlso(
                      event.target.checked ? [...also, item.id] : also.filter(id => id !== item.id)
                    )
                  }
                  type="checkbox"
                />
              </label>
            ))}
          </div>
          <p className="mt-2 px-1 text-[length:var(--text-meta)] text-muted">
            {ACCOUNT_NAMES[provider]} asks you to allow each one. Each goes to the same bots as{' '}
            {plugin.name}.
          </p>
        </div>
      ) : null}
      <AccountSignInPanel
        also={also}
        onDone={login => void done(login)}
        provider={provider}
        service={account.service}
      />
      {advanced ? (
        <OwnClientForm connector={connector} onSaved={refresh} />
      ) : (
        <button
          className="justify-self-start text-muted underline-offset-2 hover:text-foreground hover:underline"
          onClick={() => setAdvanced(true)}
          type="button"
        >
          Use your own OAuth client
        </button>
      )}
    </section>
  )
}

/** One row per bot with a switch. A bot it can't be given to can only be turned off. */
function BotSwitches({
  bots,
  canGive,
  chosen,
  name,
  onChange
}: {
  bots: Bot[]
  canGive: (bot: string) => boolean
  chosen: string[]
  name: string
  onChange: (bots: string[], keepWaiting?: boolean) => void
}) {
  const all = bots.every(bot => chosen.includes(bot.name))
  const turnOn = !all && bots.every(bot => canGive(bot.name))
  // Turning off is offered only once it is on for a bot.
  const bulk = bots.length > 1 && (turnOn || chosen.length > 0)

  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-3">
        <p className={cn(label, 'mb-0')}>Bots</p>
        {bulk ? (
          <button
            className="text-[length:var(--text-meta)] text-muted underline-offset-2 hover:text-foreground hover:underline"
            // Off for every bot means every grant, those waiting for setup too.
            onClick={() => (turnOn ? onChange(bots.map(bot => bot.name)) : onChange([], false))}
            type="button"
          >
            {turnOn ? 'Turn on for every bot' : 'Turn off for every bot'}
          </button>
        ) : null}
      </div>
      <div
        aria-label={`Bots that use ${name}`}
        className={cn(cardClass, dividerClass)}
        role="group"
      >
        {bots.map(bot => {
          const on = chosen.includes(bot.name)

          return (
            <div className="flex min-h-[48px] items-center gap-3 px-4 py-2" key={bot.name}>
              <span aria-hidden className="inline-flex">
                <Avatar {...botFace(bot)} name={bot.display_name} size="sm" />
              </span>
              <span className="min-w-0 flex-1 truncate text-[length:var(--text-body)]">
                {bot.display_name}
              </span>
              <Switch
                aria-label={`${name} for ${bot.display_name}`}
                checked={on}
                disabled={!on && !canGive(bot.name)}
                onCheckedChange={next =>
                  onChange(next ? [...chosen, bot.name] : chosen.filter(item => item !== bot.name))
                }
              />
            </div>
          )
        })}
      </div>
    </section>
  )
}

/** An MCP server's environment (a command) or headers (a URL), set one name at a time. */
function ServerValues({ plugin }: { plugin: Plugin }) {
  const configure = usePlugins(state => state.configure)
  const server = plugin.server!
  const kind = server.transport === 'http' ? 'headers' : 'env'
  const values: PluginValue[] = server[kind]
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [newKey, setNewKey] = useState('')
  const [newValue, setNewValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<null | string>(null)

  const save = (change: Record<string, null | string>) => {
    setBusy(true)
    setError(null)
    void configure(plugin, { [kind]: change })
      .then(() => {
        setDrafts({})
        setNewKey('')
        setNewValue('')
      })
      .catch(cause => setError(errorText(cause)))
      .finally(() => setBusy(false))
  }

  const changed = Object.fromEntries(Object.entries(drafts).filter(([, value]) => value.trim()))
  const heading = kind === 'headers' ? 'Headers' : 'Environment'

  return (
    <form
      className="grid gap-2"
      onSubmit={event => {
        event.preventDefault()
        const change: Record<string, string> = { ...changed }

        if (newKey.trim()) {
          change[newKey.trim()] = newValue
        }

        save(change)
      }}
    >
      <span className="text-muted">{heading}</span>
      {values.map(value => (
        <div className="flex items-center gap-2" key={value.key}>
          <span className="w-40 shrink-0 truncate font-mono" title={value.key}>
            {value.key}
          </span>
          <Input
            aria-label={`${value.key} for ${plugin.name}`}
            autoComplete="off"
            className="min-w-0 flex-1"
            onChange={event => setDrafts({ ...drafts, [value.key]: event.target.value })}
            placeholder={value.set ? (value.hint ? `Saved ${value.hint}` : 'Saved') : 'Not set'}
            type="password"
            value={drafts[value.key] ?? ''}
          />
          <button
            aria-label={`Remove ${value.key}`}
            className="grid size-8 shrink-0 place-items-center rounded-full text-muted hover:bg-foreground/[0.07] hover:text-foreground"
            onClick={() => save({ [value.key]: null })}
            type="button"
          >
            <X size={14} />
          </button>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <Input
          aria-label={`New ${kind === 'headers' ? 'header' : 'environment'} name`}
          autoComplete="off"
          className="w-40 shrink-0 font-mono"
          onChange={event => setNewKey(event.target.value)}
          placeholder={kind === 'headers' ? 'Authorization' : 'API_TOKEN'}
          value={newKey}
        />
        <Input
          aria-label="New value"
          autoComplete="off"
          className="min-w-0 flex-1"
          onChange={event => setNewValue(event.target.value)}
          placeholder="Value"
          type="password"
          value={newValue}
        />
        <span className="size-8 shrink-0" />
      </div>
      {error ? (
        <p className="text-danger" role="alert">
          {error}
        </p>
      ) : null}
      <div>
        <Button
          busy={busy}
          disabled={!Object.keys(changed).length && !newKey.trim()}
          size="sm"
          type="submit"
        >
          Save values
        </Button>
      </div>
    </form>
  )
}
