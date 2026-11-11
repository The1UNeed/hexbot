import { Check, Copy, ExternalLink } from 'lucide-react'
import { type FormEvent, useEffect, useRef, useState } from 'react'

import {
  accountsSignInCancel,
  accountsSignInFinish,
  accountsSignInPoll,
  accountsSignInStart
} from '../lib/api'
import { SIGN_IN_BUTTONS } from '../lib/brand-logos'
import type { AccountProvider, AccountSignIn } from '../lib/types'

import { openInBrowser } from './provider-panel'
import { Button } from './ui/button'
import { Input } from './ui/input'

const NAMES: Record<AccountProvider, string> = { google: 'Google', microsoft: 'Microsoft' }

const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

/**
 * Signs the daemon in to Google or Microsoft for the connector `service`,
 * and for the connectors in `also` with the same sign-in. Microsoft
 * shows a code to enter on its page. Google opens its page and comes back
 * to the daemon by itself when the browser runs on the daemon's computer;
 * a browser anywhere else ends on a page that can't load, and pasting that
 * page's address here finishes the sign-in.
 */
export function AccountSignInPanel({
  also = [],
  onDone,
  provider,
  service
}: {
  /** Other connectors of the same account to connect with this sign-in. */
  also?: string[]
  onDone: (login: AccountSignIn) => void
  provider: AccountProvider
  service: string
}) {
  const [login, setLogin] = useState<AccountSignIn | null>(null)
  const [pasted, setPasted] = useState('')
  const [busy, setBusy] = useState(false)
  // Copied, or the browser wouldn't (plain http on a LAN has no clipboard).
  const [copied, setCopied] = useState<'no' | 'yes' | null>(null)
  const [error, setError] = useState<null | string>(null)
  const name = NAMES[provider]
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
      const started = await accountsSignInStart(service, also)
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
      <BrandSignInButton busy={busy} onClick={() => void start()} provider={provider} />
      {alert}
    </div>
  )
}

/**
 * Sign in with Google, or with Microsoft: the owner's own button, as its
 * sign-in branding guidelines ask of an app, shown as the image it
 * publishes so its logo, words, colours and shape stay as they are. The
 * same button signs in again.
 */
function BrandSignInButton({
  busy,
  onClick,
  provider
}: {
  busy: boolean
  onClick: () => void
  provider: AccountProvider
}) {
  const button = SIGN_IN_BUTTONS[provider]

  return (
    <button
      aria-busy={busy}
      aria-label={`Sign in with ${NAMES[provider]}`}
      className="hex-brand-button hex-focus justify-self-start"
      disabled={busy}
      onClick={onClick}
      type="button"
    >
      {(['light', 'dark'] as const).map(scheme => (
        <img
          alt=""
          data-scheme={scheme}
          draggable={false}
          height={button.height}
          key={scheme}
          src={button[scheme]}
          width={button.width}
        />
      ))}
    </button>
  )
}
