import { useState } from 'react'

import { cn } from '../lib/cn'
import type { Connector } from '../lib/types'

import { Input } from './ui/input'
import { Select } from './ui/select'

const LABEL = 'mb-1.5 block text-[length:var(--text-secondary)] text-muted'

/** Fields that belong to one provider, or to all of them (provider null). */
export function connectorFieldsFor(connector: Connector, provider?: string) {
  return connector.fields.filter(
    field => !field.provider || !provider || field.provider === provider
  )
}

/** The values worth sending: trimmed, non-empty, and for the chosen provider. */
export function connectorValues(
  connector: Connector,
  provider: string | undefined,
  values: Record<string, string>
) {
  const visible = new Set(connectorFieldsFor(connector, provider).map(field => field.key))

  return Object.fromEntries(
    Object.entries(values)
      .filter(([key]) => visible.has(key))
      .map(([key, value]) => [key, value.trim()])
      .filter(([, value]) => value)
  )
}

/**
 * A connector's provider choice and credential fields, straight from the
 * catalog entry. Used by the bot settings sheet and by onboarding.
 */
export function ConnectorFields({
  connector,
  invalid = false,
  onProviderChange,
  onValuesChange,
  provider,
  values
}: {
  connector: Connector
  invalid?: boolean
  onProviderChange: (provider: string) => void
  onValuesChange: (values: Record<string, string>) => void
  provider?: string
  values: Record<string, string>
}) {
  const [showAdvanced, setShowAdvanced] = useState(false)
  const forProvider = connectorFieldsFor(connector, provider)
  const fields = forProvider.filter(field => showAdvanced || !field.advanced)

  return (
    <>
      {connector.providers?.length ? (
        <label className="block">
          <span className={LABEL}>Provider</span>
          <Select
            label="Provider"
            onValueChange={onProviderChange}
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
          <span className={LABEL}>{field.label}</span>
          <Input
            aria-label={field.label}
            autoComplete="off"
            className={cn(field.secret && 'font-mono text-[length:var(--text-secondary)]')}
            invalid={invalid}
            onChange={event => onValuesChange({ ...values, [field.key]: event.target.value })}
            placeholder={field.set && field.hint ? `Saved ${field.hint}` : undefined}
            type={field.secret ? 'password' : 'text'}
            value={values[field.key] ?? ''}
          />
          {invalid && connector.last_error ? (
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
      {forProvider.some(field => field.advanced) ? (
        <button
          className="justify-self-start text-[length:var(--text-secondary)] text-muted hover:text-foreground"
          onClick={() => setShowAdvanced(value => !value)}
          type="button"
        >
          {showAdvanced ? 'Hide advanced' : 'Show advanced'}
        </button>
      ) : null}
    </>
  )
}
