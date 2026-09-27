export class PairingError extends Error {
  constructor(public readonly code: 'invalid_code' | 'missing_token' | 'verification_failed') {
    super(code)
    this.name = 'PairingError'
  }
}

export function cookieValue(
  headers: Pick<Headers, 'getSetCookie'>,
  name: string
): string | undefined {
  // Over HTTPS (the Connect tunnel) the daemon prefixes its cookie names.
  const names = new Set([name, `__Host-${name}`, `__Secure-${name}`])
  for (const cookie of headers.getSetCookie()) {
    const first = cookie.split(';', 1)[0]!
    const separator = first.indexOf('=')
    if (separator > 0 && names.has(first.slice(0, separator).trim()))
      return first.slice(separator + 1).trim()
  }
  return undefined
}

export interface PairOptions {
  host: string
  port: number
  code: string
  deviceName: string
}

export interface GrantPairOptions {
  host: string
  grant: string
  deviceName: string
  tls?: boolean
}

export async function pairWithGrant({
  host,
  grant,
  deviceName,
  tls = true
}: GrantPairOptions): Promise<string> {
  const base = `${tls ? 'https' : 'http'}://${host}`
  const response = await fetch(`${base}/auth/password-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider: 'hexbot',
      username: deviceName,
      password: `cg_${grant}`
    }),
    signal: AbortSignal.timeout(30_000)
  })
  if (response.status === 401) throw new PairingError('invalid_code')
  if (!response.ok) throw new PairingError('verification_failed')
  const deviceToken = cookieValue(response.headers, 'hermes_session_at')
  if (!deviceToken) throw new PairingError('missing_token')
  const verify = await fetch(`${base}/api/auth/ws-ticket`, {
    method: 'POST',
    headers: { authorization: `Bearer ${deviceToken}` },
    signal: AbortSignal.timeout(30_000)
  })
  if (!verify.ok) throw new PairingError('verification_failed')
  return deviceToken
}

export async function pair({
  host,
  port,
  code,
  deviceName
}: PairOptions): Promise<{ deviceToken: string; daemonName: string }> {
  const base = `http://${host}:${port}`
  const response = await fetch(`${base}/auth/password-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'hexbot', username: deviceName, password: code }),
    signal: AbortSignal.timeout(30_000)
  })
  if (response.status === 401) throw new PairingError('invalid_code')
  if (!response.ok) throw new PairingError('verification_failed')
  const result = (await response.json()) as { daemon_name?: string }
  const deviceToken = cookieValue(response.headers, 'hermes_session_at')
  if (!deviceToken) throw new PairingError('missing_token')
  const verify = await fetch(`${base}/api/auth/ws-ticket`, {
    method: 'POST',
    headers: { authorization: `Bearer ${deviceToken}` },
    signal: AbortSignal.timeout(30_000)
  })
  if (!verify.ok) throw new PairingError('verification_failed')
  return { deviceToken, daemonName: result.daemon_name ?? host }
}
