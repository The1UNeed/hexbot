import { afterEach, describe, expect, it, vi } from 'vitest'
import { cookieValue, pairWithGrant } from './pair'

afterEach(() => vi.unstubAllGlobals())

describe('pair cookie parsing', () => {
  it('reads the device token from separate set-cookie headers', () => {
    const headers = new Headers()
    headers.append('set-cookie', 'hermes_session_at=device-token; HttpOnly; Path=/')
    headers.append('set-cookie', 'other=value; Path=/')
    expect(cookieValue(headers, 'hermes_session_at')).toBe('device-token')
  })

  it('redeems a Connect grant and verifies the returned cookie token', async () => {
    const loginHeaders = new Headers()
    loginHeaders.append('set-cookie', 'hermes_session_at=hxb_device; HttpOnly; Path=/')
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{}', { status: 200, headers: loginHeaders }))
      .mockResolvedValueOnce(new Response('{"ticket":"once"}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      pairWithGrant({ host: 'daemon.test', grant: 'signed.jwt', deviceName: 'Laptop' })
    ).resolves.toBe('hxb_device')
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://daemon.test/auth/password-login',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          provider: 'hexbot',
          username: 'Laptop',
          password: 'cg_signed.jwt'
        })
      })
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://daemon.test/api/auth/ws-ticket',
      expect.objectContaining({ headers: { authorization: 'Bearer hxb_device' } })
    )
  })

  it('reads a __Host- prefixed session cookie set over HTTPS', async () => {
    const loginHeaders = new Headers()
    loginHeaders.append(
      'set-cookie',
      '__Host-hermes_session_at=hxb_secure; Secure; HttpOnly; Path=/'
    )
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{}', { status: 200, headers: loginHeaders }))
      .mockResolvedValueOnce(new Response('{"ticket":"once"}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      pairWithGrant({ host: 'daemon.test', grant: 'signed.jwt', deviceName: 'Laptop' })
    ).resolves.toBe('hxb_secure')
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://daemon.test/api/auth/ws-ticket',
      expect.objectContaining({ headers: { authorization: 'Bearer hxb_secure' } })
    )
  })
})
