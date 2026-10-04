import { ConnectionSupervisor, pairWithDaemon, probeDaemon, resolveWsUrl, setLocalDaemonPort, targetOrigin, UnauthorizedError } from './connection'

const response = (body: string, init: ResponseInit = {}) =>
  new Response(body, { status: 200, ...init })

describe('connection gate', () => {
  it('shares the handshake when the action and root start the same target', async () => {
    let rejectFetch!: (cause: Error) => void
    const fetch = vi.fn(() => new Promise<Response>((_resolve, reject) => { rejectFetch = reject }))
    const supervisor = new ConnectionSupervisor({ fetch })
    const target = { kind: 'local' as const }
    const action = supervisor.start(target)
    const root = supervisor.start(target)
    expect(root).toBe(action)
    expect(fetch).toHaveBeenCalledTimes(1)
    supervisor.stop()
    rejectFetch(new Error('test stopped'))
    await action
  })
  it('reports a reachable daemon without reading anything from its page', async () => {
    await expect(
      probeDaemon(window.location.origin, {
        fetch: vi.fn(async () => response('<html>Sign in</html>'))
      })
    ).resolves.toBeUndefined()
  })
  it('sends the required username when pairing a browser', async () => {
    const fetch = vi.fn(async () => response('{"ok":true,"ticket":"cookie"}'))
    await pairWithDaemon('127.0.0.1', 9119, 'ABCD-EFGH', 'My browser', {
      bridge: () => null, fetch
    })
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:9119/auth/password-login',
      expect.objectContaining({
        credentials: 'include',
        body: expect.stringContaining('"username":"My browser"')
      }))
  })
  it('resolves a bare local target to the page origin in a browser', () => {
    expect(targetOrigin({ kind: 'local' })).toBe(window.location.origin)
  })
  it('never resolves a bare local target to the page origin inside Electron', () => {
    window.hexbot = {} as Window['hexbot']

    try {
      expect(targetOrigin({ kind: 'local' })).toBe('http://127.0.0.1:9119')
      setLocalDaemonPort(9120)
      expect(targetOrigin({ kind: 'local' })).toBe('http://127.0.0.1:9120')
      setLocalDaemonPort(undefined)
      expect(targetOrigin({ kind: 'local' })).toBe('http://127.0.0.1:9120')
    } finally {
      delete window.hexbot
      setLocalDaemonPort(9119)
    }
  })
  it('uses TLS for Connect targets', () => {
    expect(
      targetOrigin({
        deviceToken: 'x',
        host: 'bot.connect.hexbot.app',
        kind: 'remote',
        port: 443,
        tls: true
      })
    ).toBe('https://bot.connect.hexbot.app')
  })
  it('never takes a credential from the page, even one claiming the gate is off', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith('/api/auth/ws-ticket')
        ? response('{"ticket":"short"}', { headers: { 'Content-Type': 'application/json' } })
        : response(
            '<script>window.__HERMES_AUTH_REQUIRED__ = false; window.__HERMES_SESSION_TOKEN__ = "session"</script>'
          )
    )

    await probeDaemon('http://box:9119', { fetch })

    const url = await resolveWsUrl(
      { kind: 'remote', host: 'box', port: 9119, deviceToken: 'device', tls: false },
      { fetch }
    )

    expect(url).toContain('ticket=short')
    expect(url).not.toContain('session')
  })
  it('mints a ticket with the device token', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith('/api/auth/ws-ticket')
        ? response('{"ticket":"short"}', { headers: { 'Content-Type': 'application/json' } })
        : response('window.__HERMES_AUTH_REQUIRED__ = true')
    )

    expect(
      await resolveWsUrl(
        { kind: 'remote', host: 'box', port: 9119, deviceToken: 'device', tls: false },
        { fetch }
      )
    ).toContain('ticket=short')
    expect(fetch).toHaveBeenLastCalledWith(
      'http://box:9119/api/auth/ws-ticket',
      expect.objectContaining({
        headers: { Authorization: 'Bearer device' }
      })
    )
  })
  it('mints a same-origin browser ticket with cookies and no bearer', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      response('{"ticket":"cookie-ticket"}', {
        headers: { 'Content-Type': 'application/json' }
      })
    )

    const url = await resolveWsUrl({ kind: 'local' }, { bridge: () => null, fetch })

    expect(url).toContain('ticket=cookie-ticket')
    expect(fetch).toHaveBeenCalledWith(
      `${window.location.origin}/api/auth/ws-ticket`,
      expect.objectContaining({ credentials: 'same-origin' })
    )
    expect(fetch.mock.calls[0]?.[1]).not.toHaveProperty('headers')
  })
  it('reports a revoked device', async () => {
    const fetch = vi.fn(async () => response('', { status: 401 }))
    await expect(
      resolveWsUrl(
        { kind: 'remote', host: 'box', port: 9119, deviceToken: 'revoked', tls: false },
        { fetch }
      )
    ).rejects.toBeInstanceOf(UnauthorizedError)
  })
})
