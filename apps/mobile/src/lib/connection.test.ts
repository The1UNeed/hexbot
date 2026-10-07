import { InvalidCodeError, pairWithDaemon, signOut, targetOrigin, UnauthorizedError, UnreachableError } from './connection'
import { loadStoredTarget, useConnection } from '../stores/connection'

function reply(status: number, body: unknown = {}) {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' }, status })
}

describe('targetOrigin', () => {
  it('drops default ports and brackets IPv6 hosts', () => {
    expect(targetOrigin({ host: '192.168.1.5', port: 9119, tls: false })).toBe('http://192.168.1.5:9119')
    expect(targetOrigin({ host: 'hexbot.example', port: 443, tls: true })).toBe('https://hexbot.example')
    expect(targetOrigin({ host: 'fd7a:115c::1', port: 9119, tls: false })).toBe('http://[fd7a:115c::1]:9119')
  })
})

describe('pairWithDaemon', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('posts the code to /hexbot/pair and returns a remote target', async () => {
    const fetch = vi.fn(async () => reply(200, { daemon_name: 'Studio', device_id: 'd1', device_token: 'hxb_t' }))
    vi.stubGlobal('fetch', fetch)

    const result = await pairWithDaemon({ code: ' abcd-1234 ', deviceName: 'iPhone', host: '10.0.0.2', port: 9119 })

    expect(result).toEqual({
      daemonName: 'Studio',
      target: { deviceToken: 'hxb_t', host: '10.0.0.2', kind: 'remote', port: 9119, tls: false }
    })
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://10.0.0.2:9119/hexbot/pair')
    expect(JSON.parse(String(init.body))).toEqual({ code: 'ABCD-1234', device_name: 'iPhone', platform: 'ios' })
  })

  it('names a bad code, a rate limit, and an unreachable daemon', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply(401, { code: 4231 })))
    await expect(pairWithDaemon({ code: 'NOPE-NOPE', deviceName: 'p', host: 'h', port: 1 })).rejects.toBeInstanceOf(InvalidCodeError)

    vi.stubGlobal('fetch', vi.fn(async () => reply(429)))
    await expect(pairWithDaemon({ code: 'NOPE-NOPE', deviceName: 'p', host: 'h', port: 1 })).rejects.toThrow('Too many attempts')

    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Network request failed'))))
    await expect(pairWithDaemon({ code: 'NOPE-NOPE', deviceName: 'p', host: 'h', port: 1 })).rejects.toBeInstanceOf(UnreachableError)
  })
})

describe('supervisor', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    signOut()
  })

  it('clears the saved target when the daemon revokes the token', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply(401)))
    const { connectTo } = await import('./connection')
    const target = { deviceToken: 'hxb_old', host: 'h', kind: 'remote' as const, port: 1, tls: false }

    await connectTo(target)

    expect(useConnection.getState().status).toBe('unauthorized')
    expect(useConnection.getState().target).toBeNull()
    expect(await loadStoredTarget()).toBeNull()
  })

  it('keeps the target and retries when the daemon is offline', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Network request failed'))))
    const { connectTo } = await import('./connection')
    const target = { deviceToken: 'hxb_ok', host: 'h', kind: 'remote' as const, port: 1, tls: false }

    await connectTo(target)

    expect(useConnection.getState()).toMatchObject({ attempt: 1, status: 'offline', target })
    vi.useRealTimers()
  })

  it('UnauthorizedError is distinct from an unreachable daemon', () => {
    expect(new UnauthorizedError()).not.toBeInstanceOf(UnreachableError)
  })
})
