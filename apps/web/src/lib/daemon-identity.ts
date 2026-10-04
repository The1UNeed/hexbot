/** Check the daemon before handing its address a Connect login grant. */
const skipped = new Set<string>()

function skip(reason: string): void {
  if (!skipped.has(reason)) {
    skipped.add(reason)
    console.warn(`Hex Connect identity check skipped: ${reason}`)
  }
}

function decode(value: string, bytes: number): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error('Invalid base64url')
  }

  const decoded = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c =>
    c.charCodeAt(0)
  )

  if (decoded.length !== bytes) {
    throw new Error('Invalid key or signature size')
  }

  return decoded
}

function identityHost(origin: string): string {
  const url = new URL(origin)
  const host = url.hostname.toLowerCase().replace(/\.+$/, '')

  return url.port && url.port !== '80' && url.port !== '443' ? `${host}:${url.port}` : host
}

async function readIdentity(response: Response): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader()

  if (!reader) {
    throw new Error('Missing identity response')
  }

  const chunks: Uint8Array[] = []
  let size = 0

  for (;;) {
    const { done, value } = await reader.read()

    if (done) {
      break
    }

    size += value.byteLength

    if (size > 64 * 1024) {
      await reader.cancel()
      throw new Error('Identity response too large')
    }

    chunks.push(value)
  }

  const bytes = new Uint8Array(size)
  let offset = 0

  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }

  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>
}

export class DaemonIdentityError extends Error {
  constructor(name: string) {
    super(`${name} did not prove it is your daemon, so sign-in stopped.`)
    this.name = 'DaemonIdentityError'
  }
}

export class DaemonUnreachableError extends Error {
  constructor(name: string) {
    super(`${name} could not be reached.`)
    this.name = 'DaemonUnreachableError'
  }
}

const errorName = (error: unknown) =>
  typeof error === 'object' && error !== null && 'name' in error ? error.name : undefined

const unsupported = (error: unknown) => errorName(error) === 'NotSupportedError'

export async function verifyDaemonIdentity(
  origin: string,
  daemon: { id: string; name?: string; daemon_name?: string; identity_key?: string | null }
): Promise<void> {
  if (daemon.identity_key == null) {
    skip('no key known')

    return
  }

  if (!crypto.subtle) {
    skip('Ed25519 unavailable')

    return
  }

  const name = daemon.name || daemon.daemon_name || 'Your daemon'
  let key: CryptoKey

  try {
    key = await crypto.subtle.importKey('raw', decode(daemon.identity_key, 32), 'Ed25519', false, [
      'verify'
    ])
  } catch (error) {
    if (unsupported(error)) {
      skip('Ed25519 unavailable')

      return
    }

    throw new DaemonIdentityError(name)
  }

  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

  let response: Response

  try {
    response = await fetch(`${origin}/api/connect/identity?nonce=${nonce}`, {
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(3000)
    })
  } catch {
    throw new DaemonUnreachableError(name)
  }

  if (response.status >= 500) {
    throw new DaemonUnreachableError(name)
  }

  // A known key requires a proof, including when the address answers 404.
  if (!response.ok) {
    throw new DaemonIdentityError(name)
  }

  let body: Record<string, unknown>

  try {
    body = await readIdentity(response)
  } catch (error) {
    if (['TimeoutError', 'AbortError', 'TypeError'].includes(String(errorName(error)))) {
      throw new DaemonUnreachableError(name)
    }

    throw new DaemonIdentityError(name)
  }

  if (
    body?.daemon_id !== daemon.id ||
    body.public_key !== daemon.identity_key ||
    typeof body.signature !== 'string'
  ) {
    throw new DaemonIdentityError(name)
  }

  const message = new TextEncoder().encode(
    `hexbot-identity-v1\n${daemon.id}\n${identityHost(origin)}\n${nonce}`
  )

  try {
    if (!(await crypto.subtle.verify('Ed25519', key, decode(body.signature, 64), message))) {
      throw new DaemonIdentityError(name)
    }
  } catch (error) {
    if (unsupported(error)) {
      skip('Ed25519 unavailable')

      return
    }

    throw new DaemonIdentityError(name)
  }
}
