import { useState } from 'react'

import {
  ConnectorFields,
  connectorFieldsFor,
  connectorValues
} from '../../components/connector-fields'
import { Button } from '../../components/ui/button'
import { ConnectorIcon } from '../../components/ui/connector-icon'
import { Dialog } from '../../components/ui/dialog'
import { Switch } from '../../components/ui/switch'
import { cn } from '../../lib/cn'
import type { Bot, Connector, ConnectorTest } from '../../lib/types'
import { useConnectors } from '../../stores/connectors'

import { cardClass, errorText } from './shared'

/**
 * The set-up sheet: fields from the catalog entry, saved once for the daemon
 * (or for this bot only), tested before the sheet closes.
 */
export function ConnectorSetupSheet({
  bot,
  connector,
  onClose
}: {
  bot: Bot
  connector: Connector
  onClose: () => void
}) {
  const setup = useConnectors(state => state.setup)
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

  const forProvider = connectorFieldsFor(connector, provider)
  const failed = result && !result.ok
  const changed = forProvider.some(field => values[field.key]?.trim())
  const alreadySet = forProvider.some(field => field.set)
  const providerChanged = Boolean(provider && provider !== connector.provider)

  const submit = async () => {
    setBusy(true)
    setError(null)
    setResult(null)

    try {
      const test = await setup({
        bot: bot.name,
        bot_only: botOnly,
        enable_for_bot: enable,
        id: connector.id,
        ...(provider ? { provider } : {}),
        values: connectorValues(connector, provider, values)
      })

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
        botOnly
          ? `Stored for ${bot.display_name} only. Other bots keep the shared value.`
          : 'Stored once on this daemon. Every bot you turn it on for uses it.'
      }
      onOpenChange={open => !open && onClose()}
      open
      title={
        <span className="flex items-center gap-2">
          <ConnectorIcon icon={connector.icon} />
          {connector.state === 'error' ? 'Fix' : 'Set up'} {connector.name}
        </span>
      }
    >
      <form
        className="grid gap-4 p-5"
        onSubmit={event => {
          event.preventDefault()
          void submit()
        }}
      >
        <ConnectorFields
          connector={connector}
          invalid={Boolean(failed)}
          onProviderChange={setProvider}
          onValuesChange={setValues}
          provider={provider}
          values={values}
        />
        <div className={cn(cardClass, 'divide-y divide-border')}>
          <div className="flex items-center gap-3 px-3 py-2.5">
            <span className="min-w-0 flex-1">
              <span className="block font-medium">Turn on for {bot.display_name}</span>
              {connector.enabled_bots.filter(name => name !== bot.name).length ? (
                <span className="block text-[length:var(--text-secondary)] text-muted">
                  Also on for {connector.enabled_bots.filter(name => name !== bot.name).join(', ')}.
                </span>
              ) : null}
            </span>
            <Switch
              aria-label={`Turn on for ${bot.display_name}`}
              checked={enable}
              onCheckedChange={setEnable}
            />
          </div>
          {connector.scope === 'daemon' ? (
            <div className="flex items-center gap-3 px-3 py-2.5">
              <span className="min-w-0 flex-1">
                <span className="block font-medium">
                  Use a different value for {bot.display_name} only
                </span>
                <span className="block text-[length:var(--text-secondary)] text-muted">
                  For a second account. Other bots keep the shared one.
                </span>
              </span>
              <Switch aria-label="Bot only" checked={botOnly} onCheckedChange={setBotOnly} />
            </div>
          ) : null}
        </div>
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
        <div className="flex justify-end gap-2 pt-1">
          <Button onClick={onClose} variant="ghost">
            Cancel
          </Button>
          <Button
            busy={busy}
            disabled={!changed && !alreadySet && !providerChanged}
            type="submit"
            variant="primary"
          >
            Connect and test
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
