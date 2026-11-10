import { useCallback, useState } from 'react'

import { AccountSignInPanel } from '../../components/account-sign-in'
import {
  ConnectorFields,
  connectorFieldsFor,
  connectorSignInMissing,
  connectorValues
} from '../../components/connector-fields'
import { Button } from '../../components/ui/button'
import { ConnectorIcon } from '../../components/ui/connector-icon'
import { Dialog } from '../../components/ui/dialog'
import { Input } from '../../components/ui/input'
import { Switch } from '../../components/ui/switch'
import { connectorsSetForBot, connectorsSetup } from '../../lib/api'
import type { Bot, Connector, ConnectorTest } from '../../lib/types'
import { useConnectors } from '../../stores/connectors'
import { usePlugins } from '../../stores/plugins'

import { errorText, Group, Row } from './shared'

/**
 * The set-up sheet: fields from the catalog entry, saved once for the daemon
 * (or for this bot only), tested before the sheet closes. Without a bot, as
 * in Settings, Plugins, it saves for the daemon and turns nothing on. Google
 * and Microsoft are set up by signing in instead.
 */
export function ConnectorSetupSheet(props: {
  bot?: Bot
  connector: Connector
  onClose: () => void
}) {
  return props.connector.account ? <AccountSetupSheet {...props} /> : <KeySetupSheet {...props} />
}

/**
 * Google and Microsoft: one sign-in for the daemon, then the bot gets it.
 * The user's own OAuth client, for a build without Hexbot's or a Workspace
 * that allows only its own apps, folds under Advanced.
 */
function AccountSetupSheet({
  bot,
  connector,
  onClose
}: {
  bot?: Bot
  connector: Connector
  onClose: () => void
}) {
  const account = connector.account!
  const [enable, setEnable] = useState(true)
  const [advanced, setAdvanced] = useState(false)
  const [values, setValues] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<null | string>(null)

  const refresh = async () => {
    await Promise.all([usePlugins.getState().refresh(), useConnectors.getState().refreshAll()])
  }

  const signedIn = async () => {
    setError(null)

    try {
      if (bot && enable) {
        await connectorsSetForBot(connector.id, bot.name, true)
      }

      await refresh()
      onClose()
    } catch (cause) {
      setError(errorText(cause))
    }
  }

  const saveClient = async () => {
    setBusy(true)
    setError(null)

    try {
      await connectorsSetup({
        id: connector.id,
        values: connectorValues(connector, undefined, values)
      })
      setValues({})
      setSaved(true)
      await refresh()
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      description="Sign in once on this daemon. Bots you turn it on for can read your mail and draft email for you. Only you can send it."
      onOpenChange={open => !open && onClose()}
      open
      title={
        <span className="flex items-center gap-2.5">
          <ConnectorIcon icon={connector.icon} />
          {connector.state === 'error' ? 'Fix' : 'Set up'} {connector.name}
        </span>
      }
    >
      <div className="grid gap-5 px-6 pt-4 pb-6">
        {account.signed_in && account.email ? (
          <p className="text-[length:var(--text-secondary)] text-muted">
            Signed in as {account.email}.
          </p>
        ) : null}
        <AccountSignInPanel
          again={account.signed_in}
          onDone={() => void signedIn()}
          service={account.service}
        />
        {bot ? (
          <Group>
            <Row
              control={
                <Switch
                  aria-label={`Turn on for ${bot.display_name}`}
                  checked={enable}
                  onCheckedChange={setEnable}
                />
              }
              title={`Turn on for ${bot.display_name}`}
            />
          </Group>
        ) : null}
        {advanced ? (
          <form
            className="grid gap-4"
            onSubmit={event => {
              event.preventDefault()
              void saveClient()
            }}
          >
            <p className="text-[length:var(--text-secondary)] text-muted">
              Your own OAuth client replaces Hexbot&apos;s. Save it, then sign in.
            </p>
            {connector.fields.map(field => (
              <label className="block" key={field.key}>
                <span className="mb-1.5 block text-[length:var(--text-secondary)] text-muted">
                  {field.label}
                </span>
                <Input
                  aria-label={field.label}
                  autoComplete="off"
                  className="font-mono text-[length:var(--text-secondary)]"
                  onChange={event => setValues({ ...values, [field.key]: event.target.value })}
                  placeholder={
                    field.set && field.hint
                      ? `Saved ${field.hint}`
                      : field.set
                        ? 'Saved'
                        : undefined
                  }
                  type={field.secret ? 'password' : 'text'}
                  value={values[field.key] ?? ''}
                />
                {field.help ? (
                  <span className="mt-1 block text-[length:var(--text-meta)] text-muted">
                    {field.help}
                    {field.url ? (
                      <>
                        {' '}
                        <a className="underline" href={field.url} rel="noreferrer" target="_blank">
                          Make one
                        </a>
                      </>
                    ) : null}
                  </span>
                ) : null}
              </label>
            ))}
            <div className="flex items-center gap-3">
              <Button
                busy={busy}
                disabled={!Object.values(values).some(value => value.trim())}
                type="submit"
              >
                Save
              </Button>
              {saved ? (
                <span className="text-[length:var(--text-secondary)] text-success">Saved.</span>
              ) : null}
            </div>
          </form>
        ) : (
          <button
            className="justify-self-start text-[length:var(--text-secondary)] text-muted hover:text-foreground"
            onClick={() => setAdvanced(true)}
            type="button"
          >
            Use your own OAuth client
          </button>
        )}
        {error ? (
          <p className="text-[length:var(--text-secondary)] text-danger" role="alert">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end">
          <Button onClick={onClose} variant="ghost">
            {account.signed_in ? 'Done' : 'Cancel'}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

function KeySetupSheet({
  bot,
  connector,
  onClose
}: {
  bot?: Bot
  connector: Connector
  onClose: () => void
}) {
  const setup = useConnectors(state => state.setup)
  const refresh = useConnectors(state => state.refresh)
  const [values, setValues] = useState<Record<string, string>>({})

  const [provider, setProvider] = useState<string | undefined>(
    connector.provider ?? connector.providers?.[0]?.id
  )

  const [enable, setEnable] = useState(
    connector.state === 'ready' ? Boolean(connector.enabled_for_bot) : true
  )

  const [botOnly, setBotOnly] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ConnectorTest | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [signedIn, setSignedIn] = useState(false)
  const [renewing, setRenewing] = useState(false)
  const botName = bot?.name

  const onSignedIn = useCallback(() => {
    setSignedIn(true)

    if (botName) {
      void refresh(botName)
    }
  }, [botName, refresh])

  const forProvider = connectorFieldsFor(connector, provider)
  const failed = result && !result.ok
  const changed = forProvider.some(field => values[field.key]?.trim())
  const alreadySet = forProvider.some(field => field.set)
  const providerChanged = Boolean(provider && provider !== connector.provider)

  const chosen = connector.providers?.find(item => item.id === provider)
  const needsSignIn = connectorSignInMissing(chosen, signedIn, renewing)
  // A subscription has no fields to change: once signed in, it can always be tested.
  const subscription = Boolean(chosen?.sign_in)
  // A value for one bot is a second account on the provider the other bots
  // use; the daemon refuses one that would move them to another provider.
  const canKeepForBot = connector.scope === 'daemon' && !subscription && !providerChanged
  const keepForBot = botOnly && canKeepForBot

  const others = connector.enabled_bots.filter(name => name !== bot?.name)

  const submit = async () => {
    setBusy(true)
    setError(null)
    setResult(null)

    try {
      const input = {
        id: connector.id,
        ...(provider ? { provider } : {}),
        values: connectorValues(connector, provider, values)
      }

      const test = bot
        ? await setup({ ...input, bot: bot.name, bot_only: keepForBot, enable_for_bot: enable })
        : (await connectorsSetup(input)).test

      setResult(test)

      if (test.ok) {
        onClose()
      }
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      description={
        bot && keepForBot
          ? `Stored for ${bot.display_name} only. Other bots keep the shared value.`
          : 'Stored once on this daemon. Every bot you turn it on for uses it.'
      }
      onOpenChange={open => !open && onClose()}
      open
      title={
        <span className="flex items-center gap-2.5">
          <ConnectorIcon icon={connector.icon} />
          {connector.state === 'error' ? 'Fix' : 'Set up'} {connector.name}
        </span>
      }
    >
      <form
        className="grid gap-5 px-6 pt-4 pb-6"
        onSubmit={event => {
          event.preventDefault()
          void submit()
        }}
      >
        <div className="grid gap-4">
          <ConnectorFields
            connector={connector}
            invalid={Boolean(failed)}
            onProviderChange={setProvider}
            onRenewingChange={setRenewing}
            onSignedIn={onSignedIn}
            onValuesChange={setValues}
            provider={provider}
            renewing={renewing}
            signedIn={signedIn}
            values={values}
          />
        </div>
        {bot ? (
          <Group>
            <Row
              control={
                <Switch
                  aria-label={`Turn on for ${bot.display_name}`}
                  checked={enable}
                  onCheckedChange={setEnable}
                />
              }
              description={others.length ? `Also on for ${others.join(', ')}.` : undefined}
              title={`Turn on for ${bot.display_name}`}
            />
            {/* A sign-in is the daemon's; there is no value to keep for one bot. */}
            {canKeepForBot ? (
              <Row
                control={
                  <Switch aria-label="Bot only" checked={botOnly} onCheckedChange={setBotOnly} />
                }
                description="For a second account. Other bots keep the shared one."
                title={`Use a different value for ${bot.display_name} only`}
              />
            ) : null}
          </Group>
        ) : null}
        {failed ? (
          <p className="text-[length:var(--text-secondary)] text-danger" role="alert">
            {result.message}
          </p>
        ) : null}
        {error ? (
          <p className="text-[length:var(--text-secondary)] text-danger" role="alert">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose} variant="ghost">
            Cancel
          </Button>
          {/* One primary button: the sign-in first, then this. */}
          {needsSignIn ? null : (
            <Button
              busy={busy}
              disabled={!subscription && !changed && !alreadySet && !providerChanged}
              type="submit"
              variant="primary"
            >
              Connect and test
            </Button>
          )}
        </div>
      </form>
    </Dialog>
  )
}
