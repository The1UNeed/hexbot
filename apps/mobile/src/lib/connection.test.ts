import {
  connectTo,
  getSupervisor,
  InvalidCodeError,
  pairWithDaemon,
  signOut,
  targetOrigin,
  UnauthorizedError,
  UnreachableError
} from './connection'
import { loadStoredTarget, useConnection } from '../stores/connection'
import { useBots } from '../stores/bots'
import { useSections } from '../stores/sections'
import { useRooms } from '../stores/rooms'
import { useSettings } from '../stores/settings'
import { useUsers } from '../stores/users'
import { useConnectors } from '../stores/connectors'
import { useDrafts } from '../stores/drafts'
import { useUi } from '../stores/ui'
import { useTranscripts } from '../stores/transcripts'
import { resetRpcScope, rpcCall, setActiveRpc } from './rpc'
import { useNotice } from './notify'

function reply(status: number, body: unknown = {}) {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    status
  })
}

describe('targetOrigin', () => {
  it('drops default ports and brackets IPv6 hosts', () => {
    expect(targetOrigin({ host: '192.168.1.5', port: 9119, tls: false })).toBe(
      'http://192.168.1.5:9119'
    )
    expect(targetOrigin({ host: 'hexbot.example', port: 443, tls: true })).toBe(
      'https://hexbot.example'
    )
    expect(targetOrigin({ host: 'fd7a:115c::1', port: 9119, tls: false })).toBe(
      'http://[fd7a:115c::1]:9119'
    )
  })
})

describe('pairWithDaemon', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('posts the code to /hexbot/pair and returns a remote target', async () => {
    const fetch = vi.fn(async () =>
      reply(200, { daemon_name: 'Studio', device_id: 'd1', device_token: 'hxb_t' })
    )
    vi.stubGlobal('fetch', fetch)

    const result = await pairWithDaemon({
      code: ' abcd-1234 ',
      deviceName: 'iPhone',
      host: '10.0.0.2',
      port: 9119
    })

    expect(result).toEqual({
      daemonName: 'Studio',
      target: { deviceToken: 'hxb_t', host: '10.0.0.2', kind: 'remote', port: 9119, tls: false }
    })
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://10.0.0.2:9119/hexbot/pair')
    expect(JSON.parse(String(init.body))).toEqual({
      code: 'ABCD-1234',
      device_name: 'iPhone',
      platform: 'ios'
    })
  })

  it('names a bad code, a rate limit, and an unreachable daemon', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => reply(401, { code: 4231 }))
    )
    await expect(
      pairWithDaemon({ code: 'NOPE-NOPE', deviceName: 'p', host: 'h', port: 1 })
    ).rejects.toBeInstanceOf(InvalidCodeError)

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => reply(429))
    )
    await expect(
      pairWithDaemon({ code: 'NOPE-NOPE', deviceName: 'p', host: 'h', port: 1 })
    ).rejects.toThrow('Too many attempts')

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError('Network request failed')))
    )
    await expect(
      pairWithDaemon({ code: 'NOPE-NOPE', deviceName: 'p', host: 'h', port: 1 })
    ).rejects.toBeInstanceOf(UnreachableError)
  })
})

describe('supervisor', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    signOut()
  })

  it('clears the saved target when the daemon revokes the token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => reply(401))
    )
    const { connectTo } = await import('./connection')
    const target = {
      deviceToken: 'hxb_old',
      host: 'h',
      kind: 'remote' as const,
      port: 1,
      tls: false
    }

    await connectTo(target)

    expect(useConnection.getState().status).toBe('unauthorized')
    expect(useConnection.getState().target).toBeNull()
    expect(await loadStoredTarget()).toBeNull()
  })

  it('keeps the target and retries when the daemon is offline', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError('Network request failed')))
    )
    const { connectTo } = await import('./connection')
    const target = {
      deviceToken: 'hxb_ok',
      host: 'h',
      kind: 'remote' as const,
      port: 1,
      tls: false
    }

    await connectTo(target)

    expect(useConnection.getState()).toMatchObject({ attempt: 1, status: 'offline', target })
    vi.useRealTimers()
  })

  it('UnauthorizedError is distinct from an unreachable daemon', () => {
    expect(new UnauthorizedError()).not.toBeInstanceOf(UnreachableError)
  })
})

/** Exercises the real shared RPC client, including replay requests and routing. */
class FakeSocket extends EventTarget {
  static OPEN = 1
  static instances: FakeSocket[] = []
  static ready = true
  static epoch = 'epoch-a'
  static replay: unknown[] = []
  readyState = 0
  requests: { id: string; method: string; params: Record<string, unknown> }[] = []
  constructor(readonly url: string) {
    super()
    FakeSocket.instances.push(this)
    queueMicrotask(() => {
      if (this.readyState === 3) return
      this.readyState = 1
      this.dispatchEvent(new Event('open'))
      if (FakeSocket.ready) this.event('gateway.ready', { replay_epoch: FakeSocket.epoch })
    })
  }
  send(data: string) {
    const request = JSON.parse(data)
    this.requests.push(request)
    const result =
      request.method === 'session.events.since'
        ? { events: FakeSocket.replay, epoch: FakeSocket.epoch }
        : request.method === 'hexbot.info'
          ? { install_id: 'daemon-a' }
          : request.method === 'hexbot.bots.list'
            ? { bots: [] }
            : request.method === 'hexbot.rooms.list'
              ? { rooms: [] }
              : request.method === 'hexbot.users.me'
                ? { id: 'local', role: 'admin' }
                : request.method === 'hexbot.users.list'
                  ? { users: [] }
                  : {}
    queueMicrotask(() => this.frame({ jsonrpc: '2.0', id: request.id, result }))
  }
  frame(frame: unknown) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) }))
  }
  event(type: string, payload: unknown, session_id?: string, seq?: number) {
    this.frame({ jsonrpc: '2.0', method: 'event', params: { type, payload, session_id, seq } })
  }
  close(code = 1006) {
    this.readyState = 3
    this.dispatchEvent(Object.assign(new Event('close'), { code }))
  }
}

const target = {
  deviceToken: 'test-device',
  host: 'daemon-a',
  kind: 'remote' as const,
  port: 9119,
  tls: false
}

describe('mobile reconnect and daemon isolation', () => {
  beforeEach(() => {
    signOut()
    FakeSocket.instances = []
    FakeSocket.ready = true
    FakeSocket.epoch = 'epoch-a'
    FakeSocket.replay = []
    vi.stubGlobal('WebSocket', FakeSocket)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => reply(200, { ticket: 'one-use-ticket' }))
    )
  })
  afterEach(() => {
    signOut()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('replays a reply completed offline and clears the streaming state', async () => {
    await connectTo(target)
    const first = FakeSocket.instances[0]!
    first.event('message.start', {}, 'live', 1)
    first.event('message.delta', { text: 'Before ' }, 'live', 2)
    expect(useTranscripts.getState().bySession.live?.streamingMessageId).toBeTruthy()
    first.close()
    FakeSocket.replay = [
      { type: 'message.delta', payload: { text: 'after' }, session_id: 'live', seq: 3 },
      { type: 'message.complete', payload: { text: 'Before after' }, session_id: 'live', seq: 4 }
    ]
    await getSupervisor().retryNow()
    await vi.waitFor(() =>
      expect(useTranscripts.getState().bySession.live?.streamingMessageId).toBeNull()
    )
    expect(FakeSocket.instances[1]?.requests).toContainEqual(
      expect.objectContaining({
        method: 'session.events.since',
        params: { session_id: 'live', last_seen: 2 }
      })
    )
    expect(useTranscripts.getState().bySession.live?.messages[0]?.text).toBe('Before after')
  })

  it('routes replay and new events that arrive before gateway.ready', async () => {
    await connectTo(target)
    const first = FakeSocket.instances[0]!
    first.event('message.start', {}, 'live', 1)
    first.close()
    FakeSocket.ready = false
    FakeSocket.replay = [
      { type: 'message.delta', payload: { text: 'Replayed' }, session_id: 'live', seq: 2 }
    ]
    const reconnecting = getSupervisor().retryNow()
    await vi.waitFor(() =>
      expect(useTranscripts.getState().bySession.live?.messages[0]?.text).toBe('Replayed')
    )
    const second = FakeSocket.instances[1]!
    second.event('message.start', {}, 'new-live', 1)
    second.event('message.delta', { text: 'Early' }, 'new-live', 2)
    second.event('gateway.ready', { replay_epoch: FakeSocket.epoch })
    await reconnecting
    expect(useTranscripts.getState().bySession['new-live']?.messages[0]?.text).toBe('Early')
  })

  it('clears stale sessions when the daemon restarts', async () => {
    await connectTo(target)
    const first = FakeSocket.instances[0]!
    first.event('message.start', {}, 'live', 1)
    useSections.setState({ liveSessionId: { section: 'live' } })
    first.close()
    FakeSocket.epoch = 'epoch-b'
    await getSupervisor().retryNow()
    expect(useSections.getState().liveSessionId).toEqual({})
    expect(useTranscripts.getState().bySession.live).toBeUndefined()
  })

  it('closes a timed-out handshake and retries without keeping its socket', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    FakeSocket.ready = false
    const opening = connectTo(target)
    await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1))
    await vi.advanceTimersByTimeAsync(15000)
    await opening
    expect(FakeSocket.instances[0]?.readyState).toBe(3)
    expect(getSupervisor().rpc).toBeNull()
    expect(useConnection.getState().status).toBe('offline')
  })

  it('shares concurrent reconnect attempts', async () => {
    await connectTo(target)
    FakeSocket.instances[0]!.close()
    const first = getSupervisor().retryNow()
    const second = getSupervisor().retryNow()
    await Promise.all([first, second])
    expect(FakeSocket.instances).toHaveLength(2)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('drops every cached daemon record and draft when switching', async () => {
    await connectTo(target)
    useBots.setState({ byName: { ada: { name: 'ada' } as never }, order: ['ada'] })
    useSections.setState({
      byId: { section: { id: 'section' } as never },
      idsByBot: { ada: ['section'] },
      liveSessionId: { section: 'live' }
    })
    useRooms.setState({
      byId: { room: { id: 'room' } as never },
      eventsByRoom: { room: [] },
      liveTurnsByRoom: { room: {} },
      order: ['room']
    })
    useSettings.setState({
      settings: { approval_mode: 'manual' } as never,
      providers: [{ id: 'provider' } as never],
      devices: [{ id: 'device' } as never],
      models: { all: [{ id: 'model' } as never], curated: [] }
    })
    useUsers.setState({
      current: { id: 'old-user' } as never,
      users: [{ id: 'old-user' } as never]
    })
    useConnectors.setState({ byBot: { ada: [{ id: 'connector' } as never] } })
    useDrafts.getState().set('section', 'Private draft')
    useUi.getState().setLastSection({ bot: 'ada', section: 'section', daemon: 'daemon-a' })
    FakeSocket.instances[0]!.event('message.start', {}, 'live', 1)
    useNotice.setState({ notice: { id: 1, title: 'Old', body: 'Private' } })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError('Offline')))
    )
    await connectTo({ ...target, host: 'daemon-b' })
    expect(useBots.getState().byName).toEqual({})
    expect(useSections.getState().byId).toEqual({})
    expect(useRooms.getState().eventsByRoom).toEqual({})
    expect(useRooms.getState().liveTurnsByRoom).toEqual({})
    expect(useSettings.getState()).toMatchObject({
      settings: null,
      providers: [],
      devices: [],
      models: { all: [], curated: [] }
    })
    expect(useUsers.getState()).toMatchObject({ current: null, users: [] })
    expect(useConnectors.getState().byBot).toEqual({})
    expect(useDrafts.getState().byId).toEqual({})
    expect(useUi.getState().lastSection).toBeNull()
    expect(useTranscripts.getState().bySession).toEqual({})
    expect(useNotice.getState().notice).toBeNull()
    expect(useConnection.getState()).toMatchObject({ daemon: null, epoch: null })
    expect(await loadStoredTarget()).toMatchObject({ host: 'daemon-b' })
  })

  it('rejects old in-flight and queued RPCs across a daemon switch', async () => {
    let resolve!: (value: unknown) => void
    setActiveRpc({
      call: () =>
        new Promise(done => {
          resolve = done
        })
    } as never)
    const pending = rpcCall('old-read')
    resetRpcScope()
    resolve({ private: 'old daemon' })
    await expect(pending).rejects.toThrow('not connected')
    const queued = rpcCall('old-write')
    resetRpcScope()
    const call = vi.fn().mockResolvedValue({})
    setActiveRpc({ call } as never)
    await expect(queued).rejects.toThrow('not connected')
    expect(call).not.toHaveBeenCalled()
  })
})
