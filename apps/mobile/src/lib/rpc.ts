import {
  type ConnectionState,
  type GatewayClientOptions,
  type GatewayEvent,
  type GatewayEventName,
  JsonRpcGatewayClient
} from '@hermes/shared'

export class HexbotRpcClient {
  private readonly client: JsonRpcGatewayClient

  constructor(
    private readonly wsUrl: string,
    options: GatewayClientOptions = {}
  ) {
    this.client = new JsonRpcGatewayClient(options)
  }

  get connectionState(): ConnectionState {
    return this.client.connectionState
  }

  get url(): string {
    return this.wsUrl
  }

  connect(): Promise<void> {
    return this.client.connect(this.wsUrl)
  }

  call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.client.request<T>(method, params)
  }

  subscribe<P = unknown>(
    type: GatewayEventName,
    handler: (event: GatewayEvent<P>) => void
  ): () => void {
    return this.client.on(type, handler)
  }

  onEvent(handler: (event: GatewayEvent) => void): () => void {
    return this.client.onEvent(handler)
  }

  onState(handler: (state: ConnectionState) => void): () => void {
    return this.client.onState(handler)
  }

  close(): void {
    this.client.close()
  }
}

let active: HexbotRpcClient | null = null

/**
 * The connection supervisor publishes the live client here; `lib/api.ts` and
 * the stores read it so they never need a React context or a prop drill.
 */
export class NotConnectedError extends Error {
  constructor(method: string) {
    super(`not connected to a Hexbot daemon (while calling ${method})`)
    this.name = 'NotConnectedError'
  }
}

const waiters: Array<(client: HexbotRpcClient) => void> = []

export function setActiveRpc(client: HexbotRpcClient | null): void {
  active = client

  if (client) {
    for (const resolve of waiters.splice(0)) {
      resolve(client)
    }
  }
}

/** How long a call waits for a connection before failing. */
export const CONNECT_WAIT_MS = 15_000

function waitForActive(timeoutMs: number): Promise<HexbotRpcClient> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const index = waiters.indexOf(onReady)

      if (index >= 0) {
        waiters.splice(index, 1)
      }

      reject(new NotConnectedError('(timed out waiting for a connection)'))
    }, timeoutMs)

    function onReady(client: HexbotRpcClient): void {
      clearTimeout(timer)
      resolve(client)
    }

    waiters.push(onReady)
  })
}

/** Call a method on the active connection. Rejects when there is none. */
export async function rpcCall<T>(
  method: string,
  params: Record<string, unknown> = {},
  waitMs = CONNECT_WAIT_MS
): Promise<T> {
  const client = active ?? (await waitForActive(waitMs).catch(() => null))

  if (!client) {
    throw new NotConnectedError(method)
  }

  return client.call<T>(method, params)
}
