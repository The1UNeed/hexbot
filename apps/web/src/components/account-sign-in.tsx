import { Check, Copy, ExternalLink } from 'lucide-react'
import { type FormEvent, useEffect, useRef, useState } from 'react'

import {
  accountsSignInCancel,
  accountsSignInFinish,
  accountsSignInPoll,
  accountsSignInStart
} from '../lib/api'
import { BRAND_ICONS } from '../lib/connector-icons'
import type { AccountSignIn, MailService } from '../lib/types'

import { openInBrowser } from './provider-panel'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Spinner } from './ui/spinner'

const NAMES: Record<MailService, string> = { google: 'Google', microsoft: 'Microsoft' }

const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

/**
 * Signs the daemon in to Google or Microsoft for their connector. Microsoft
 * shows a code to enter on its page. Google opens its page and comes back
 * to the daemon by itself when the browser runs on the daemon's computer;
 * a browser anywhere else ends on a page that can't load, and pasting that
 * page's address here finishes the sign-in.
 */
export function AccountSignInPanel({
  again = false,
  onDone,
  service
}: {
  again?: boolean
  onDone: (login: AccountSignIn) => void
  service: MailService
}) {
  const [login, setLogin] = useState<AccountSignIn | null>(null)
  const [pasted, setPasted] = useState('')
  const [busy, setBusy] = useState(false)
  // Copied, or the browser wouldn't (plain http on a LAN has no clipboard).
  const [copied, setCopied] = useState<'no' | 'yes' | null>(null)
  const [error, setError] = useState<null | string>(null)
  const name = NAMES[service]
  const loginId = login?.login_id
  const pending = login?.status === 'pending'
  const active = useRef<null | string>(null)
  active.current = pending && loginId ? loginId : null
  const done = useRef(onDone)
  done.current = onDone

  const settle = (next: AccountSignIn) => {
    setLogin(next)

    if (next.status === 'done') {
      done.current(next)
    } else if (next.status === 'error' || next.status === 'cancelled') {
      // Cancelled elsewhere: another sign-in replaced it, or Sign out ended it.
      setError(next.message)
    }
  }

  useEffect(() => {
    if (!pending || !loginId) {
      return
    }

    const timer = setInterval(() => {
      void accountsSignInPoll(loginId)
        // An answer for a sign-in the user stopped meanwhile is dropped.
        .then(next => active.current === loginId && settle(next))
        .catch(cause => active.current === loginId && setError(errorText(cause)))
    }, 2_000)

    return () => clearInterval(timer)
  }, [loginId, pending])

  // A sign-in still waiting when the panel goes is cancelled, and only then.
  useEffect(
    () => () => {
      if (active.current) {
        void accountsSignInCancel(active.current).catch(() => undefined)
      }
    },
    []
  )

  const start = async () => {
    setBusy(true)
    setError(null)
    setPasted('')

    try {
      const started = await accountsSignInStart(service)
      settle(started)

      // Google's page opens at once; Microsoft's waits until the code is
      // copied, so a phone doesn't switch away before the user has it.
      if (started.status === 'pending' && started.mode !== 'device') {
        openInBrowser(started.url)
      }
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setBusy(false)
    }
  }

  const finish = async (event: FormEvent) => {
    event.preventDefault()

    if (!loginId || !pasted.trim()) {
      return
    }

    setBusy(true)
    setError(null)

    try {
      settle(await accountsSignInFinish(loginId, pasted.trim()))
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setBusy(false)
    }
  }

  const copy = async () => {
    if (!login?.code) {
      return
    }

    const done = await (navigator.clipboard?.writeText(login.code) ?? Promise.reject()).then(
      () => true,
      () => false
    )

    setCopied(done ? 'yes' : 'no')

    if (done) {
      setTimeout(() => setCopied(null), 1_500)
    }
  }

  const cancel = () => {
    if (loginId) {
      void accountsSignInCancel(loginId).catch(() => undefined)
    }

    setLogin(null)
    setError(null)
  }

  const alert = error ? (
    <p className="text-[length:var(--text-secondary)] text-danger" role="alert">
      {error}
    </p>
  ) : null

  if (login?.status === 'done') {
    return (
      <p className="flex items-center gap-2 text-[length:var(--text-secondary)] text-success">
        <Check aria-hidden size={14} />
        {login.email ? `Signed in as ${login.email}.` : `Signed in to ${name}.`}
      </p>
    )
  }

  if (pending && login.mode === 'device') {
    return (
      <div className="grid gap-3 text-[length:var(--text-secondary)]">
        <p className="text-muted">Enter this code on the {name} page, then sign in there:</p>
        <div className="flex flex-wrap items-center gap-2">
          <code
            className="select-all rounded-control border border-border bg-background px-3 py-2 font-mono text-[length:var(--text-title)] tracking-[.18em]"
            data-testid="account-code"
          >
            {login.code}
          </code>
          <Button
            icon={copied === 'yes' ? <Check size={14} /> : <Copy size={14} />}
            onClick={() => void copy()}
            variant="ghost"
          >
            {copied === 'yes' ? 'Copied' : 'Copy'}
          </Button>
        </div>
        {copied === 'no' ? (
          <p className="text-muted" role="status">
            This browser can't copy here. Type the code on the {name} page.
          </p>
        ) : null}
        <Button
          className="justify-self-start"
          icon={<ExternalLink size={14} />}
          onClick={() => void copy().then(() => openInBrowser(login.url))}
          variant="primary"
        >
          Copy code and open {name}
        </Button>
        <p className="flex items-center gap-3 text-muted">
          Waiting for {name}
          <button className="ml-auto underline" onClick={cancel} type="button">
            Stop signing in
          </button>
        </p>
        {alert}
      </div>
    )
  }

  if (pending) {
    return (
      <form className="grid gap-3 text-[length:var(--text-secondary)]" onSubmit={finish}>
        <p className="text-muted">
          Finish signing in on the {name} page.{' '}
          <button className="underline" onClick={() => openInBrowser(login.url)} type="button">
            Open it again
          </button>
        </p>
        <p className="text-muted">
          Signing in on another computer or phone? {name} ends on a page that doesn't load. Copy
          that page's address and paste it here.
        </p>
        <div className="flex gap-2">
          <Input
            aria-label="The address the browser ended on"
            autoCapitalize="none"
            autoComplete="off"
            onChange={event => setPasted(event.target.value)}
            placeholder={`${login.redirect_uri ?? 'http://127.0.0.1'}?code=…`}
            spellCheck={false}
            value={pasted}
          />
          <Button busy={busy} disabled={!pasted.trim()} type="submit">
            Finish
          </Button>
        </div>
        <p className="flex items-center gap-3 text-muted">
          Waiting for {name}
          <button className="ml-auto underline" onClick={cancel} type="button">
            Stop signing in
          </button>
        </p>
        {alert}
      </form>
    )
  }

  return (
    <div className="grid gap-2">
      {service === 'google' ? (
        <GoogleSignInButton busy={busy} onClick={() => void start()} />
      ) : (
        <Button
          busy={busy}
          className="justify-self-start"
          icon={<ExternalLink size={14} />}
          onClick={() => void start()}
          variant="primary"
        >
          {again ? `Sign in to ${name} again` : `Sign in with ${name}`}
        </Button>
      )}
      {alert}
    </div>
  )
}

/**
 * Google's own button: its words, its colours and its "G", as its sign-in
 * branding guidelines require of an app Google verifies. The same words
 * sign in again.
 */
function GoogleSignInButton({ busy, onClick }: { busy: boolean; onClick: () => void }) {
  const google = BRAND_ICONS.google!

  return (
    <button
      className="hex-google-button hex-focus justify-self-start"
      disabled={busy}
      onClick={onClick}
      type="button"
    >
      {busy ? (
        <Spinner size="sm" />
      ) : (
        <svg aria-hidden height="20" viewBox={google.marksViewBox} width="20">
          {google.marks!.map(mark => (
            <path d={mark.d} fill={mark.fill} key={mark.d} />
          ))}
        </svg>
      )}
      Sign in with Google
    </button>
  )
}
