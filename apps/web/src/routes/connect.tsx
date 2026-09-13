import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'

import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Spinner } from '../components/ui/spinner'
import { Wordmark } from '../components/ui/wordmark'
import { defaultDeviceName, getBridge } from '../lib/bridge'
import { connectBaseUrl, grantTarget } from '../lib/connect-url'
import {
  connectTo,
  InvalidCodeError,
  pairWithDaemon,
  probeDaemon,
  targetOrigin,
  UnauthorizedError
} from '../lib/connection'
import { formatAddress, parseAddress, parsePairLink } from '../lib/pair-link'

export const Route = createFileRoute('/connect')({ component: ConnectPage })

export function parseConnectCallback(input: string): { session: string; state: string } | null {
  if (!input.startsWith('hexbot://connect')) {return null}
  const [beforeHash, hash = ''] = input.split('#')
  const url = new URL(beforeHash ?? input)
  const state = url.searchParams.get('state')
  const session = new URLSearchParams(hash).get('session')

  return state && session ? { session, state } : null
}

async function fetchConnect(
  path: string,
  token: string,
  body?: Record<string, unknown>
): Promise<unknown> {
  const response = await fetch(`${connectBaseUrl()}${path}`, {
    body: body ? JSON.stringify(body) : undefined,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    method: body ? 'POST' : 'GET'
  })

  if (!response.ok) {throw new Error(`Hexbot Connect request failed (${response.status})`)}

  return response.json()
}

function ConnectPage() {
  const navigate = useNavigate()
  const [address, setAddress] = useState('127.0.0.1:9119')
  const [code, setCode] = useState('')
  const [deviceName, setDeviceName] = useState(defaultDeviceName)
  const [daemonName, setDaemonName] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [connectState, setConnectState] = useState<string | null>(null)

  const [daemons, setDaemons] = useState<
    Array<{
      id: string
      name?: string
      daemon_name?: string
      tunnel_hostname: string
      online?: boolean
    }>
  >([])

  const [clientSession, setClientSession] = useState<string | null>(() =>
    localStorage.getItem('hexbot.connect.session')
  )

  useEffect(() => {
    const bridge = getBridge()

    if (!bridge?.onNavigate) {return}

    return bridge.onNavigate(url => {
      const parsed = parseConnectCallback(url)

      if (!parsed || parsed.state !== connectState) {return}
      localStorage.setItem('hexbot.connect.session', parsed.session)
      setClientSession(parsed.session)
    })
  }, [connectState])
  useEffect(() => {
    if (!clientSession) {return}
    void fetchConnect('/api/daemons', clientSession)
      .then(result =>
        setDaemons((result as { daemons?: typeof daemons }).daemons ?? (result as typeof daemons))
      )
      .catch(reason => setError(String(reason)))
  }, [clientSession])

  // Reopening keeps the same state, so the link already open in the browser
  // still completes the sign-in.
  const startConnectLogin = (existing?: string) => {
    const state = existing ?? crypto.randomUUID()
    setConnectState(state)
    const url = `${connectBaseUrl()}/connect/authorize?state=${encodeURIComponent(state)}&device=${encodeURIComponent(deviceName)}`
    const bridge = getBridge()

    if (bridge) {void bridge.openExternal(url)}
    else {window.location.assign(url)}
  }

  const pickDaemon = async (daemon: (typeof daemons)[number]) => {
    if (!clientSession) {return}
    setBusy(true)

    try {
      const granted = (await fetchConnect(
        `/api/daemons/${encodeURIComponent(daemon.id)}/grant`,
        clientSession,
        { device_name: deviceName }
      )) as { grant: string; daemon?: { host?: string; port?: number; tls?: boolean } }

      const { host, port, tls } = grantTarget(granted, daemon.tunnel_hostname)
      const origin = targetOrigin({ deviceToken: '', host, kind: 'remote', port, tls })
      const bridge = getBridge()

      if (bridge?.pairWithGrant) {
        const result = await bridge.pairWithGrant({
          deviceName,
          grant: granted.grant,
          host: origin.replace(/^https?:\/\//, ''),
          tls
        })

        await connectTo({ deviceToken: result.device_token, host, kind: 'remote', port, tls })
      } else {
        const response = await fetch(`${origin}/auth/password-login`, {
          body: JSON.stringify({
            password: `cg_${granted.grant}`,
            provider: 'hexbot',
            username: deviceName
          }),
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          method: 'POST'
        })

        if (!response.ok) {throw new Error(`Connect login failed (${response.status})`)}
        await connectTo({ deviceToken: '', host, kind: 'remote', port, tls })
      }

      await navigate({ to: '/' })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
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
      const result = await probeDaemon(
        targetOrigin({ kind: 'remote', ...parts, deviceToken: '', tls: false })
      )

      setDaemonName(result.daemonName ?? formatAddress(parts))
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
      setError(
        reason instanceof InvalidCodeError
          ? 'The pairing code is invalid or expired.'
          : reason instanceof UnauthorizedError
            ? 'This device was revoked. Pair it again.'
            : 'The daemon could not be reached.'
      )
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
          <Wordmark mood={connectState && !clientSession ? 'listening' : 'idle'} />
          <div>
            <h1 className="text-[length:var(--text-title)] font-semibold">Connect to Hexbot</h1>
            <p className="mt-1 text-secondary text-muted">
              Enter the address and one-time pairing code shown by the daemon.
            </p>
          </div>
        </header>
        {connectState && !clientSession ? (
          <div className="flex h-9 items-center gap-3" role="status">
            <span className="flex items-center gap-2 text-muted">
              <Spinner label="Waiting for the browser" size="sm" />
              Continue in your browser
            </span>
            <button
              className="text-accent hover:underline"
              onClick={() => startConnectLogin(connectState)}
              type="button"
            >
              Reopen link
            </button>
            <span aria-hidden className="text-muted">
              ·
            </span>
            <button
              className="hover:underline"
              onClick={() => setConnectState(null)}
              type="button"
            >
              Cancel
            </button>
          </div>
        ) : (
          <Button onClick={() => startConnectLogin()} type="button">
            Sign in with Hexbot Connect
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
                    {daemon.online === false ? 'Offline' : 'Connect'}
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
        {error ? (
          <p className="text-secondary text-danger" role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </main>
  )
}
