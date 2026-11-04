import { IDBFactory } from 'fake-indexeddb'

import { ConnectionSupervisor } from './connection'
import * as events from './events'

/** A daemon socket that opens, says gateway.ready, and answers every request. */
class FakeSocket extends EventTarget {
  readyState: number = WebSocket.CONNECTING
  /** Leaves requests unanswered, so hydration waits. */
  silent = false

  constructor() {
    super()
    queueMicrotask(() => {
      this.readyState = WebSocket.OPEN
      this.dispatchEvent(new Event('open'))
      this.frame({
        method: 'event',
        params: { type: 'gateway.ready', payload: { replay_epoch: 'e' } }
      })
    })
  }

  frame(body: Record<string, unknown>) {
    this.dispatchEvent(
      new MessageEvent('message', { data: JSON.stringify({ jsonrpc: '2.0', ...body }) })
    )
  }

  close() {
    if (this.readyState === WebSocket.CLOSED) {
      return
    }

    this.readyState = WebSocket.CLOSED
    this.dispatchEvent(new CloseEvent('close'))
  }

  send(data: string) {
    if (this.silent) {
      return
    }

    const { id } = JSON.parse(data) as { id: string }
    queueMicrotask(() => this.frame({ id, result: {} }))
  }
}

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it('Reconnect now during a slow handshake leaves one socket routing events', async () => {
  const attach = vi.spyOn(events, 'attachEventRouting')
  const sockets: FakeSocket[] = []
  const held: (() => void)[] = []

  // The ticket answers only when released, like a slow Connect tunnel.
  const fetch = vi.fn<typeof globalThis.fetch>(async url =>
    String(url).endsWith('/api/auth/ws-ticket')
      ? new Promise<Response>(resolve => held.push(() => resolve(new Response('{"ticket":"t"}'))))
      : new Response('')
  )

  const supervisor = new ConnectionSupervisor({
    fetch,
    socketFactory: () => {
      const socket = new FakeSocket()
      sockets.push(socket)

      return socket as unknown as WebSocket
    }
  })

  const target = {
    kind: 'remote' as const,
    host: 'daemon.test',
    port: 443,
    tls: true,
    deviceToken: 'token'
  }

  const first = supervisor.start(target)
  await vi.waitFor(() => expect(held).toHaveLength(1))
  const second = supervisor.retryNow()
  // Let a second attempt, if one started, reach its own ticket.
  await new Promise(resolve => setTimeout(resolve, 50))

  for (const release of held.splice(0)) {
    release()
  }

  await Promise.all([first, second])

  const open = sockets.filter(socket => socket.readyState === WebSocket.OPEN)
  const routed = attach.mock.results.length

  supervisor.stop()
  expect(open).toHaveLength(1)
  expect(routed).toBe(1)
})

it('Reconnect now while connected keeps the open socket and opens no other', async () => {
  const attach = vi.spyOn(events, 'attachEventRouting')
  const sockets: FakeSocket[] = []

  const fetch = vi.fn<typeof globalThis.fetch>(async url =>
    String(url).endsWith('/api/auth/ws-ticket') ? new Response('{"ticket":"t"}') : new Response('')
  )

  const supervisor = new ConnectionSupervisor({
    fetch,
    socketFactory: () => {
      const socket = new FakeSocket()
      sockets.push(socket)

      return socket as unknown as WebSocket
    }
  })

  await supervisor.start({
    kind: 'remote',
    host: 'daemon.test',
    port: 443,
    tls: true,
    deviceToken: 'token'
  })
  await supervisor.retryNow()

  const count = sockets.length
  const open = sockets.filter(socket => socket.readyState === WebSocket.OPEN)
  const routed = attach.mock.results.length

  supervisor.stop()
  expect(count).toBe(1)
  expect(open).toHaveLength(1)
  expect(routed).toBe(1)
})

it('Reconnect now after a handshake that never answers tries again', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

  try {
    const sockets: FakeSocket[] = []
    let tickets = 0

    // The first ticket request never settles; later ones answer.
    const fetch = vi.fn<typeof globalThis.fetch>(async url => {
      if (!String(url).endsWith('/api/auth/ws-ticket')) {
        return new Response('')
      }

      tickets += 1

      return tickets === 1 ? new Promise<Response>(() => {}) : new Response('{"ticket":"t"}')
    })

    const supervisor = new ConnectionSupervisor({
      fetch,
      socketFactory: () => {
        const socket = new FakeSocket()
        sockets.push(socket)

        return socket as unknown as WebSocket
      }
    })

    const first = supervisor.start({
      kind: 'remote',
      host: 'daemon.test',
      port: 443,
      tls: true,
      deviceToken: 'token'
    })

    await vi.waitFor(() => expect(tickets).toBe(1))
    await vi.advanceTimersByTimeAsync(15_000)
    await first
    await supervisor.retryNow()

    const open = sockets.filter(socket => socket.readyState === WebSocket.OPEN)

    supervisor.stop()
    expect(tickets).toBe(2)
    expect(open).toHaveLength(1)
  } finally {
    vi.useRealTimers()
  }
})

it('a socket that drops while the chat list loads can reconnect', async () => {
  const sockets: FakeSocket[] = []

  const fetch = vi.fn<typeof globalThis.fetch>(async url =>
    String(url).endsWith('/api/auth/ws-ticket') ? new Response('{"ticket":"t"}') : new Response('')
  )

  const supervisor = new ConnectionSupervisor({
    fetch,
    socketFactory: () => {
      const socket = new FakeSocket()
      socket.silent = sockets.length === 0
      sockets.push(socket)

      return socket as unknown as WebSocket
    }
  })

  const first = supervisor.start({
    kind: 'remote',
    host: 'daemon.test',
    port: 443,
    tls: true,
    deviceToken: 'token'
  })

  await vi.waitFor(() => expect(supervisor.rpc).not.toBeNull())
  sockets[0]!.close()
  await supervisor.retryNow()
  await first

  const open = sockets.filter(socket => socket.readyState === WebSocket.OPEN)

  supervisor.stop()
  expect(sockets).toHaveLength(2)
  expect(open).toHaveLength(1)
})
