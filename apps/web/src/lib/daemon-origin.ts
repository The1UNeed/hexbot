import { getBridge } from './bridge'
import { DEFAULT_DAEMON_PORT } from './pair-link'
import type { ConnectionTarget } from './types'

let localDaemonPort = DEFAULT_DAEMON_PORT

/** Remember the port of the daemon the Electron main process started. */
export function setLocalDaemonPort(port?: null | number): void {
  if (port) {
    localDaemonPort = port
  }
}

/** HTTP origin for a target, e.g. `http://192.168.1.10:9119`. */
export function targetOrigin(target: ConnectionTarget): string {
  if (target.kind === 'remote') {
    return `${target.tls ? 'https' : 'http'}://${target.host}${target.port === (target.tls ? 443 : 80) ? '' : `:${target.port}`}`
  }

  if (target.origin) {
    return target.origin.replace(/\/+$/, '')
  }

  // A browser page came from the daemon itself, or from the Vite dev server
  // proxying it (VITE_HEXBOT_ORIGIN). Inside Electron the page origin is
  // hexbot-app:// or, in dev, the Vite server: never the daemon.
  if (
    typeof window !== 'undefined' &&
    !getBridge() &&
    window.location.protocol.startsWith('http')
  ) {
    return window.location.origin
  }

  return `http://127.0.0.1:${localDaemonPort}`
}
