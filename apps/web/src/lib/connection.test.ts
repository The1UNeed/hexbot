import { probeDaemon, resolveWsUrl, targetOrigin, UnauthorizedError } from './connection'

const response = (body: string, init: ResponseInit = {}) =>
  new Response(body, { status: 200, ...init })

describe('connection gate', () => {
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
  it('uses the page token when the gate is off', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      response(
        '<script>window.__HERMES_AUTH_REQUIRED__ = false; window.__HERMES_SESSION_TOKEN__ = "session"</script>'
      )
    )

    const probe = await probeDaemon('http://box:9119', { fetch })
    expect(
      await resolveWsUrl(
        { kind: 'remote', host: 'box', port: 9119, deviceToken: 'device', tls: false },
        probe,
        { fetch }
      )
    ).toContain('token=session')
  })
  it('mints a ticket when the gate is on', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith('/api/auth/ws-ticket')
        ? response('{"ticket":"short"}', { headers: { 'Content-Type': 'application/json' } })
        : response('window.__HERMES_AUTH_REQUIRED__ = true')
    )

    const probe = await probeDaemon('http://box:9119', { fetch })
    expect(
      await resolveWsUrl(
        { kind: 'remote', host: 'box', port: 9119, deviceToken: 'device', tls: false },
        probe,
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

    const url = await resolveWsUrl(
      { kind: 'local' },
      { authRequired: true, reachable: true },
      { bridge: () => null, fetch }
    )

    expect(url).toContain('ticket=cookie-ticket')
    expect(fetch).toHaveBeenCalledWith(
      `${window.location.origin}/api/auth/ws-ticket`,
      expect.objectContaining({ credentials: 'include' })
    )
    expect(fetch.mock.calls[0]?.[1]).not.toHaveProperty('headers')
  })
  it('reports a revoked device', async () => {
    const fetch = vi.fn(async () => response('', { status: 401 }))
    await expect(
      resolveWsUrl(
        { kind: 'remote', host: 'box', port: 9119, deviceToken: 'revoked', tls: false },
        { authRequired: true, reachable: true },
        { fetch }
      )
    ).rejects.toBeInstanceOf(UnauthorizedError)
  })
})
