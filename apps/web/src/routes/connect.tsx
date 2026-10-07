import { readDeviceProofError } from '@hermes/shared'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'

import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Spinner } from '../components/ui/spinner'
import { Wordmark } from '../components/ui/wordmark'
import { defaultDeviceName, getBridge } from '../lib/bridge'
import { ConnectRequestError, fetchConnect } from '../lib/connect-grant'
import {
  type AppSignIn,
  authorizeUrl,
  collectAppSignIn,
  startAppSignIn
} from '../lib/connect-signin'
import { grantTarget } from '../lib/connect-url'
import {
  connectTo,
  pairingErrorMessage,
  pairWithDaemon,
  probeDaemon,
  targetOrigin,
  unwrapPairingReply,
  verifyBrowserCookie
} from '../lib/connection'
import { verifyDaemonIdentity } from '../lib/daemon-identity'
import { deviceKey, deviceProof } from '../lib/dpop'
import { formatAddress, parseAddress, parsePairLink } from '../lib/pair-link'
import { useConnection } from '../stores/connection'

export const Route = createFileRoute('/connect')({ component: ConnectPage })

export function parseConnectCallback(input: string): { session: string; state: string } | null {
  if (!input.startsWith('hexbot://connect')) {return null}
  const [beforeHash, hash = ''] = input.split('#')
  const url = new URL(beforeHash ?? input)
  const state = url.searchParams.get('state')
  const session = new URLSearchParams(hash).get('session')

  return state && session ? { session, state } : null
}

function ConnectPage() {
  const navigate = useNavigate()
  const savedTarget = useConnection(state => state.target)
  const proofError = useConnection(state => state.proofError)

  const [address, setAddress] = useState(() =>
    savedTarget?.kind === 'remote' ? formatAddress(savedTarget) : '127.0.0.1:9119'
  )

  const [code, setCode] = useState('')
  const [deviceName, setDeviceName] = useState(defaultDeviceName)
  const [daemonName, setDaemonName] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [signIn, setSignIn] = useState<AppSignIn | null>(null)

  const [daemons, setDaemons] = useState<
    Array<{
      id: string
      name?: string
      daemon_name?: string
      tunnel_hostname: string
      identity_key?: string | null
      online?: boolean
      /** `unreachable` is a daemon that heartbeats but whose address does not answer. */
      status?: 'offline' | 'online' | 'unreachable'
    }>
  >([])

  const [clientSession, setClientSession] = useState<string | null>(() =>
    localStorage.getItem('hexbot.connect.session')
  )

  const finishSignIn = (session: string) => {
    localStorage.setItem('hexbot.connect.session', session)
    setClientSession(session)
    setSignIn(null)
  }

  // A signed-out or revoked app session sends the user back to the sign-in button.
  const connectFailure = (reason: unknown) => {
    if (reason instanceof ConnectRequestError && reason.status === 401) {
      localStorage.removeItem('hexbot.connect.session')
      setClientSession(null)
      setDaemons([])

      return setError('Your Hex Connect sign-in ended. Sign in again.')
    }

    setError(
      reason instanceof ConnectRequestError
        ? 'Hex Connect could not be reached.'
        : pairingErrorMessage(reason)
    )
  }

  // Connect hands the session to whoever holds the verifier, so this works
  // even when the hexbot:// link opens another Hexbot app.
  useEffect(() => {
    if (!signIn) {return}
    let stopped = false

    const timer = window.setInterval(() => {
      if (Date.now() > signIn.deadline) {
        setSignIn(null)

        return setError('The Hex Connect sign-in expired. Try again.')
      }

      void collectAppSignIn(signIn).then(session => {
        if (session && !stopped) {finishSignIn(session)}
      })
    }, 2000)

    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [signIn])
  // Connect deployments from before polling return the session in a hexbot:// link.
  useEffect(() => {
    const bridge = getBridge()

    if (!bridge?.onNavigate || !signIn) {return}

    return bridge.onNavigate(url => {
      const parsed = parseConnectCallback(url)

      if (parsed?.state === signIn.state) {finishSignIn(parsed.session)}
    })
  }, [signIn])
  useEffect(() => {
    if (!clientSession) {return}
    void fetchConnect('/api/daemons', clientSession)
      .then(result =>
        setDaemons((result as { daemons?: typeof daemons }).daemons ?? (result as typeof daemons))
      )
      .catch(connectFailure)
  }, [clientSession])

  const openSignIn = (pending: AppSignIn) => {
    const url = authorizeUrl(pending, deviceName)
    const bridge = getBridge()

    if (bridge) {void bridge.openExternal(url)}
    else {window.open(url, '_blank', 'noopener')}
  }

  const startConnectLogin = async () => {
    setError(null)
    const pending = await startAppSignIn()
    setSignIn(pending)
    openSignIn(pending)
  }

  const pickDaemon = async (daemon: (typeof daemons)[number]) => {
    if (!clientSession) {return}
    setBusy(true)

    try {
      const key = await deviceKey()

      const granted = (await fetchConnect(
        `/api/daemons/${encodeURIComponent(daemon.id)}/grant`,
        clientSession,
        { device_name: deviceName, ...(key ? { jkt: key.jkt } : {}) }
      )) as { grant: string; daemon?: { host?: string; port?: number; tls?: boolean } }

      const { host, port, tls } = grantTarget(granted, daemon.tunnel_hostname)
      const origin = targetOrigin({ deviceToken: '', host, kind: 'remote', port, tls })
      await verifyDaemonIdentity(origin, daemon)
      const bridge = getBridge()

      const proof = key
        ? await deviceProof(key, 'POST', `${origin}/auth/password-login`, `cg_${granted.grant}`)
        : undefined

      if (bridge?.pairWithGrant) {
        const result = unwrapPairingReply(await bridge.pairWithGrant({
          deviceName,
          grant: granted.grant,
          proof,
          host: origin.replace(/^https?:\/\//, ''),
          tls
        }))

        await connectTo({ deviceToken: result.device_token, host, kind: 'remote', port, tls })
      } else {
        const response = await fetch(`${origin}/auth/password-login`, {
          body: JSON.stringify({
            password: `cg_${granted.grant}`,
            provider: 'hexbot',
            username: deviceName
          }),
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', ...(proof ? { DPoP: proof } : {}) },
          method: 'POST'
        })

        const failure = await readDeviceProofError(response)

        if (failure) {throw failure}

        if (!response.ok) {throw new Error('Connect login failed')}
        const login = await response.json() as { device_token?: string }

        if (!login.device_token) {
          await verifyBrowserCookie(origin, daemon.name ?? daemon.daemon_name ?? host)
        }

        await connectTo({ deviceToken: login.device_token ?? '', host, kind: 'remote', port, tls })
      }

      await navigate({ to: '/' })
    } catch (reason) {
      connectFailure(reason)
    } finally {
      setBusy(false)
    }
  }

  const applyPaste = (value: string) => {
    const link = parsePairLink(value)

    if (link) {
      setAddress(formatAddress(link))
      setCode(link.code)
    }
  }

  const probe = async () => {
    const parts = parseAddress(address)

    if (!parts) {
      return setError('Enter a valid daemon address.')
    }

    setBusy(true)
    setError(null)

    try {
      await probeDaemon(targetOrigin({ kind: 'remote', ...parts, deviceToken: '', tls: false }))
      setDaemonName(formatAddress(parts))
    } catch {
      setError('The daemon could not be reached.')
    } finally {
      setBusy(false)
    }
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    const parts = parseAddress(address)

    if (!parts) {
      return setError('Enter a valid daemon address.')
    }

    setBusy(true)
    setError(null)

    try {
      const paired = await pairWithDaemon(parts.host, parts.port, code.trim(), deviceName.trim())
      setDaemonName(paired.daemonName)
      await connectTo({ kind: 'remote', ...parts, deviceToken: paired.deviceToken, tls: false })
      await navigate({ to: '/' })
    } catch (reason) {
      setError(pairingErrorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="relative grid min-h-screen place-items-center bg-background p-6 text-foreground">
      <div aria-hidden className="hex-drag absolute inset-x-0 top-0 h-11" />
      <form
        className="hex-rise w-full max-w-[520px] space-y-5 rounded-window border border-border bg-surface p-6"
        onSubmit={submit}
      >
        <header className="space-y-3">
          <Wordmark mood={signIn ? 'listening' : 'idle'} />
          <div>
            <h1 className="text-[length:var(--text-title)] font-semibold">Connect to Hexbot</h1>
            <p className="mt-1 text-secondary text-muted">
              Enter the address and one-time pairing code shown by the daemon.
            </p>
          </div>
        </header>
        {signIn ? (
          <div className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1" role="status">
            <span className="flex items-center gap-2 text-muted">
              <Spinner label="Waiting for the browser" size="sm" />
              <span>
                Continue in your browser. Code{' '}
                <span className="font-mono text-foreground" data-testid="connect-signin-code">
                  {signIn.code}
                </span>
              </span>
            </span>
            <button
              className="text-accent hover:underline"
              onClick={() => openSignIn(signIn)}
              type="button"
            >
              Reopen link
            </button>
            <span aria-hidden className="text-muted">
              ·
            </span>
            <button
              className="hover:underline"
              onClick={() => setSignIn(null)}
              type="button"
            >
              Cancel
            </button>
          </div>
        ) : (
          <Button onClick={() => void startConnectLogin()} type="button">
            Sign in with Hex Connect
          </Button>
        )}
        {daemons.length ? (
          <div>
            <p className="mb-2 font-medium">Choose a daemon</p>
            <div className="divide-y divide-border">
              {daemons.map(daemon => (
                <button
                  className="flex w-full items-center justify-between py-3 text-left hover:text-accent"
                  disabled={busy || daemon.online === false}
                  key={daemon.id}
                  onClick={() => void pickDaemon(daemon)}
                  type="button"
                >
                  <span>{daemon.name ?? daemon.daemon_name ?? daemon.tunnel_hostname}</span>
                  <span className="text-muted">
                    {daemon.status === 'unreachable'
                      ? 'Running, but not reachable'
                      : daemon.online === false
                        ? 'Offline'
                        : 'Connect'}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
        <label className="block space-y-2">
          <span>Daemon address</span>
          <Input
            data-testid="connect-address-input"
            onChange={e => {
              setAddress(e.target.value)
              applyPaste(e.target.value)
            }}
            onPaste={e => applyPaste(e.clipboardData.getData('text'))}
            value={address}
          />
        </label>
        <label className="block space-y-2">
          <span>Pairing code</span>
          <Input
            data-testid="connect-code-input"
            onChange={e => setCode(e.target.value)}
            value={code}
          />
        </label>
        <label className="block space-y-2">
          <span>Device name</span>
          <Input onChange={e => setDeviceName(e.target.value)} value={deviceName} />
        </label>
        {daemonName ? <p className="text-secondary text-success">Found {daemonName}</p> : null}
        <div className="flex justify-end gap-2">
          <Button busy={busy} onClick={() => void probe()} type="button">
            Probe
          </Button>
          <Button
            busy={busy}
            data-testid="connect-submit"
            disabled={!code.trim() || !deviceName.trim()}
            type="submit"
            variant="primary"
          >
            Connect
          </Button>
        </div>
        {error || proofError ? (
          <p className="text-secondary text-danger" role="alert">
            {error || proofError?.message}
          </p>
        ) : null}
      </form>
    </main>
  )
}
