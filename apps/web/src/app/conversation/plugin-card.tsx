import { type FormEvent, useId, useState } from 'react'

import { connectorFieldMissing } from '../../components/connector-fields'
import { Button } from '../../components/ui/button'
import { ConnectorIcon } from '../../components/ui/connector-icon'
import { approvalRespond } from '../../lib/api'
import { cn } from '../../lib/cn'
import { pluginFormIcon } from '../../lib/plugin-icons'
import type { ApprovalRequest, PluginForm } from '../../lib/types'
import { transcriptActions } from '../../stores/transcripts'

import { CardField, CardStatus, ConnectCard } from './connect-card'

const VERBS: Record<PluginForm['action'], string> = {
  enable: 'Turn on',
  install: 'Install',
  setup: 'Connect'
}

const DONE: Record<PluginForm['action'], string> = {
  enable: 'On',
  install: 'Installed',
  setup: 'Saved'
}

/**
 * The card a bot shows with `hexbot_plugins` to install a plugin, turn one
 * on, or set one up. Setup folds behind Connect, like a sign-in; the keys
 * typed go to the daemon with the answer, which saves them as Settings,
 * Plugins does. The bot never sees them, and the transcript keeps none.
 */
export function PluginCard({ approval, form }: { approval: ApprovalRequest; form: PluginForm }) {
  const [open, setOpen] = useState(form.action !== 'setup')
  const [values, setValues] = useState<Record<string, string>>({})
  const [provider, setProvider] = useState(form.provider ?? form.providers?.[0]?.id ?? null)
  const [busy, setBusy] = useState<'cancel' | 'submit' | null>(null)
  const [error, setError] = useState<null | string>(null)
  const id = useId()
  const setup = form.action === 'setup'
  const fields = form.fields.filter(field => !field.provider || field.provider === provider)
  const missing = setup && fields.some(field => connectorFieldMissing(field, values))
  const about = form.providers?.find(option => option.id === provider)?.description

  const answer = async (choice: 'deny' | 'once') => {
    setBusy(choice === 'once' ? 'submit' : 'cancel')
    setError(null)

    try {
      const typed = Object.fromEntries(
        fields.flatMap(field => {
          const value = values[field.key]?.trim()

          return value ? [[field.key, value]] : []
        })
      )

      await approvalRespond(
        approval.sessionId,
        approval.requestId,
        choice,
        choice === 'once' ? { provider, values: typed } : undefined
      )
      setValues({})
      transcriptActions().resolveApproval(approval.sessionId, approval.requestId, choice)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not send it. Try again.')
    } finally {
      setBusy(null)
    }
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()

    if (!missing && !busy) {
      void answer('once')
    }
  }

  const status = approval.decision ? (
    <CardStatus done={approval.decision !== 'deny'}>
      {approval.decision === 'deny' ? 'Not now' : DONE[form.action]}
    </CardStatus>
  ) : null

  const action = open ? null : (
    <Button className="rounded-full" onClick={() => setOpen(true)} size="sm" variant="primary">
      {VERBS[form.action]}
    </Button>
  )

  // What an install runs stays on the card: the user approves exactly that.
  const run = form.action === 'install' ? (form.run ?? (form.detail ? [form.detail] : [])) : []

  return (
    <ConnectCard
      action={action}
      icon={<ConnectorIcon className="size-9 rounded-[10px]" icon={pluginFormIcon(form)} />}
      label={`${VERBS[form.action]} ${form.name}`}
      status={status}
      subtitle={form.description || null}
      title={form.name}
    >
      {approval.decision || !open ? null : (
        <form className="mt-2.5 grid gap-2" onSubmit={submit}>
          {form.other ? (
            <p className="text-[length:var(--text-secondary)] text-muted">For {form.bot}</p>
          ) : null}
          {run.length ? (
            <code className="block rounded-[8px] bg-foreground/[0.05] px-2 py-1 font-mono text-[length:var(--text-meta)] whitespace-pre-wrap [overflow-wrap:anywhere]">
              {run.join('\n')}
            </code>
          ) : null}
          {form.providers && form.providers.length > 1 ? (
            <div aria-label="Provider" className="flex flex-wrap gap-1.5" role="radiogroup">
              {form.providers.map(option => (
                <button
                  aria-checked={option.id === provider}
                  className={cn(
                    'hex-focus h-[28px] rounded-full px-3 text-[length:var(--text-secondary)]',
                    option.id === provider
                      ? 'bg-foreground text-background'
                      : 'bg-foreground/[0.07] text-foreground hover:bg-foreground/[0.11]'
                  )}
                  key={option.id}
                  onClick={() => setProvider(option.id)}
                  role="radio"
                  type="button"
                >
                  {option.label}
                </button>
              ))}
            </div>
          ) : null}
          {about ? <p className="text-[length:var(--text-secondary)] text-muted">{about}</p> : null}
          {fields.map((field, index) => (
            <CardField
              autoFocus={setup && index === 0}
              id={`${id}-${field.key}`}
              key={field.key}
              label={field.label}
              link={field.url}
              onChange={value => setValues(current => ({ ...current, [field.key]: value }))}
              placeholder={field.set ? `Saved${field.hint ? ` ${field.hint}` : ''}` : undefined}
              secret={field.secret !== false}
              value={values[field.key] ?? ''}
            />
          ))}
          {error ? (
            <p className="text-[length:var(--text-secondary)] text-danger" role="alert">
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              busy={busy === 'submit'}
              disabled={missing || busy !== null}
              size="sm"
              type="submit"
              variant="primary"
            >
              {VERBS[form.action]}
            </Button>
            <Button
              busy={busy === 'cancel'}
              disabled={busy !== null}
              onClick={() => void answer('deny')}
              size="sm"
              type="button"
            >
              Not now
            </Button>
          </div>
        </form>
      )}
    </ConnectCard>
  )
}
