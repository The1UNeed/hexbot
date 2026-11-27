import { useState } from 'react'

import { connectorsSetup } from '../lib/api'
import { ACCOUNT_NAMES, accountProvider } from '../lib/plugin-rows'
import type { Connector } from '../lib/types'

import { connectorValues } from './connector-fields'
import { Button } from './ui/button'
import { Input } from './ui/input'

const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

/**
 * The user's own OAuth client in place of Hexbot's, for a build without one
 * or a Workspace that allows only its own apps. Every connector of the
 * account uses it; it is saved before signing in.
 */
export function OwnClientForm({
  connector,
  onSaved
}: {
  connector: Connector
  onSaved?: () => Promise<void> | void
}) {
  const [values, setValues] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<null | string>(null)
  const name = connector.account ? ACCOUNT_NAMES[accountProvider(connector.account)] : ''

  const save = async () => {
    setBusy(true)
    setError(null)

    try {
      await connectorsSetup({
        id: connector.id,
        values: connectorValues(connector, undefined, values)
      })
      setValues({})
      setSaved(true)
      await onSaved?.()
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="grid gap-4"
      onSubmit={event => {
        event.preventDefault()
        void save()
      }}
    >
      <p className="text-[length:var(--text-secondary)] text-muted">
        Your own OAuth client replaces Hexbot&apos;s for every {name} connector. Save it, then sign
        in.
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
              field.set && field.hint ? `Saved ${field.hint}` : field.set ? 'Saved' : undefined
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
      {error ? (
        <p className="text-[length:var(--text-secondary)] text-danger" role="alert">
          {error}
        </p>
      ) : null}
      <div className="flex items-center gap-3">
        <Button
          busy={busy}
          disabled={!Object.values(values).some(value => value.trim())}
          size="sm"
          type="submit"
        >
          Save client
        </Button>
        {saved ? (
          <span className="text-[length:var(--text-secondary)] text-success">Saved.</span>
        ) : null}
      </div>
    </form>
  )
}
