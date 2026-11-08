import { useCallback, useState } from 'react'

import {
  ConnectorFields,
  connectorFieldsFor,
  connectorSignInMissing,
  connectorValues
} from '../../components/connector-fields'
import { Button } from '../../components/ui/button'
import { ConnectorIcon } from '../../components/ui/connector-icon'
import { Dialog } from '../../components/ui/dialog'
import { Switch } from '../../components/ui/switch'
import { connectorsSetup } from '../../lib/api'
import type { Bot, Connector, ConnectorTest } from '../../lib/types'
import { useConnectors } from '../../stores/connectors'

import { errorText, Group, Row } from './shared'

/**
 * The set-up sheet: fields from the catalog entry, saved once for the daemon
 * (or for this bot only), tested before the sheet closes. Without a bot, as
 * in Settings, Plugins, it saves for the daemon and turns nothing on.
 */
export function ConnectorSetupSheet({
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
        ? await setup({ ...input, bot: bot.name, bot_only: botOnly && !subscription, enable_for_bot: enable })
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
        bot && botOnly && !subscription
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
            {connector.scope === 'daemon' && !subscription ? (
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
