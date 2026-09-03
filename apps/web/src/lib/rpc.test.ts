import { describe, expect, it } from 'vitest'

import { HexbotRpcClient } from './rpc'

class FakeWebSocket extends EventTarget {
  readonly sent: string[] = []
  readyState = WebSocket.CONNECTING

  constructor() {
    super()
    queueMicrotask(() => {
      this.readyState = WebSocket.OPEN
      this.dispatchEvent(new Event('open'))
    })
  }

  close(): void {
    this.readyState = WebSocket.CLOSED
    this.dispatchEvent(new CloseEvent('close'))
  }

  send(data: string): void {
    this.sent.push(data)
    const request = JSON.parse(data) as { id: string }

    queueMicrotask(() => {
      this.dispatchEvent(
        new MessageEvent('message', {
          data: JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { ok: true } })
        })
      )
    })
  }
}

describe('HexbotRpcClient', () => {
  it('uses the shared JSON-RPC request and response framing', async () => {
    const socket = new FakeWebSocket()
    const rpc = new HexbotRpcClient('ws://localhost:8000/api/ws', {
      heartbeatIntervalMs: 0,
      socketFactory: () => socket as WebSocket
    })

    await rpc.connect()
    await expect(rpc.call('hexbot.ping', { value: 1 })).resolves.toEqual({ ok: true })
    expect(JSON.parse(socket.sent[0] ?? '')).toEqual({
      jsonrpc: '2.0',
      id: 'r1',
      method: 'hexbot.ping',
      params: { value: 1 }
    })

    rpc.close()
  })
})
