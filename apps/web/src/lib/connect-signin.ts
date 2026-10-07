import { connectBaseUrl } from './connect-url'

/** Matches Connect's APP_SIGNIN_TTL_MS: an approval the app has not collected by then is gone. */
export const APP_SIGNIN_TTL_MS = 10 * 60_000

/**
 * One Hex Connect sign-in in progress. The verifier never leaves this app until
 * it collects the session, so the session reaches the app that asked even when
 * several Hexbot apps on the computer claim hexbot:// (docs/connect.md, "App sign-in").
 */
export interface AppSignIn {
  challenge: string
  code: string
  deadline: number
  state: string
  verifier: string
}

const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

/** The code the authorize page shows beside the app's; Connect derives it the same way. */
export function confirmationCode(digest: Uint8Array): string {
  const raw = Array.from(digest.subarray(0, 8), byte => alphabet[byte % alphabet.length]).join('')

  return `${raw.slice(0, 4)}-${raw.slice(4)}`
}

export async function startAppSignIn(now = Date.now()): Promise<AppSignIn> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)))

  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  )

  return {
    challenge: base64url(digest),
    code: confirmationCode(digest),
    deadline: now + APP_SIGNIN_TTL_MS,
    state: crypto.randomUUID(),
    verifier
  }
}

export function authorizeUrl(signIn: AppSignIn, deviceName: string): string {
  const query = new URLSearchParams({
    challenge: signIn.challenge,
    device: deviceName,
    state: signIn.state
  })

  return `${connectBaseUrl()}/connect/authorize?${query}`
}

/**
 * The session token once the user approved, otherwise null. Errors also give
 * null: a Connect without polling answers 404, and the app then waits for the
 * hexbot:// link instead.
 */
export async function collectAppSignIn(signIn: AppSignIn): Promise<string | null> {
  try {
    const response = await fetch(`${connectBaseUrl()}/api/authorize/poll`, {
      body: JSON.stringify({ verifier: signIn.verifier }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST'
    })

    if (!response.ok) {
      return null
    }

    const body = (await response.json()) as { session?: unknown; status?: unknown }

    return body.status === 'approved' && typeof body.session === 'string' ? body.session : null
  } catch {
    return null
  }
}
