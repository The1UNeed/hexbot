/**
 * Connect sequence and reconnect supervisor (docs/client-architecture.md).
 *
 *   1. `GET <origin>/` and read `__HERMES_AUTH_REQUIRED__`.
 *   2. Gate off: open `/api/ws?token=<session token>`.
 *   3. Gate on: `POST /api/auth/ws-ticket` with the device token as bearer,
 *      then open `/api/ws?ticket=<ticket>` within 30 seconds.
 *   4. Wait for `gateway.ready`; keep its `replay_epoch`.
 *   5. Call `hexbot.info`, `hexbot.settings.get`, `hexbot.bots.list`.
 *
 * Reconnect backs off 1 s → 16 s forever and resets after 30 s of stable
 * connection. A 401 on the ws-ticket means the device was revoked: the target
 * is cleared and the connect screen takes over.
 */

import { buildHermesWebSocketUrl } from '@hermes/shared'

import { botsActions } from '../stores/bots'
import { connectionActions } from '../stores/connection'
import { sectionsActions } from '../stores/sections'
import { settingsActions } from '../stores/settings'

import { getBridge, type HexbotBridge } from './bridge'
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

export interface ProbeResult {
  authRequired: boolean
  daemonName?: string
  reachable: boolean
  sessionToken?: string
}

export interface ConnectionDeps {
  bridge?: () => HexbotBridge | null
  fetch?: typeof globalThis.fetch
  socketFactory?: (url: string) => WebSocket
}

interface ReadyPayload {
  replay_epoch?: string
}

/** HTTP origin for a target, e.g. `http://192.168.1.10:9119`. */
export function targetOrigin(target: ConnectionTarget): string {
  if (target.kind === 'remote') {
    return `http://${target.host}:${target.port}`
  }

  const override = import.meta.env?.VITE_HEXBOT_ORIGIN

  if (typeof override === 'string' && override) {
    return override.replace(/\/+$/, '')
  }

  if (typeof window !== 'undefined' && window.location.protocol.startsWith('http')) {
    return window.location.origin
  }

  return `http://127.0.0.1:${DEFAULT_DAEMON_PORT}`
}

function readGlobalToken(origin: string): string | undefined {
  if (typeof window === 'undefined' || window.location.origin !== origin) {
    return undefined
  }

  return window.__HERMES_SESSION_TOKEN__
}

/**
 * Read the daemon's `/` page. The globals are injected as inline script text,
 * so they are matched out of the HTML rather than evaluated.
 */
export async function probeDaemon(origin: string, deps: ConnectionDeps = {}): Promise<ProbeResult> {
  const doFetch = deps.fetch ?? globalThis.fetch
  let body = ''

  try {
    const response = await doFetch(`${origin}/`, { cache: 'no-store', credentials: 'include' })
    body = await response.text()
  } catch (error) {
    throw new UnreachableError(error instanceof Error ? error.message : String(error))
  }

  const flag = /__HERMES_AUTH_REQUIRED__\s*=\s*(true|false)/.exec(body)
  const token = /__HERMES_SESSION_TOKEN__\s*=\s*"([^"]+)"/.exec(body)
  const sessionToken = readGlobalToken(origin) ?? token?.[1]
  const authRequired = flag ? flag[1] === 'true' : !sessionToken

  return { authRequired, reachable: true, sessionToken }
}

/** Bearer token used for HTTP calls against a gated daemon. */
async function bearerToken(target: ConnectionTarget, deps: ConnectionDeps): Promise<string> {
  if (target.kind === 'remote') {
    return target.deviceToken
  }

  const bridge = (deps.bridge ?? getBridge)()
  const token = await bridge?.daemon.localToken()

  if (!token) {
    throw new UnauthorizedError('The local daemon requires a device token but none is stored.')
  }

  return token
}

async function mintTicket(origin: string, bearer: string, deps: ConnectionDeps): Promise<string> {
  const doFetch = deps.fetch ?? globalThis.fetch
  let response: Response

  try {
    response = await doFetch(`${origin}/api/auth/ws-ticket`, {
      headers: { Authorization: `Bearer ${bearer}` },
      method: 'POST'
    })
  } catch (error) {
    throw new UnreachableError(error instanceof Error ? error.message : String(error))
  }

  if (response.status === 401 || response.status === 403) {
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

/** The `/api/ws` URL with whichever credential the gate demands. */
export async function resolveWsUrl(
  target: ConnectionTarget,
  probe: ProbeResult,
  deps: ConnectionDeps = {}
): Promise<string> {
  const origin = targetOrigin(target)
  const url = new URL(origin)
  const base = { host: url.host, path: '/api/ws', protocol: url.protocol }

  if (!probe.authRequired && probe.sessionToken) {
    return buildHermesWebSocketUrl({ ...base, authParam: ['token', probe.sessionToken] })
  }

  const ticket = await mintTicket(origin, await bearerToken(target, deps), deps)

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
    const result = await bridge.pair(host, port, code, deviceName)

    return {
      daemonName: result.daemon_name,
      deviceId: result.device_id,
      deviceToken: result.device_token
    }
  }

  const doFetch = deps.fetch ?? globalThis.fetch
  let response: Response

  try {
    response = await doFetch(`http://${host}:${port}/auth/password-login`, {
      body: JSON.stringify({
        password: code,
        provider: 'hexbot',
        device_name: deviceName,
        platform: typeof navigator === 'undefined' ? 'web' : navigator.platform
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
      credentials: 'include'
    })
  } catch (error) {
    throw new UnreachableError(error instanceof Error ? error.message : String(error))
  }

  if (response.status === 400 || response.status === 404) {
    throw new InvalidCodeError()
  }

  if (response.status === 401 || response.status === 403) {
    throw new UnauthorizedError()
  }

  if (!response.ok) {
    throw new UnreachableError(`Pairing failed (HTTP ${response.status}).`)
  }

  const body = (await response.json()) as {
    daemon_name?: string
    device_id?: string
    device_token?: string
  }

  return {
    daemonName: body.daemon_name ?? host,
    deviceId: body.device_id ?? '',
    // Browser auth lives in an HttpOnly cookie. Electron receives and stores
    // the long-lived token in the main process instead.
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

  constructor(private readonly deps: ConnectionDeps = {}) {}

  get rpc(): HexbotRpcClient | null {
    return this.client
  }

  /** Connect to `target` and keep reconnecting until `stop()`. */
  start(target: ConnectionTarget): Promise<void> {
    this.teardown()
    this.stopped = false
    this.revoked = false
    this.attempt = 0
    this.connectedAt = 0
    this.target = target

    return this.attemptConnect()
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

      if (error instanceof UnauthorizedError) {
        this.handleUnauthorized(error.message)

        return
      }

      this.scheduleRetry(error instanceof Error ? error.message : String(error))
    }
  }

  private async open(target: ConnectionTarget, generation: number): Promise<void> {
    const probe = await probeDaemon(targetOrigin(target), this.deps)
    const wsUrl = await resolveWsUrl(target, probe, this.deps)

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
        botsActions().refresh()
      ])

      store.setDaemon(info)
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

    this.scheduleRetry('The connection to the daemon dropped.')
  }

  private handleUnauthorized(message: string): void {
    this.teardown()
    connectionActions().clearTarget()
    connectionActions().setStatus('unauthorized', { attempt: 0, error: message })
  }

  private scheduleRetry(error: string): void {
    this.attempt += 1

    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** (this.attempt - 1))

    connectionActions().setStatus(this.connectedAt ? 'reconnecting' : 'offline', {
      attempt: this.attempt,
      error
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

export function retryConnection(): Promise<void> {
  return getSupervisor().retryNow()
}
