import { KeyRound } from 'lucide-react'
import { type FormEvent, useId, useState } from 'react'

import { Button } from '../../components/ui/button'
import { approvalRespond } from '../../lib/api'
import type { ApprovalRequest, SignInForm } from '../../lib/types'
import { transcriptActions } from '../../stores/transcripts'

import { CardField, CardStatus, ConnectCard } from './connect-card'

/**
 * The secure sign-in card a bot shows with `hexbot_passwords`. The form
 * folds behind Sign in; what the user types goes to the daemon with the
 * answer, which saves it in Passwords for every bot and types it into the
 * page. The bot never sees it, and nothing typed is kept in the transcript.
 */
export function SignInCard({ approval, form }: { approval: ApprovalRequest; form: SignInForm }) {
  const [open, setOpen] = useState(false)
  const [username, setUsername] = useState(form.username ?? '')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState<'cancel' | 'submit' | null>(null)
  const [error, setError] = useState<null | string>(null)
  const id = useId()

  const answer = async (choice: 'deny' | 'once') => {
    setBusy(choice === 'once' ? 'submit' : 'cancel')
    setError(null)

    try {
      await approvalRespond(
        approval.sessionId,
        approval.requestId,
        choice,
        choice === 'once' ? { password, username } : undefined
      )
      setPassword('')
      transcriptActions().resolveApproval(approval.sessionId, approval.requestId, choice)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not send it. Try again.')
    } finally {
      setBusy(null)
    }
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()

    if (password && !busy) {
      void answer('once')
    }
  }

  return (
    <ConnectCard
      action={
        open ? null : (
          <Button className="rounded-full" onClick={() => setOpen(true)} size="sm" variant="primary">
            Sign in
          </Button>
        )
      }
      icon={
        <span className="grid size-9 shrink-0 place-items-center rounded-[10px] border border-border text-muted">
          <KeyRound aria-hidden className="size-4" />
        </span>
      }
      label={`Sign in to ${form.title}`}
      status={
        approval.decision ? (
          <CardStatus done={approval.decision !== 'deny'}>
            {approval.decision === 'deny' ? 'Not now' : 'Saved'}
          </CardStatus>
        ) : null
      }
      subtitle={form.update ? `The saved password for ${form.site} didn't work` : form.site}
      title={form.title}
    >
      {approval.decision || !open ? null : (
        <form className="mt-2.5 grid gap-2" onSubmit={submit}>
          <CardField
            autoComplete="username"
            autoFocus={!form.username}
            id={`${id}-user`}
            label="Username or email"
            onChange={setUsername}
            value={username}
          />
          <CardField
            autoComplete="current-password"
            autoFocus={Boolean(form.username)}
            id={`${id}-password`}
            label="Password"
            onChange={setPassword}
            secret
            value={password}
          />
          {error ? (
            <p className="text-[length:var(--text-secondary)] text-danger" role="alert">
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              busy={busy === 'submit'}
              disabled={!password || busy !== null}
              size="sm"
              type="submit"
              variant="primary"
            >
              Sign in
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
