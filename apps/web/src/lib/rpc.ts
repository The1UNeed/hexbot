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

  connect(): Promise<void> {
    return this.client.connect(this.wsUrl)
  }

  call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.client.request<T>(method, params)
  }

  subscribe<P = unknown>(type: GatewayEventName, handler: (event: GatewayEvent<P>) => void): () => void {
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
