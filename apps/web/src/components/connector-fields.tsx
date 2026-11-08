import { Check } from 'lucide-react'
import { useCallback, useState } from 'react'

import { cn } from '../lib/cn'
import type { Connector } from '../lib/types'

import { ProviderPanel } from './provider-panel'
import { Input } from './ui/input'
import { Select } from './ui/select'

const LABEL = 'mb-1.5 block text-[length:var(--text-secondary)] text-muted'

/** Fields that belong to one provider, or to all of them (provider null). */
export function connectorFieldsFor(connector: Connector, provider?: string) {
  return connector.fields.filter(
    field => !field.provider || !provider || field.provider === provider
  )
}

/**
 * Whether the chosen provider still waits for its subscription sign-in:
 * until it is done, there is nothing to connect or test.
 */
export function connectorSignInMissing(
  option: { configured?: boolean; sign_in?: null | string } | undefined,
  signedIn: boolean,
  renewing = false
) {
  return Boolean(option?.sign_in) && (renewing || (!option?.configured && !signedIn))
}

/** A field the user still has to fill in: not optional and not saved yet. */
export function connectorFieldMissing(
  field: { key: string; optional?: boolean; set?: boolean },
  values: Record<string, string>
) {
  return !field.optional && !field.set && !values[field.key]?.trim()
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

/** Whose sign-in page opens, for the button: shorter than the provider label. */
const SIGN_IN_NAMES: Record<string, string> = { 'xai-oauth': 'xAI' }

/**
 * A provider that works through a subscription the user signs in to, such
 * as SuperGrok for X search, instead of a key. `grant` is the model
 * provider whose sign-in it shares.
 */
export function SubscriptionSignIn({
  configured,
  grant,
  label,
  onRenewingChange,
  onSignedIn,
  renewing: renewingProp,
  size
}: {
  configured: boolean
  grant: string
  label: string
  /** The parent hides its own button while a sign-in is renewed. */
  onRenewingChange?: (renewing: boolean) => void
  onSignedIn?: () => Promise<void> | void
  renewing?: boolean
  size?: 'sm'
}) {
  // Signing in again renews a sign-in that expired or was revoked.
  const [ownRenewing, setOwnRenewing] = useState(false)
  const renewing = renewingProp ?? ownRenewing
  const setRenewing = onRenewingChange ?? setOwnRenewing

  const done = useCallback(async () => {
    setRenewing(false)
    await onSignedIn?.()
  }, [onSignedIn, setRenewing])

  if (configured && !renewing) {
    return (
      <p className="flex items-center gap-2 text-secondary text-success">
        <Check size={14} /> Signed in.
        <button
          className="text-muted underline hover:text-foreground"
          onClick={() => setRenewing(true)}
          type="button"
        >
          Sign in again
        </button>
      </p>
    )
  }

  const panel = (
    <ProviderPanel
      intro={false}
      onConfigured={done}
      provider={{
        auth_type: 'oauth_device_code',
        configured: false,
        id: grant,
        label: SIGN_IN_NAMES[grant] ?? label,
        models_source: ''
      }}
      size={size}
    />
  )

  return configured && renewing ? (
    <div className="grid justify-items-start gap-2">
      {panel}
      <button
        className="text-secondary text-muted underline hover:text-foreground"
        onClick={() => setRenewing(false)}
        type="button"
      >
        Keep the current sign-in
      </button>
    </div>
  ) : (
    panel
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
  onRenewingChange,
  onSignedIn,
  onValuesChange,
  provider,
  renewing,
  signedIn = false,
  values
}: {
  connector: Connector
  invalid?: boolean
  onProviderChange: (provider: string) => void
  /** While a sign-in is renewed, the parent hides its own button. */
  onRenewingChange?: (renewing: boolean) => void
  /** After a subscription sign-in finishes, to read the connector again. */
  onSignedIn?: () => Promise<void> | void
  onValuesChange: (values: Record<string, string>) => void
  provider?: string
  renewing?: boolean
  /** A sign-in finished here that the connector does not show yet. */
  signedIn?: boolean
  values: Record<string, string>
}) {
  const [showAdvanced, setShowAdvanced] = useState(false)
  const forProvider = connectorFieldsFor(connector, provider)
  const fields = forProvider.filter(field => showAdvanced || !field.advanced)
  const chosen = connector.providers?.find(item => item.id === provider)
  const about = chosen?.description

  return (
    <>
      {connector.providers?.length ? (
        <label className="block">
          <span className={LABEL}>Provider</span>
          <Select
            label="Provider"
            onValueChange={onProviderChange}
            options={connector.providers.map(item => ({
              label: item.configured
                ? `${item.label} · ${item.sign_in ? 'signed in' : 'connected'}`
                : item.label,
              value: item.id
            }))}
            placeholder="Choose a provider"
            value={provider}
          />
          {about ? (
            <span className="mt-1 block text-[length:var(--text-meta)] text-muted">{about}</span>
          ) : null}
        </label>
      ) : null}
      {chosen?.sign_in ? (
        <SubscriptionSignIn
          configured={chosen.configured || signedIn}
          grant={chosen.sign_in}
          key={chosen.id}
          label={chosen.label}
          onRenewingChange={onRenewingChange}
          onSignedIn={onSignedIn}
          renewing={renewing}
        />
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
