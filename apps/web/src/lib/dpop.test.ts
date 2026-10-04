import { webcrypto } from 'node:crypto'

import { deviceProof, generateDeviceKey } from './dpop'

const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString())

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('device proofs', () => {
  it('signs with a non-extractable P-256 key, hashes the token and omits URL query and fragment', async () => {
    vi.stubGlobal('crypto', webcrypto)
    const key = await generateDeviceKey()
    expect(key.privateKey.extractable).toBe(false)
    await expect(crypto.subtle.exportKey('jwk', key.privateKey)).rejects.toThrow()

    const signed = await deviceProof(
      key,
      'post',
      'https://daemon.test/api/auth/ws-ticket?ignored=yes#fragment',
      'hxb_token'
    )

    const [header, body, signature] = signed.split('.') as [string, string, string]
    expect(decode(header)).toEqual({ typ: 'dpop+jwt', alg: 'ES256', jwk: key.publicJwk })
    expect(decode(body)).toMatchObject({
      htm: 'POST',
      htu: 'https://daemon.test/api/auth/ws-ticket',
      jti: expect.any(String)
    })

    const digest = async (text: string) =>
      Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))).toString(
        'base64url'
      )

    expect(decode(body).ath).toBe(await digest('hxb_token'))
    expect(key.jkt).toBe(await digest(JSON.stringify(key.publicJwk)))

    const publicKey = await crypto.subtle.importKey(
      'jwk',
      key.publicJwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify']
    )

    expect(
      await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        publicKey,
        Buffer.from(signature, 'base64url'),
        new TextEncoder().encode(`${header}.${body}`)
      )
    ).toBe(true)
    const next = await deviceProof(key, 'POST', 'https://daemon.test/hexbot/pair')
    expect(decode(next.split('.')[1]!).jti).not.toBe(decode(body).jti)
    expect(decode(next.split('.')[1]!).ath).toBeUndefined()
  })

  it.each(['crypto', 'indexedDB'])(
    'allows unbound login when %s is unavailable and logs once',
    async missing => {
      vi.resetModules()
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      vi.stubGlobal(missing, undefined)
      const { proofHeaders } = await import('./dpop')
      expect(await proofHeaders('POST', 'https://daemon.test/hexbot/pair')).toEqual({})
      expect(await proofHeaders('POST', 'https://daemon.test/hexbot/pair')).toEqual({})
      expect(warn).toHaveBeenCalledTimes(1)
    }
  )
})

describe('IndexedDB device keys', () => {
  beforeEach(async () => {
    vi.resetModules()
    const { IDBFactory } = await import('fake-indexeddb')
    vi.stubGlobal('indexedDB', new IDBFactory())
    vi.stubGlobal('crypto', webcrypto)
  })
  it('persists and reuses a non-extractable key after the module reloads', async () => {
    const first = await import('./dpop')
    const key = await first.deviceKey()
    expect(key).not.toBeNull()
    expect(await first.deviceKey()).toBe(key)
    vi.resetModules()
    const reloaded = await import('./dpop')
    const restored = await reloaded.deviceKey()
    expect(restored?.jkt).toBe(key?.jkt)
    expect(restored?.privateKey.extractable).toBe(false)
    await expect(crypto.subtle.exportKey('jwk', restored!.privateKey)).rejects.toThrow()
    expect(await reloaded.proofHeaders('POST', 'https://daemon.test/hexbot/pair')).toHaveProperty(
      'DPoP'
    )
  })
  it('converges on one key across concurrent first-use callers and tabs', async () => {
    const first = await import('./dpop')
    vi.resetModules()
    const second = await import('./dpop')
    const a = first.deviceKey()
    expect(first.deviceKey()).toBe(a)
    const [one, two] = await Promise.all([a, second.deviceKey()])
    expect(one).not.toBeNull()
    expect(one?.jkt).toBe(two?.jkt)
  })
  it('retries after an IndexedDB failure and logs failures only once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const open = vi.spyOn(indexedDB, 'open')
    open.mockImplementationOnce(() => {
      throw new DOMException('temporarily blocked', 'SecurityError')
    })
    open.mockImplementationOnce(() => {
      throw new DOMException('temporarily blocked', 'SecurityError')
    })
    const module = await import('./dpop')
    expect(await module.deviceKey()).toBeNull()
    expect(await module.deviceKey()).toBeNull()
    expect(await module.deviceKey()).not.toBeNull()
    expect(open).toHaveBeenCalledTimes(3)
    expect(warn).toHaveBeenCalledTimes(1)
  })
})
