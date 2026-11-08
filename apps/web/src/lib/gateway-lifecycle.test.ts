import { JsonRpcGatewayClient } from '@hermes/shared'

class Socket extends EventTarget {
  readyState: number = WebSocket.CONNECTING

  close() {
    this.readyState = WebSocket.CLOSED
    this.dispatchEvent(new CloseEvent('close'))
  }
}

afterEach(() => vi.useRealTimers())

it('can retry after the browser refuses to construct a socket', async () => {
  const socket = new Socket()

  const factory = vi.fn()
    .mockImplementationOnce(() => { throw new DOMException('Blocked', 'SecurityError') })
    .mockReturnValue(socket)

  const client = new JsonRpcGatewayClient({ socketFactory: factory })

  await expect(client.connect('ws://daemon.test')).rejects.toThrow('Blocked')
  expect(client.connectionState).toBe('error')
  const retried = client.connect('ws://daemon.test')
  socket.readyState = WebSocket.OPEN
  socket.dispatchEvent(new Event('open'))
  await retried
  expect(factory).toHaveBeenCalledTimes(2)
  expect(client.connectionState).toBe('open')
  client.close()
})

it.each(['close', 'invalidate', 'server close'] as const)(
  'settles a connecting socket immediately on %s even with no handshake deadline',
  async action => {
    vi.useFakeTimers()
    const socket = new Socket()

    const client = new JsonRpcGatewayClient({
      connectTimeoutMs: 0,
      socketFactory: () => socket as unknown as WebSocket
    })

    const result = vi.fn()

    const connecting = client.connect('ws://daemon.test').then(
      () => result('open'),
      () => result('closed')
    )

    if (action === 'server close') {socket.close()}
    else {client[action]()}

    await Promise.resolve()
    await Promise.resolve()
    expect(result).toHaveBeenCalledWith('closed')
    await connecting
    expect(client.connectionState).toBe('closed')
  }
)
