import { useState } from 'react'

import { Button } from '../../components/ui/button'
import { ConnectorIcon } from '../../components/ui/connector-icon'
import { Dialog } from '../../components/ui/dialog'
import { Input } from '../../components/ui/input'
import { Select } from '../../components/ui/select'
import { Switch } from '../../components/ui/switch'
import { cn } from '../../lib/cn'
import type { Bot, Connector, ConnectorTest } from '../../lib/types'
import { useConnectors } from '../../stores/connectors'

import { cardClass, errorText, fieldLabel } from './shared'

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
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ConnectorTest | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Fields belong to one provider or to all of them (provider null).
  const forProvider = connector.fields.filter(
    field => !field.provider || !provider || field.provider === provider
  )

  const fields = forProvider.filter(field => showAdvanced || !field.advanced)
  const hasAdvanced = forProvider.some(field => field.advanced)
  const failed = result && !result.ok
  const visibleKeys = new Set(forProvider.map(field => field.key))
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
        values: Object.fromEntries(
          Object.entries(values)
            .filter(([key]) => visibleKeys.has(key))
            .map(([key, value]) => [key, value.trim()])
            .filter(([, value]) => value)
        )
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
        {connector.providers?.length ? (
          <label className="block">
            <span className={fieldLabel}>Provider</span>
            <Select
              label="Provider"
              onValueChange={setProvider}
              options={connector.providers.map(item => ({
                label: item.configured ? `${item.label} · connected` : item.label,
                value: item.id
              }))}
              placeholder="Choose a provider"
              value={provider}
            />
          </label>
        ) : null}
        {fields.map(field => (
          <label className="block" key={field.key}>
            <span className={fieldLabel}>{field.label}</span>
            <Input
              aria-label={field.label}
              autoComplete="off"
              className={cn(field.secret && 'font-mono text-[length:var(--text-secondary)]')}
              invalid={Boolean(failed)}
              onChange={event =>
                setValues(current => ({ ...current, [field.key]: event.target.value }))
              }
              placeholder={field.set && field.hint ? `Saved ${field.hint}` : undefined}
              type={field.secret ? 'password' : 'text'}
              value={values[field.key] ?? ''}
            />
            {failed && connector.last_error ? (
              <span className="mt-1 block text-[length:var(--text-meta)] text-danger">
                {connector.last_error.text}
              </span>
            ) : null}
            {field.help ? (
              <span className="mt-1 block text-[length:var(--text-meta)] text-muted">
                {field.help}
                {field.url ? (
                  <>
                    {' '}
                    <a className="underline" href={field.url} rel="noreferrer" target="_blank">
                      Where to get it
                    </a>
                  </>
                ) : null}
              </span>
            ) : null}
          </label>
        ))}
        {hasAdvanced ? (
          <button
            className="justify-self-start text-[length:var(--text-secondary)] text-muted hover:text-foreground"
            onClick={() => setShowAdvanced(value => !value)}
            type="button"
          >
            {showAdvanced ? 'Hide advanced' : 'Show advanced'}
          </button>
        ) : null}
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
