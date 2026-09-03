import { probeDaemon, resolveWsUrl, UnauthorizedError } from './connection'

const response = (body: string, init: ResponseInit = {}) =>
  new Response(body, { status: 200, ...init })

describe('connection gate', () => {
  it('uses the page token when the gate is off', async () => {
    const fetch = vi.fn(async () =>
      response(
        '<script>window.__HERMES_AUTH_REQUIRED__ = false; window.__HERMES_SESSION_TOKEN__ = "session"</script>'
      )
    )

    const probe = await probeDaemon('http://box:9119', { fetch })
    expect(
      await resolveWsUrl(
        { kind: 'remote', host: 'box', port: 9119, deviceToken: 'device' },
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
        { kind: 'remote', host: 'box', port: 9119, deviceToken: 'device' },
        probe,
        { fetch }
      )
    ).toContain('ticket=short')
  })
  it('reports a revoked device', async () => {
    const fetch = vi.fn(async () => response('', { status: 401 }))
    await expect(
      resolveWsUrl(
        { kind: 'remote', host: 'box', port: 9119, deviceToken: 'revoked' },
        { authRequired: true, reachable: true },
        { fetch }
      )
    ).rejects.toBeInstanceOf(UnauthorizedError)
  })
})
