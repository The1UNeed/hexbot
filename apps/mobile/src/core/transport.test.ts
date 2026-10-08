import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ed25519 } from '@noble/curves/ed25519'
import { utf8ToBytes } from '@noble/hashes/utils'
import { DeviceProofError, type JsonRpcGatewayClient } from '@hermes/shared'
import { base64url, decodeBase64url, thumbprint } from './proof'
import { connectGrant, openGateway, request, RevokedError } from './transport'
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('expo-crypto', () => ({
  randomUUID: () => 'fresh-request',
  getRandomBytes: (n: number) => new Uint8Array(n).fill(9)
}))
vi.mock('./storage', () => ({ proofKey: async () => '01'.repeat(32) }))
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
const decode = (jwt: string) =>
  JSON.parse(new TextDecoder().decode(decodeBase64url(jwt.split('.')[1])))
beforeEach(() => vi.restoreAllMocks())
describe('mobile authentication boundary', () => {
  it('retains credentials for device proof failures and distinguishes revocation', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(json({ code: 'invalid_dpop_proof' }, 401))
        .mockResolvedValueOnce(json({ error: 'revoked' }, 401))
    )
    await expect(request('https://daemon.example/api/auth/ws-ticket')).rejects.toBeInstanceOf(
      DeviceProofError
    )
    await expect(request('https://daemon.example/api/auth/ws-ticket')).rejects.toBeInstanceOf(
      RevokedError
    )
  })
  it('binds a Connect grant to the app key and verifies the daemon before presenting it', async () => {
    const privateKey = new Uint8Array(32).fill(7)
    const identity = base64url(ed25519.getPublicKey(privateKey))
    const calls: { url: string; init: RequestInit }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        if (url.endsWith('/grant'))
          return json({
            grant: 'signed-grant',
            daemon: { host: 'owl.example', port: 443, tls: true }
          })
        if (url.includes('/identity?')) {
          const nonce = new URL(url).searchParams.get('nonce')
          return json({
            daemon_id: 'owl',
            public_key: identity,
            signature: base64url(
              ed25519.sign(
                utf8ToBytes(`hexbot-identity-v1\nowl\nowl.example\n${nonce}`),
                privateKey
              )
            )
          })
        }
        return json({ device_token: 'hxb_device', device_id: 'phone', daemon_name: 'Owl' })
      })
    )
    const result = await connectGrant(
      { id: 'owl', tunnel_hostname: 'old.example', identity_key: identity, online: true },
      'session-token'
    )
    expect(result.daemon.origin).toBe('https://owl.example')
    expect(result.token).toBe('hxb_device')
    expect(JSON.parse(String(calls[0].init.body)).jkt).toBe(thumbprint('01'.repeat(32)))
    expect(calls[1].init.headers).toBeUndefined()
    expect(calls[2].url).toBe('https://owl.example/auth/password-login')
    expect(decode((calls[2].init.headers as Record<string, string>).DPoP)).toMatchObject({
      htm: 'POST',
      htu: calls[2].url
    })
    expect(JSON.parse(String(calls[2].init.body)).password).toBe('cg_signed-grant')
  })
  it('stops on an identity mismatch without sending the grant to that address', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        json({ grant: 'grant', daemon: { host: 'wrong.example', port: 443, tls: true } })
      )
      .mockResolvedValueOnce(json({ daemon_id: 'impostor' }))
    vi.stubGlobal('fetch', fetcher)
    await expect(
      connectGrant(
        { id: 'owl', tunnel_hostname: 'wrong.example', identity_key: 'pinned', online: true },
        'session'
      )
    ).rejects.toThrow('did not prove')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it('puts only the short-lived ticket on the WebSocket URL', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ ticket: 'one-time-ticket' })))
    let ready = () => {}
    const client = {
      on: (_: string, callback: () => void) => {
        ready = callback
        return () => {}
      },
      connect: vi.fn(async () => {
        ready()
      })
    }
    await openGateway(
      client as unknown as JsonRpcGatewayClient,
      { id: 'owl', name: 'Owl', kind: 'local', origin: 'http://owl.local:9119', deviceId: 'phone' },
      'hxb_private'
    )
    expect(client.connect).toHaveBeenCalledWith('ws://owl.local:9119/api/ws?ticket=one-time-ticket')
    const headers = vi.mocked(fetch).mock.calls[0][1]!.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer hxb_private')
    expect(decode(headers.DPoP).ath).toBeTruthy()
  })
})
