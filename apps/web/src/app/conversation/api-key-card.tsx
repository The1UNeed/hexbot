import { Braces } from 'lucide-react'
import { type FormEvent, useId, useState } from 'react'

import { Button } from '../../components/ui/button'
import { approvalRespond } from '../../lib/api'
import type { ApiKeyForm, ApprovalRequest } from '../../lib/types'
import { transcriptActions } from '../../stores/transcripts'

import { CardField, CardStatus, ConnectCard } from './connect-card'

/**
 * The API key card a bot shows with `hexbot_passwords`. The key typed goes
 * to the daemon with the answer, which saves it in Passwords for every bot;
 * commands get it in `form.env`. The bot never sees it, and nothing typed is
 * kept in the transcript.
 */
export function ApiKeyCard({ approval, form }: { approval: ApprovalRequest; form: ApiKeyForm }) {
  const [open, setOpen] = useState(false)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState<'cancel' | 'submit' | null>(null)
  const [error, setError] = useState<null | string>(null)
  const id = useId()
  const link = form.url && /^https?:\/\//.test(form.url) ? form.url : null

  const answer = async (choice: 'deny' | 'once') => {
    setBusy(choice === 'once' ? 'submit' : 'cancel')
    setError(null)

    try {
      await approvalRespond(
        approval.sessionId,
        approval.requestId,
        choice,
        choice === 'once' ? { key } : undefined
      )
      setKey('')
      transcriptActions().resolveApproval(approval.sessionId, approval.requestId, choice)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not send it. Try again.')
    } finally {
      setBusy(null)
    }
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()

    if (key.trim() && !busy) {
      void answer('once')
    }
  }

  return (
    <ConnectCard
      action={
        open ? null : (
          <Button
            className="rounded-full"
            onClick={() => setOpen(true)}
            size="sm"
            variant="primary"
          >
            Add key
          </Button>
        )
      }
      icon={
        <span className="grid size-9 shrink-0 place-items-center rounded-[10px] border border-border text-muted">
          <Braces aria-hidden className="size-4" />
        </span>
      }
      label={`Add your ${form.title} API key`}
      status={
        approval.decision ? (
          <CardStatus done={approval.decision !== 'deny'}>
            {approval.decision === 'deny' ? 'Not now' : 'Saved'}
          </CardStatus>
        ) : null
      }
      subtitle={form.update ? `The saved ${form.title} key didn't work` : `API key, as ${form.env}`}
      title={form.title}
    >
      {approval.decision || !open ? null : (
        <form className="mt-2.5 grid gap-2" onSubmit={submit}>
          <CardField
            autoFocus
            id={`${id}-key`}
            label="API key"
            link={link}
            onChange={setKey}
            secret
            value={key}
          />
          <p className="text-[length:var(--text-meta)] text-muted">
            Saved in Passwords for your bots. Commands read it from {form.env}; the bot never sees
            it.
          </p>
          {error ? (
            <p className="text-[length:var(--text-secondary)] text-danger" role="alert">
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              busy={busy === 'submit'}
              disabled={!key.trim() || busy !== null}
              size="sm"
              type="submit"
              variant="primary"
            >
              Save
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
