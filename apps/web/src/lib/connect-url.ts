/**
 * Base URL of the Hexbot Connect service. A `hexbot.connect.url` entry in
 * localStorage or `VITE_HEXBOT_CONNECT_URL` at build time points the app at a
 * local or self-hosted instance; production uses connect.hexbot.app.
 */
export const DEFAULT_CONNECT_URL = 'https://connect.hexbot.app'

export function connectBaseUrl(): string {
  let stored: string | null = null

  try {
    stored = localStorage.getItem('hexbot.connect.url')
  } catch {
    stored = null
  }

  const configured = stored || import.meta.env?.VITE_HEXBOT_CONNECT_URL

  return (typeof configured === 'string' && configured ? configured : DEFAULT_CONNECT_URL).replace(
    /\/+$/,
    ''
  )
}

/** Where a grant says the daemon is reachable. Falls back to the tunnel hostname over TLS. */
export function grantTarget(
  granted: { daemon?: { host?: string; port?: number; tls?: boolean } },
  fallbackHost: string
): { host: string; port: number; tls: boolean } {
  const tls = granted.daemon?.tls ?? true

  return {
    host: granted.daemon?.host || fallbackHost,
    port: granted.daemon?.port ?? (tls ? 443 : 80),
    tls
  }
}
