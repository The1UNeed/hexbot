import { Check, Eye, EyeOff, KeyRound } from 'lucide-react'
import { type FormEvent, useId, useState } from 'react'

import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { approvalRespond } from '../../lib/api'
import type { ApprovalRequest, SignInForm } from '../../lib/types'
import { transcriptActions } from '../../stores/transcripts'

/**
 * The secure sign-in card a bot shows with `hexbot_passwords`. What the user
 * types goes to the daemon with the answer, which saves it in Passwords for
 * every bot and types it into the page; the bot never sees it. Nothing typed
 * is kept in the transcript.
 */
export function SignInCard({ approval, form }: { approval: ApprovalRequest; form: SignInForm }) {
  const [username, setUsername] = useState(form.username ?? '')
  const [password, setPassword] = useState('')
  const [shown, setShown] = useState(false)
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
    <div className="hex-bubble min-w-0 max-w-[min(85%,26rem)] flex-1 rounded-[20px] border border-border bg-background px-4 py-3">
      <div className="flex items-center gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-[10px] border border-border text-muted">
          <KeyRound aria-hidden className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">Sign in to {form.title}</div>
          <div className="text-[length:var(--text-secondary)] text-muted">Secure form</div>
        </div>
        {approval.decision === 'deny' ? (
          <span className="text-[length:var(--text-secondary)] text-muted">Cancelled</span>
        ) : approval.decision ? (
          <span className="inline-flex items-center gap-1 text-[length:var(--text-secondary)] text-success">
            <Check aria-hidden className="size-3.5" />
            Submitted
          </span>
        ) : null}
      </div>
      {approval.decision ? null : (
        <form className="mt-3 grid gap-2.5" onSubmit={submit}>
          {form.update ? (
            <p className="text-[length:var(--text-secondary)] text-muted">
              The saved password for {form.site} didn't work. Enter the current one.
            </p>
          ) : null}
          <label className="grid gap-1" htmlFor={`${id}-user`}>
            <span className="text-[length:var(--text-secondary)] text-muted">
              Username or email
            </span>
            <Input
              autoCapitalize="none"
              autoComplete="username"
              autoCorrect="off"
              id={`${id}-user`}
              onChange={event => setUsername(event.target.value)}
              spellCheck={false}
              value={username}
            />
          </label>
          {/* The show button sits outside the label, which would otherwise name the field with it. */}
          <div className="grid gap-1">
            <label
              className="text-[length:var(--text-secondary)] text-muted"
              htmlFor={`${id}-password`}
            >
              Password
            </label>
            <span className="relative">
              <Input
                autoComplete="current-password"
                className="pr-10"
                id={`${id}-password`}
                onChange={event => setPassword(event.target.value)}
                type={shown ? 'text' : 'password'}
                value={password}
              />
              <button
                aria-label={shown ? 'Hide password' : 'Show password'}
                className="hex-focus absolute top-1/2 right-1.5 grid size-7 -translate-y-1/2 place-items-center rounded-[8px] text-muted hover:text-foreground"
                onClick={() => setShown(value => !value)}
                type="button"
              >
                {shown ? (
                  <EyeOff aria-hidden className="size-4" />
                ) : (
                  <Eye aria-hidden className="size-4" />
                )}
              </button>
            </span>
          </div>
          <p className="text-[length:var(--text-meta)] text-muted">
            Goes straight to {form.site} and into Passwords for your bots. The bot never sees it.
          </p>
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
              Cancel
            </Button>
          </div>
        </form>
      )}
    </div>
  )
}
