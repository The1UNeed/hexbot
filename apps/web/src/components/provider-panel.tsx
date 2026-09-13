import { Check, Copy, ExternalLink } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import {
  providersLoginCancel,
  providersLoginPoll,
  providersLoginStart,
  providersSetKey
} from '../lib/api'
import { getBridge } from '../lib/bridge'
import type { Provider, ProviderLogin } from '../lib/types'

import { Button } from './ui/button'
import { Input } from './ui/input'

/** Subscription providers sign in through the browser; everything else takes a key. */
export function isSubscription(provider: Pick<Provider, 'auth_type'>): boolean {
  return provider.auth_type.startsWith('oauth')
}

export function supportsApiKey(provider: Pick<Provider, 'key_supported'>): boolean {
  return provider.key_supported !== false
}

function openInBrowser(url: string) {
  const bridge = getBridge()

  if (bridge) {
    void bridge.openExternal(url)
  } else {
    window.open(url, '_blank', 'noopener,noreferrer')
  }
}

/** Inline panel for one provider: browser sign-in or an API key. */
export function ProviderPanel({
  onConfigured,
  provider
}: {
  onConfigured: () => Promise<void>
  provider: Provider
}) {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [login, setLogin] = useState<ProviderLogin | null>(null)
  const [copied, setCopied] = useState(false)

  const loginId = login?.login_id
  const pending = login?.status === 'pending'
  const active = useRef<string | null>(null)
  active.current = pending && loginId ? loginId : null

  useEffect(() => {
    if (!pending || !loginId) {
      return
    }

    const timer = setInterval(() => {
      void providersLoginPoll(loginId)
        .then(next => {
          setLogin(next)

          if (next.status === 'done') {
            void onConfigured()
          }
        })
        .catch(reason => setError(String(reason)))
    }, 3_000)

    return () => clearInterval(timer)
  }, [loginId, onConfigured, pending])

  // Cancel a sign-in that is still waiting when the panel goes away, and only
  // then: a poll result must not tear down the login it just reported on.
  useEffect(
    () => () => {
      if (active.current) {
        void providersLoginCancel(active.current).catch(() => undefined)
      }
    },
    []
  )

  const signIn = async () => {
    setBusy(true)
    setError(null)

    try {
      const started = await providersLoginStart(provider.id)
      setLogin(started)

      if (started.supported === false) {
        setError(started.message)
      } else if (started.status === 'error') {
        setError(started.message)
      } else if (started.url) {
        openInBrowser(started.url)
      }
    } catch (reason) {
      setError(String(reason))
    } finally {
      setBusy(false)
    }
  }

  const connectKey = async () => {
    setBusy(true)
    setError(null)

    try {
      await providersSetKey(provider.id, key.trim())
      setKey('')
      await onConfigured()
    } catch (reason) {
      setError(String(reason))
    } finally {
      setBusy(false)
    }
  }

  const copyCode = async () => {
    if (login?.code) {
      await navigator.clipboard?.writeText(login.code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1_500)
    }
  }

  if (provider.configured) {
    return (
      <p className="flex items-center gap-2 text-secondary text-success">
        <Check size={14} /> Connected. Pick another provider or continue.
      </p>
    )
  }

  if (isSubscription(provider)) {
    return (
      <div className="space-y-3">
        {login?.status === 'pending' ? (
          <div className="space-y-3">
            <p className="text-secondary text-muted">
              Finish signing in in your browser. If it asks for a code, enter this one:
            </p>
            <div className="flex items-center gap-2">
              <code
                className="rounded-control border border-border bg-background px-3 py-2 font-mono text-[length:var(--text-title)] tracking-[.18em]"
                data-testid="login-code"
              >
                {login.code}
              </code>
              <Button
                aria-label="Copy code"
                icon={copied ? <Check size={14} /> : <Copy size={14} />}
                onClick={() => void copyCode()}
                variant="ghost"
              >
                {copied ? 'Copied' : 'Copy'}
              </Button>
              <Button
                icon={<ExternalLink size={14} />}
                onClick={() => openInBrowser(login.url)}
                variant="ghost"
              >
                Open again
              </Button>
            </div>
            <div className="flex items-center gap-3 text-secondary text-muted">
              <span className="flex gap-1">
                <span className="hex-dot size-1.5 rounded-full bg-muted" />
                <span
                  className="hex-dot size-1.5 rounded-full bg-muted"
                  style={{ animationDelay: '150ms' }}
                />
                <span
                  className="hex-dot size-1.5 rounded-full bg-muted"
                  style={{ animationDelay: '300ms' }}
                />
              </span>
              Waiting for the sign-in to finish
              <button
                className="ml-auto underline"
                onClick={() => {
                  void providersLoginCancel(login.login_id).catch(() => undefined)
                  setLogin(null)
                }}
                type="button"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <>
            <p className="text-secondary text-muted">
              Uses your existing subscription. You will sign in through your browser; no key to
              paste.
            </p>
            <Button
              busy={busy}
              data-testid="provider-sign-in"
              icon={<ExternalLink size={14} />}
              onClick={() => void signIn()}
              variant="primary"
            >
              Sign in with {provider.label}
            </Button>
          </>
        )}
        {error ? (
          <p className="text-secondary text-danger" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    )
  }

  if (!supportsApiKey(provider)) {
    return (
      <div className="space-y-2 text-secondary text-muted">
        <p>
          {provider.id === 'custom'
            ? "Set model.base_url in the daemon's config.yaml, then refresh this page."
            : 'This provider uses credentials managed outside Hexbot. Configure them on the daemon, then refresh this page.'}
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <p className="text-secondary text-muted">
        Paste an API key from your {provider.label} account. Usage is billed by them, not by Hexbot.
      </p>
      <form
        className="flex gap-2"
        onSubmit={event => {
          event.preventDefault()
          void connectKey()
        }}
      >
        <Input
          aria-label={`${provider.label} API key`}
          autoFocus
          data-testid="onboarding-provider-key-input"
          onChange={event => setKey(event.target.value)}
          placeholder="API key"
          type="password"
          value={key}
        />
        <Button busy={busy} disabled={!key.trim()} type="submit" variant="primary">
          Connect
        </Button>
      </form>
      {error ? (
        <p className="text-secondary text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}
