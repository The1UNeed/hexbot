/**
 * Full-window lock shown when the daemon connection is lost. It sits above
 * every route and the page underneath is made `inert` until the supervisor
 * reconnects. It borrows the welcome and connect screens' card and `hex-rise`
 * entrance so a lost connection reads as "back at the door", not as a crash.
 */

import { useNavigate, useRouterState } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'

import { Button } from '../components/ui/button'
import { HexbotMark } from '../components/ui/wordmark'
import { getBridge, hasLocalRuntime } from '../lib/bridge'
import { getSupervisor, setLocalDaemonPort } from '../lib/connection'
import { useConnection } from '../stores/connection'

const STARTING_PAGES = ['/connect', '/onboarding']

/** True while the client has a daemon it cannot reach. */
export function useConnectionLost(): boolean {
  const status = useConnection(state => state.status)
  const target = useConnection(state => state.target)
  const pathname = useRouterState({ select: state => state.location.pathname })

  if (!target || pathname === '/connect') {
    return false
  }

  // A dropped connection locks every page. A daemon that never answered only
  // locks the app pages: the starting pages handle first contact themselves.
  return (
    status === 'reconnecting' || (status === 'offline' && !STARTING_PAGES.includes(pathname))
  )
}

export function ConnectionLost() {
  const navigate = useNavigate()
  const status = useConnection(state => state.status)
  const attempt = useConnection(state => state.attempt)
  const daemon = useConnection(state => state.daemon)
  const target = useConnection(state => state.target)
  const [busy, setBusy] = useState(false)
  const dialog = useRef<HTMLDivElement>(null)

  useEffect(() => dialog.current?.focus(), [])

  const reconnect = async () => {
    setBusy(true)

    try {
      // The full package owns its daemon: bring it back before retrying.
      if (target?.kind === 'local' && !target.origin && hasLocalRuntime()) {
        await getBridge()!
          .daemon.start()
          .then(result => setLocalDaemonPort(result.port))
          .catch(() => undefined)
      }

      await getSupervisor().retryNow()
    } finally {
      setBusy(false)
    }
  }

  const name = daemon?.daemon_name || 'the daemon'

  return (
    <div
      aria-labelledby="connection-lost-title"
      aria-modal
      className="hex-fade fixed inset-0 z-[100] grid place-items-center bg-background/80 p-6 text-foreground outline-none backdrop-blur-sm"
      data-testid="connection-lost"
      ref={dialog}
      role="alertdialog"
      tabIndex={-1}
    >
      <div aria-hidden className="hex-drag absolute inset-x-0 top-0 h-11" />
      <div className="hex-rise w-full max-w-[420px] space-y-5 rounded-window border border-border bg-surface p-6 text-center shadow-popup">
        <HexbotMark className="mx-auto" mood="sleeping" size={56} />
        <div>
          <h1
            className="text-[length:var(--text-title)] font-semibold"
            id="connection-lost-title"
          >
            Connection lost
          </h1>
          <p className="mt-1 text-secondary text-muted">
            {status === 'reconnecting'
              ? `Hexbot lost its connection to ${name}.`
              : `Hexbot cannot reach ${name}.`}
          </p>
        </div>
        <p className="hex-pulse text-secondary text-muted" role="status">
          Reconnecting{attempt > 0 ? `, attempt ${attempt}` : ''}…
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          <Button busy={busy} onClick={() => void reconnect()} variant="primary">
            Reconnect now
          </Button>
          <Button onClick={() => void navigate({ to: '/connect' })}>
            Connect to another daemon
          </Button>
        </div>
      </div>
    </div>
  )
}
