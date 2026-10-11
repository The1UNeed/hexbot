import { JsonRpcGatewayClient, type GatewayEvent } from '@hermes/shared'
import { openGateway, RevokedError } from './transport'
import type { SavedDaemon } from './types'
export type MobileConnectionState = 'connecting' | 'connected' | 'offline' | 'revoked'
/** One client per selected daemon. Retire it before switching to avoid cross-daemon events. */
export class MobileSession {
  readonly client = new JsonRpcGatewayClient({ requestIdPrefix: 'mobile', requestTimeoutMs: 30000 })
  private stopped = false
  private suspended = false
  private connecting = false
  private failures = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private connectedAt = 0
  constructor(
    readonly daemon: SavedDaemon,
    private token: string,
    private onState: (state: MobileConnectionState, error?: Error) => void,
    private onReady: () => Promise<void>,
    onEvent: (event: GatewayEvent) => void
  ) {
    this.client.onEvent(onEvent)
    this.client.onState(state => {
      if (!this.stopped && !this.connecting && (state === 'closed' || state === 'error'))
        this.schedule()
    })
  }
  async connect(): Promise<void> {
    this.suspended = false
    if (this.stopped || this.connecting) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.client.connectionState === 'open') {
      await this.onReady()
      return
    }
    this.connecting = true
    this.onState('connecting')
    try {
      await openGateway(this.client, this.daemon, this.token)
      if (this.stopped || this.suspended) {
        this.client.close()
        return
      }
      this.connectedAt = Date.now()
      await this.onReady()
      if (!this.stopped && !this.suspended) this.onState('connected')
    } catch (error) {
      this.client.close()
      if (this.stopped) return
      const failure = error instanceof Error ? error : new Error(String(error))
      if (error instanceof RevokedError) {
        this.onState('revoked', failure)
        this.stop()
        return
      }
      this.onState('offline', failure)
      this.schedule()
    } finally {
      this.connecting = false
    }
  }
  private schedule(): void {
    if (this.stopped || this.suspended || this.timer) return
    if (this.connectedAt && Date.now() - this.connectedAt > 30000) this.failures = 0
    this.onState('offline')
    const delay = Math.min(16000, 1000 * 2 ** this.failures++)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.connect()
    }, delay)
  }
  suspend(): void {
    this.suspended = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    // The daemon keeps running turns while the phone sleeps.
    this.client.close()
  }
  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.client.close()
  }
}
