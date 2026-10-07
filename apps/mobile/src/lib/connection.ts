/**
 * The phone's daemon connection. Pairing exchanges a one-time code for a
 * long-lived device token (`POST /hexbot/pair`); every connection then mints
 * a single-use ticket (`POST /api/auth/ws-ticket`) and opens `/api/ws`.
 * Reconnects back off from 1 s to 16 s, forever, and reset after 30 s of a
 * stable connection (docs/client-architecture.md).
 */

import { buildHermesWebSocketUrl, readDeviceProofError } from '@hermes/shared'
import { Platform } from 'react-native'

import { botsActions } from '../stores/bots'
import { connectionActions, type RemoteTarget } from '../stores/connection'
import { useRooms } from '../stores/rooms'
import { sectionsActions } from '../stores/sections'
import { settingsActions } from '../stores/settings'
import { uiActions } from '../stores/ui'
import { useUsers } from '../stores/users'

import { attachEventRouting } from './events'
import { HexbotRpcClient, setActiveRpc } from './rpc'
import type { DaemonInfo } from './types'

export const BACKOFF_MIN_MS = 1_000
export const BACKOFF_MAX_MS = 16_000
export const STABLE_RESET_MS = 30_000
const READY_TIMEOUT_MS = 15_000
const HTTP_TIMEOUT_MS = 8_000

export class UnauthorizedError extends Error {
  constructor(message = 'This phone is not paired with the daemon.') {
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

interface ReadyPayload {
  replay_epoch?: string
}

export function targetOrigin(target: Pick<RemoteTarget, 'host' | 'port' | 'tls'>): string {
  const host = target.host.includes(':') && !target.host.startsWith('[') ? `[${target.host}]` : target.host
  const defaultPort = target.tls ? 443 : 80

  return `${target.tls ? 'https' : 'http'}://${host}${target.port === defaultPort ? '' : `:${target.port}`}`
}

async function timedFetch(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS)

  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } catch (error) {
    throw new UnreachableError(
      controller.signal.aborted ? 'The daemon did not answer in time.' : 'Could not reach the daemon at that address.'
    )
  } finally {
    clearTimeout(timer)
  }
}

async function mintTicket(target: RemoteTarget): Promise<string> {
  const response = await timedFetch(`${targetOrigin(target)}/api/auth/ws-ticket`, {
    headers: { Authorization: `Bearer ${target.deviceToken}` },
    method: 'POST'
  })

  const proofError = await readDeviceProofError(response)

  if (proofError) {
    // This phone never binds a key, so any proof error means the token was
    // bound elsewhere: pair again.
    throw new UnauthorizedError(proofError.message)
  }

  if (response.status === 401) {
    throw new UnauthorizedError('This phone was signed out by the daemon. Pair it again.')
  }

  if (!response.ok) {
    throw new UnreachableError(`The daemon refused a connection (HTTP ${response.status}).`)
  }

  const body = (await response.json()) as { ticket?: string }

  if (!body.ticket) {
    throw new UnreachableError('The daemon returned an empty ticket.')
  }

  return body.ticket
}

async function resolveWsUrl(target: RemoteTarget): Promise<string> {
  const origin = new URL(targetOrigin(target))
  const ticket = await mintTicket(target)

  return buildHermesWebSocketUrl({
    authParam: ['ticket', ticket],
    host: origin.host,
    path: '/api/ws',
    protocol: origin.protocol
  })
}

/** Exchange a pairing code for a device token. */
export async function pairWithDaemon(input: {
  code: string
  deviceName: string
  host: string
  port: number
  tls?: boolean
}): Promise<{ daemonName: string; target: RemoteTarget }> {
  const tls = input.tls ?? input.port === 443
  const origin = targetOrigin({ host: input.host, port: input.port, tls })
  const response = await timedFetch(`${origin}/hexbot/pair`, {
    body: JSON.stringify({
      code: input.code.trim().toUpperCase(),
      device_name: input.deviceName,
      platform: Platform.OS
    }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST'
  })

  if (response.status === 400 || response.status === 401 || response.status === 404) {
    throw new InvalidCodeError()
  }

  if (response.status === 429) {
    throw new InvalidCodeError('Too many attempts. Wait a minute and try again.')
  }

  if (!response.ok) {
    throw new UnreachableError(`Pairing failed (HTTP ${response.status}).`)
  }

  const body = (await response.json()) as { daemon_name?: string; device_token?: string }

  if (!body.device_token) {
    throw new UnreachableError('The daemon did not return a device token.')
  }

  return {
    daemonName: body.daemon_name ?? input.host,
    target: { deviceToken: body.device_token, host: input.host, kind: 'remote', port: input.port, tls }
  }
}

export function pairingErrorMessage(reason: unknown): string {
  if (reason instanceof InvalidCodeError || reason instanceof UnreachableError || reason instanceof UnauthorizedError) {
    return reason.message
  }

  return 'The daemon could not be reached.'
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
  private target: null | RemoteTarget = null

  get rpc(): HexbotRpcClient | null {
    return this.client
  }

  start(target: RemoteTarget): Promise<void> {
    if (!this.stopped && this.target === target) {
      return Promise.resolve()
    }

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
    this.target = null
    connectionActions().setStatus('idle', { attempt: 0, error: null })
  }

  /** Drop the backoff and try again now ("Reconnect now", app foreground). */
  retryNow(): Promise<void> {
    if (!this.target || this.client) {
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

  /** The socket may have died while iOS suspended the app; check it. */
  resume(): void {
    if (!this.target) {
      return
    }

    if (!this.client || this.client.connectionState !== 'open') {
      this.client?.close()
      void this.retryNow()

      return
    }

    void this.client.call('gateway.ping', {}).catch(() => {
      this.client?.close()
    })
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

    connectionActions().setStatus(this.connectedAt ? 'reconnecting' : 'connecting', { attempt: this.attempt })

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

      this.scheduleRetry(error instanceof Error ? error.message : null)
    }
  }

  private async open(target: RemoteTarget, generation: number): Promise<void> {
    const wsUrl = await resolveWsUrl(target)

    if (generation !== this.generation) {
      return
    }

    const client = new HexbotRpcClient(wsUrl, {
      onSocketClose: event => {
        // 4401/4403 are the gateway's auth close codes.
        if (event.code === 4401 || event.code === 4403) {
          this.revoked = true
        }

        return false
      }
    })

    const ready = new Promise<ReadyPayload>((resolve, reject) => {
      const timer = setTimeout(() => {
        off()
        reject(new UnreachableError('The daemon did not finish connecting.'))
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

  /** A new replay epoch means the daemon restarted; reopen sections lazily. */
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

      const last = uiActions().lastSection

      if (last?.daemon && info?.install_id && last.daemon !== info.install_id) {
        uiActions().setLastSection(null)
      }
    } catch (error) {
      store.setStatus('connected', { error: error instanceof Error ? error.message : String(error) })
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
      this.handleUnauthorized('This phone was signed out by the daemon. Pair it again.')

      return
    }

    if (this.connectedAt && Date.now() - this.connectedAt >= STABLE_RESET_MS) {
      this.attempt = 0
    }

    this.scheduleRetry(null)
  }

  private handleUnauthorized(message: string): void {
    this.teardown()
    this.target = null
    connectionActions().clearTarget()
    connectionActions().setStatus('unauthorized', { attempt: 0, error: message })
  }

  private scheduleRetry(error: null | string): void {
    this.attempt += 1

    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** (this.attempt - 1))

    connectionActions().setStatus(this.connectedAt ? 'reconnecting' : 'offline', { attempt: this.attempt, error })

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

/** Save the target and connect to it. */
export function connectTo(target: RemoteTarget): Promise<void> {
  connectionActions().setTarget(target)

  return getSupervisor().start(target)
}

/** Forget this daemon on this phone. */
export function signOut(): void {
  getSupervisor().stop()
  connectionActions().clearTarget()
}

/**
 * Leave this daemon for good: revoke this phone's device first (best effort,
 * so the daemon's Paired devices list does not collect stale phones), then
 * forget it here.
 */
export async function forgetDaemon(): Promise<void> {
  const rpc = getSupervisor().rpc

  if (rpc) {
    try {
      const { devices } = await rpc.call<{ devices: { current?: boolean; id: string }[] }>('hexbot.devices.list')
      const current = devices.find(device => device.current)

      if (current) {
        await rpc.call('hexbot.devices.revoke', { id: current.id })
      }
    } catch {
      // Offline or refused: the phone still forgets the daemon.
    }
  }

  signOut()
}
