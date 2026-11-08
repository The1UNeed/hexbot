import { IDBFactory } from 'fake-indexeddb'

import { useConnection } from '../stores/connection'

import { ConnectionSupervisor } from './connection'

class Socket extends EventTarget {
  readyState: number = WebSocket.CONNECTING

  open() {
    this.readyState = WebSocket.OPEN
    this.dispatchEvent(new Event('open'))
  }

  close(code?: number) {
    this.readyState = WebSocket.CLOSED
    this.dispatchEvent(new CloseEvent('close', { code: code ?? 1000 }))
  }
}

const target = { kind: 'local' as const, origin: window.location.origin }
let supervisor: ConnectionSupervisor

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  useConnection.getState().setTarget(target)
})

afterEach(() => {
  supervisor.stop()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function start(socketFactory: () => WebSocket) {
  supervisor = new ConnectionSupervisor({
    fetch: vi.fn(async url =>
      String(url).endsWith('/api/auth/ws-ticket')
        ? new Response('{"ticket":"t"}')
        : new Response('')
    ),
    socketFactory
  })

  return supervisor.start(target)
}

it('closes an opened socket when gateway.ready never arrives before retrying', async () => {
  const sockets: Socket[] = []

  const starting = start(() => {
    const socket = new Socket()
    sockets.push(socket)

    return socket as unknown as WebSocket
  })

  await vi.waitFor(() => expect(sockets).toHaveLength(1))
  sockets[0]!.open()
  await vi.advanceTimersByTimeAsync(15_000)
  await starting
  expect(sockets[0]!.readyState).toBe(WebSocket.CLOSED)
  expect(supervisor.rpc).toBeNull()
})

it('stop immediately closes a socket still waiting for its handshake', async () => {
  const socket = new Socket()
  const factory = vi.fn(() => socket as unknown as WebSocket)
  const starting = start(factory)

  await vi.waitFor(() => expect(factory).toHaveBeenCalledOnce())
  supervisor.stop()
  expect(socket.readyState).toBe(WebSocket.CLOSED)
  await starting
  expect(useConnection.getState().status).toBe('idle')
})

it('auth closure during the handshake clears the target without retrying', async () => {
  const socket = new Socket()
  const factory = vi.fn(() => socket as unknown as WebSocket)
  const starting = start(factory)

  await vi.waitFor(() => expect(factory).toHaveBeenCalledOnce())
  socket.open()
  socket.close(4401)
  await starting
  expect(useConnection.getState()).toMatchObject({ target: null, status: 'unauthorized' })
  await vi.advanceTimersByTimeAsync(30_000)
  expect(factory).toHaveBeenCalledOnce()
})

it('socket construction failure cancels the gateway.ready deadline', async () => {
  const factory = vi.fn(() => { throw new DOMException('Blocked', 'SecurityError') })
  await start(factory)
  supervisor.stop()
  await vi.advanceTimersByTimeAsync(30_000)
  expect(factory).toHaveBeenCalledOnce()
  expect(useConnection.getState().status).toBe('idle')
})
