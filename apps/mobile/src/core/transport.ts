import { JsonRpcGatewayClient, readDeviceProofError } from '@hermes/shared'
import * as Crypto from 'expo-crypto'
import { Platform } from 'react-native'
import { createProof, thumbprint, base64url, verifyIdentity } from './proof'
import { proofKey } from './storage'
import { daemonAddress, CONNECT_ORIGIN } from './links'
import type { SavedDaemon, ConnectDaemon } from './types'
export class RevokedError extends Error {
  constructor() {
    super('This device was revoked. Pair it again to connect.')
    this.name = 'RevokedError'
  }
}
export class HttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'HttpError'
    this.status = status
  }
}
export async function request<T>(
  url: string,
  init: RequestInit = {},
  timeoutMs = 15000
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { ...init, signal: controller.signal, redirect: 'error' })
    const proofError = await readDeviceProofError(response)
    if (proofError) throw proofError
    const body = await response.json().catch(() => ({}))
    if (!response.ok) {
      // Only a request made with a credential can find that credential revoked.
      if (response.status === 401 && new Headers(init.headers).has('Authorization'))
        throw new RevokedError()
      throw new HttpError(
        response.status,
        body.message || body.error || `The request failed, HTTP ${response.status}.`
      )
    }
    return body as T
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError')
      throw new Error('The daemon did not answer. Check its address and connection.')
    throw error
  } finally {
    clearTimeout(timer)
  }
}
export async function proofHeaders(
  method: string,
  url: string,
  token?: string
): Promise<Record<string, string>> {
  return {
    DPoP: createProof(await proofKey(), method, url, Crypto.randomUUID(), token),
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  }
}
export async function pair(
  origin: string,
  code: string
): Promise<{ daemon: SavedDaemon; token: string }> {
  const url = `${origin}/hexbot/pair`
  const result = await request<{ device_token: string; device_id: string; daemon_name: string }>(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await proofHeaders('POST', url)) },
      body: JSON.stringify({
        code: code.trim(),
        device_name: Platform.OS === 'ios' ? 'Hexbot on iPhone' : 'Hexbot on Android',
        platform: Platform.OS
      })
    }
  ).catch(error => {
    if (error instanceof HttpError && error.status === 401)
      throw new Error('That pairing code is wrong or expired.')
    throw error
  })
  if (!result.device_token || !result.device_id)
    throw new Error('The daemon did not return a device credential.')
  return {
    daemon: {
      id: Crypto.randomUUID(),
      name: result.daemon_name,
      origin,
      kind: 'local',
      deviceId: result.device_id
    },
    token: result.device_token
  }
}
export async function connectGrant(
  daemon: ConnectDaemon,
  session: string
): Promise<{ daemon: SavedDaemon; token: string }> {
  const grant = await request<{
    grant: string
    daemon: { host: string; port: number; tls: boolean }
  }>(`${CONNECT_ORIGIN}/api/daemons/${encodeURIComponent(daemon.id)}/grant`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${session}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jkt: thumbprint(await proofKey()) })
  })
  const target = grant.daemon
  const origin = daemonAddress({
    ...daemon,
    address: target
      ? `${target.tls ? 'https' : 'http'}://${target.host}:${target.port}`
      : daemon.address
  })
  if (daemon.identity_key) {
    const nonce = base64url(Crypto.getRandomBytes(32))
    const body = await request<Record<string, unknown>>(
      `${origin}/api/connect/identity?nonce=${nonce}`,
      {},
      5000
    )
    verifyIdentity(origin, daemon.id, daemon.identity_key, nonce, body)
  }
  const url = `${origin}/auth/password-login`
  const password = `cg_${grant.grant}`
  const login = await request<{ device_token: string; device_id: string; daemon_name: string }>(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(await proofHeaders('POST', url, password))
      },
      body: JSON.stringify({
        provider: 'hexbot',
        username: Platform.OS === 'ios' ? 'Hexbot on iPhone' : 'Hexbot on Android',
        password
      })
    }
  ).catch(error => {
    // The grant is a one-time sign-in, not a device credential that can be revoked.
    if (error instanceof RevokedError)
      throw new Error('The daemon refused the Hex Connect sign-in. Choose it again.')
    throw error
  })
  if (!login.device_token || !login.device_id)
    throw new Error('The daemon did not return a device credential.')
  return {
    daemon: {
      id: Crypto.randomUUID(),
      name: login.daemon_name,
      origin,
      kind: 'connect',
      deviceId: login.device_id
    },
    token: login.device_token
  }
}
export async function openGateway(
  client: JsonRpcGatewayClient,
  daemon: SavedDaemon,
  token: string
): Promise<void> {
  const url = `${daemon.origin}/api/auth/ws-ticket`
  const { ticket } = await request<{ ticket: string }>(url, {
    method: 'POST',
    headers: await proofHeaders('POST', url, token)
  })
  if (!ticket) throw new Error('The daemon did not return a connection ticket.')
  const ws = new URL('/api/ws', daemon.origin)
  ws.protocol = ws.protocol === 'https:' ? 'wss:' : 'ws:'
  ws.searchParams.set('ticket', ticket)
  let unsubscribe = () => {}
  let timer: ReturnType<typeof setTimeout> | undefined
  const ready = new Promise<void>((resolve, reject) => {
    unsubscribe = client.on('gateway.ready', () => resolve())
    timer = setTimeout(
      () => reject(new Error('The daemon connection did not become ready.')),
      15000
    )
  })
  try {
    await Promise.all([client.connect(ws.href), ready])
  } finally {
    unsubscribe()
    clearTimeout(timer)
  }
}
