/**
 * Connect sequence and reconnect supervisor (docs/client-architecture.md).
 *
 *   1. `GET <origin>/` to reach the daemon. The page never carries a credential.
 *   2. `POST /api/auth/ws-ticket` with the device token as bearer (the browser
 *      cookie when the page came from the daemon), then open
 *      `/api/ws?ticket=<ticket>` within 30 seconds.
 *   3. Wait for `gateway.ready`; keep its `replay_epoch`.
 *   4. Call `hexbot.info`, `hexbot.settings.get`, `hexbot.bots.list`.
 *
 * Reconnect backs off 1 s → 16 s forever and resets after 30 s of stable
 * connection. A 401 on the ws-ticket means the device was revoked: the target
 * is cleared and the connect screen takes over.
 */

import { buildHermesWebSocketUrl, DeviceProofError, isDeviceProofCode, type PairingReply, readDeviceProofError } from '@hermes/shared'

import { botsActions } from '../stores/bots'
import { connectionActions } from '../stores/connection'
import { useRooms } from '../stores/rooms'
import { sectionsActions } from '../stores/sections'
import { settingsActions } from '../stores/settings'
import { uiActions } from '../stores/ui'
import { useUsers } from '../stores/users'

import { getBridge, type HexbotBridge } from './bridge'
import { DaemonIdentityError, DaemonUnreachableError } from './daemon-identity'
import { proofHeaders } from './dpop'
import { attachEventRouting } from './events'
import { DEFAULT_DAEMON_PORT } from './pair-link'
import { HexbotRpcClient, setActiveRpc } from './rpc'
import type { ConnectionTarget, DaemonInfo } from './types'

export const BACKOFF_MIN_MS = 1_000
export const BACKOFF_MAX_MS = 16_000
export const STABLE_RESET_MS = 30_000
const READY_TIMEOUT_MS = 15_000

export class UnauthorizedError extends Error {
  constructor(message = 'This device is not authorised by the daemon.') {
    super(message)
    this.name = 'UnauthorizedError'
  }
}

export class UnreachableError extends Error {
  constructor(message = 'Could not reach the daemon at that address.') {
    super(message)
    this.name = 'UnreachableError'
  }
}

export class InvalidCodeError extends Error {
  constructor(message = 'That pairing code is not valid or has expired.') {
    super(message)
    this.name = 'InvalidCodeError'
  }
}

export interface ConnectionDeps {
  bridge?: () => HexbotBridge | null
  fetch?: typeof globalThis.fetch
  socketFactory?: (url: string) => WebSocket
}

interface ReadyPayload {
  replay_epoch?: string
}

/**
 * Inside Electron the renderer origin is `hexbot-app://app`, which the daemon's
 * CORS policy rejects, so HTTP goes through the main process. Browsers use
 * `fetch` directly.
 */
function defaultFetch(deps: ConnectionDeps): typeof fetch {
  const bridge = (deps.bridge ?? getBridge)()

  if (!bridge?.httpFetch) {
    return globalThis.fetch
  }

  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const headers: Record<string, string> = {}

    if (init?.headers) {
      new Headers(init.headers).forEach((value, key) => {
        headers[key] = value
      })
    }

    const result = await bridge.httpFetch(url, {
      body: typeof init?.body === 'string' ? init.body : undefined,
      headers,
      method: init?.method
    })

    return new Response(result.text, {
      headers: result.headers,
      status: result.status,
      statusText: result.statusText
    })
  }
}

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

/**
 * Reach the daemon's `/` page. It never carries a credential (any local
 * process could fetch it); the credential is the device token, or the
 * same-origin cookie, when a ticket is minted.
 */
export async function probeDaemon(origin: string, deps: ConnectionDeps = {}): Promise<void> {
  const doFetch = deps.fetch ?? defaultFetch(deps)

  try {
    await doFetch(`${origin}/`, { cache: 'no-store', credentials: 'same-origin' })
  } catch (error) {
    throw new UnreachableError(error instanceof Error ? error.message : String(error))
  }
}

/** Bearer token used for HTTP calls against a gated daemon. */
async function bearerToken(target: ConnectionTarget, deps: ConnectionDeps): Promise<string> {
  if (target.kind === 'remote') {
    return target.deviceToken
  }

  const bridge = (deps.bridge ?? getBridge)()

  if (!bridge && typeof window !== 'undefined' && targetOrigin(target) === window.location.origin) {
    return ''
  }

  const token = await bridge?.daemon.localToken()

  if (!token) {
    throw new UnauthorizedError('The local daemon requires a device token but none is stored.')
  }

  return token
}

async function mintTicket(
  origin: string,
  bearer: string,
  remote: boolean,
  deps: ConnectionDeps
): Promise<string> {
  const doFetch = deps.fetch ?? defaultFetch(deps)
  const url = `${origin}/api/auth/ws-ticket`
  const crossOrigin = origin !== window.location.origin

  let response: Response

  try {
    response = await doFetch(url, {
      ...(bearer
        ? {
            headers: {
              Authorization: `Bearer ${bearer}`,
              ...(remote ? await proofHeaders('POST', url, bearer) : {})
            }
          }
        : // Remote browsers without a proof key retain their HttpOnly cookie.
          { credentials: crossOrigin ? ('include' as const) : ('same-origin' as const) }),
      method: 'POST'
    })
  } catch (error) {
    throw new UnreachableError(error instanceof Error ? error.message : String(error))
  }

  const proofError = await readDeviceProofError(response)

  if (proofError) {
    throw proofError
  }

  if (response.status === 401) {
    throw new UnauthorizedError()
  }

  if (!response.ok) {
    throw new UnreachableError(`The daemon refused a WebSocket ticket (HTTP ${response.status}).`)
  }

  const body = (await response.json()) as { ticket?: string }

  if (!body.ticket) {
    throw new UnreachableError('The daemon returned an empty WebSocket ticket.')
  }

  return body.ticket
}

/** The `/api/ws` URL with a single-use ticket from the device credential. */
export async function resolveWsUrl(
  target: ConnectionTarget,
  deps: ConnectionDeps = {}
): Promise<string> {
  const origin = targetOrigin(target)
  const url = new URL(origin)
  const base = { host: url.host, path: '/api/ws', protocol: url.protocol }

  const ticket = await mintTicket(
    origin,
    await bearerToken(target, deps),
    target.kind === 'remote',
    deps
  )

  return buildHermesWebSocketUrl({ ...base, authParam: ['ticket', ticket] })
}

/**
 * Exchange a pairing code for a long-lived device token. Electron routes this
 * through the main process (`window.hexbot.pair`) because the daemon's CORS
 * policy only admits loopback origins.
 */
export async function pairWithDaemon(
  host: string,
  port: number,
  code: string,
  deviceName: string,
  deps: ConnectionDeps = {}
): Promise<{ daemonName: string; deviceId: string; deviceToken: string }> {
  const bridge = (deps.bridge ?? getBridge)()

  if (bridge) {
    const proof = await proofHeaders('POST', `http://${host}:${port}/auth/password-login`)
    const result = unwrapPairingReply(await bridge.pair(host, port, code, deviceName, proof.DPoP))

    return {
      daemonName: result.daemon_name,
      deviceId: result.device_id,
      deviceToken: result.device_token
    }
  }

  const doFetch = deps.fetch ?? defaultFetch(deps)
  const origin = `http://${host}:${port}`
  const crossOrigin = new URL(origin).origin !== window.location.origin
  const proof = crossOrigin ? await proofHeaders('POST', `${origin}/auth/password-login`) : {}
  let response: Response

  try {
    response = await doFetch(`${origin}/auth/password-login`, {
      body: JSON.stringify({
        password: code,
        provider: 'hexbot',
        username: deviceName,
        device_name: deviceName,
        platform: typeof navigator === 'undefined' ? 'web' : navigator.platform
      }),
      headers: {
        'Content-Type': 'application/json',
        ...proof
      },
      method: 'POST',
      credentials: 'include'
    })
  } catch (error) {
    throw new UnreachableError(error instanceof Error ? error.message : String(error))
  }

  const proofError = await readDeviceProofError(response)

  if (proofError) {
    throw proofError
  }

  if (response.status === 400 || response.status === 404) {
    throw new InvalidCodeError()
  }

  if (response.status === 401) {
    throw new InvalidCodeError()
  }

  if (!response.ok) {
    throw new UnreachableError(`Pairing failed (HTTP ${response.status}).`)
  }

  const body = (await response.json()) as {
    daemon_name?: string
    device_id?: string
    device_token?: string
  }

  if (!body.device_token) {
    await verifyBrowserCookie(origin, body.daemon_name ?? host, deps)
  }

  return {
    daemonName: body.daemon_name ?? host,
    deviceId: body.device_id ?? '',
    // Same-origin browsers keep their cookie session. Remote proof clients receive a token.
    deviceToken: body.device_token ?? ''
  }
}

/**
 * Owns one daemon connection: opens it, keeps it open, and publishes state to
 * the `connection` store.
 */
export class ConnectionSupervisor {
  private attempt = 0
  private client: HexbotRpcClient | null = null
  private connectedAt = 0
  private detach: (() => void) | null = null
  /** Bumped on every start/stop so a late async open cannot win a race. */
  private generation = 0
  private revoked = false
  private retryTimer: null | ReturnType<typeof setTimeout> = null
  private stopped = true
  private target: ConnectionTarget | null = null
  private starting: Promise<void> | null = null

  constructor(private readonly deps: ConnectionDeps = {}) {}

  get rpc(): HexbotRpcClient | null {
    return this.client
  }

  /** Connect to `target` and keep reconnecting until `stop()`. */
  start(target: ConnectionTarget): Promise<void> {
    // The target-setting action and root lifecycle can observe the same
    // target in one render. Share that handshake instead of cancelling it.
    if (!this.stopped && this.target === target && this.starting) {
      return this.starting
    }

    this.teardown()
    this.stopped = false
    this.revoked = false
    this.attempt = 0
    this.connectedAt = 0
    this.target = target

    this.starting = this.attemptConnect()

    return this.starting
  }

  stop(): void {
    this.teardown()
    connectionActions().setStatus('idle', { attempt: 0, error: null })
  }

  /** Drop the backoff and try again now (the "Retry" button). */
  retryNow(): Promise<void> {
    if (!this.target) {
      return Promise.resolve()
    }

    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }

    this.stopped = false
    this.attempt = 0

    return this.attemptConnect()
  }

  private teardown(): void {
    this.generation += 1
    this.stopped = true
    this.starting = null

    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }

    this.detach?.()
    this.detach = null
    this.client?.close()
    this.client = null
    setActiveRpc(null)
  }

  private async attemptConnect(): Promise<void> {
    if (this.stopped || !this.target) {
      return
    }

    const generation = this.generation
    const target = this.target
    const store = connectionActions()

    store.setStatus(this.connectedAt ? 'reconnecting' : 'connecting', { attempt: this.attempt })

    try {
      await this.open(target, generation)
    } catch (error) {
      if (generation !== this.generation || this.stopped) {
        return
      }

      if (error instanceof DeviceProofError) {
        // A changed key needs pairing; temporary proof failures keep reconnecting.
        if (error.code === 'dpop_key_mismatch') {
          store.setStatus('unauthorized', { attempt: 0, proofError: error })
        } else {
          this.scheduleRetry(error)
        }

        return
      }

      if (error instanceof UnauthorizedError) {
        this.handleUnauthorized(error.message)

        return
      }

      this.scheduleRetry()
    }
  }

  private async open(target: ConnectionTarget, generation: number): Promise<void> {
    await probeDaemon(targetOrigin(target), this.deps)
    const wsUrl = await resolveWsUrl(target, this.deps)

    if (generation !== this.generation) {
      return
    }

    const client = new HexbotRpcClient(wsUrl, {
      onSocketClose: event => {
        // 4401/4403 are the gateway's auth close codes; treat them the same
        // as a 401 on the ticket mint.
        if (event.code === 4401 || event.code === 4403) {
          this.revoked = true
        }

        return false
      },
      socketFactory: this.deps.socketFactory
    })

    const ready = new Promise<ReadyPayload>((resolve, reject) => {
      const timer = setTimeout(() => {
        off()
        reject(new UnreachableError('The daemon did not send gateway.ready.'))
      }, READY_TIMEOUT_MS)

      const off = client.subscribe<ReadyPayload>('gateway.ready', event => {
        clearTimeout(timer)
        off()
        resolve(event.payload ?? {})
      })
    })

    await client.connect()

    const payload = await ready

    if (generation !== this.generation) {
      client.close()

      return
    }

    this.client = client
    this.detach = attachEventRouting(client)
    setActiveRpc(client)

    client.onState(state => {
      if (state === 'closed' || state === 'error') {
        this.handleDrop(generation)
      }
    })

    this.adoptEpoch(payload.replay_epoch ?? null)

    this.connectedAt = Date.now()
    this.attempt = 0
    connectionActions().setStatus('connected', { attempt: 0, error: null })

    await this.hydrate()
  }

  /**
   * A new replay epoch means the daemon restarted: live session ids from the
   * previous process are gone, so open sections are reopened lazily.
   */
  private adoptEpoch(epoch: null | string): void {
    const store = connectionActions()

    if (epoch && store.epoch && store.epoch !== epoch) {
      sectionsActions().clearLive()
    }

    store.setEpoch(epoch)
  }

  private async hydrate(): Promise<void> {
    const store = connectionActions()

    try {
      const [info] = await Promise.all([
        this.client?.call<DaemonInfo>('hexbot.info') ?? Promise.resolve(null),
        settingsActions().refresh(),
        botsActions().refresh(),
        useRooms.getState().refresh(),
        useUsers.getState().refresh()
      ])

      store.setDaemon(info)

      // A section remembered from another daemon must not be reopened here.
      const last = uiActions().lastSection

      if (last?.daemon && info?.install_id && last.daemon !== info.install_id) {
        uiActions().setLastSection(null)
      }
    } catch (error) {
      store.setStatus('connected', {
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  private handleDrop(generation: number): void {
    if (generation !== this.generation || this.stopped) {
      return
    }

    setActiveRpc(null)
    this.detach?.()
    this.detach = null
    this.client = null

    if (this.revoked) {
      this.handleUnauthorized('This device was revoked by the daemon.')

      return
    }

    // Reset the backoff when the connection held for long enough.
    if (this.connectedAt && Date.now() - this.connectedAt >= STABLE_RESET_MS) {
      this.attempt = 0
    }

    this.scheduleRetry()
  }

  private handleUnauthorized(message: string): void {
    this.teardown()
    connectionActions().clearTarget()
    connectionActions().setStatus('unauthorized', { attempt: 0, error: message })
  }

  private scheduleRetry(proofError: DeviceProofError | null = null): void {
    this.attempt += 1

    const delay = Math.max(proofError?.retryAfterMs ?? 0, Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** (this.attempt - 1)))

    connectionActions().setStatus(this.connectedAt ? 'reconnecting' : 'offline', {
      attempt: this.attempt,
      error: null,
      proofError
    })

    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.attemptConnect()
    }, delay)
  }
}

let supervisor: ConnectionSupervisor | null = null

export function getSupervisor(): ConnectionSupervisor {
  supervisor ??= new ConnectionSupervisor()

  return supervisor
}

/** Store the target and connect to it. */
export function connectTo(target: ConnectionTarget): Promise<void> {
  connectionActions().setTarget(target)

  return getSupervisor().start(target)
}

export function disconnect(): void {
  getSupervisor().stop()
}


export function unwrapPairingReply<T>(reply: PairingReply<T>): T {
  if (reply.ok) {return reply.value}
  const { code, serverTime, proofTime, retryAfterMs } = reply.error

  if (isDeviceProofCode(code)) {throw new DeviceProofError(code, serverTime, proofTime, retryAfterMs)}

  if (code === 'invalid_code') {throw new InvalidCodeError()}
  throw new UnreachableError()
}

export class BrowserCookieError extends Error {
  constructor(name: string, origin: string) {
    super(`This browser can't keep a key or a sign-in cookie for ${name} from this page. Open ${origin} directly to connect to ${name}.`)
    this.name = 'BrowserCookieError'
  }
}

/** Check cookie acceptance before persisting a keyless browser target. */
export async function verifyBrowserCookie(origin: string, name: string, deps: ConnectionDeps = {}): Promise<void> {
  try {
    await mintTicket(origin, '', false, deps)
  } catch (error) {
    if (error instanceof UnauthorizedError) {throw new BrowserCookieError(name, origin)}
    throw error
  }
}

/** Never display a fetch or Electron IPC exception verbatim. */
export function pairingErrorMessage(reason: unknown): string {
  if (reason instanceof DeviceProofError || reason instanceof BrowserCookieError || reason instanceof DaemonIdentityError || reason instanceof DaemonUnreachableError) {return reason.message}

  if (reason instanceof InvalidCodeError) {return 'The pairing code is invalid or expired.'}

  if (reason instanceof UnauthorizedError) {return 'This device was revoked. Pair it again.'}

  return 'The daemon could not be reached.'
}
