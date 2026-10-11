import { describe, it, expect } from 'vitest'
import { p256 } from '@noble/curves/p256'
import { ed25519 } from '@noble/curves/ed25519'
import { sha256 } from '@noble/hashes/sha256'
import { utf8ToBytes } from '@noble/hashes/utils'
import {
  createProof,
  decodeBase64url,
  publicJwk,
  thumbprint,
  verifyIdentity,
  base64url
} from './proof'
const key = '01'.repeat(32)
describe('native device proof', () => {
  it('signs the request method, canonical URL, token hash and fresh identity', () => {
    const jwt = createProof(
      key,
      'post',
      'https://daemon.example:443/api/auth/ws-ticket?q=secret#fragment',
      'request-1',
      'hxb_device',
      1700000000000
    )
    const [header, payload, signature] = jwt.split('.')
    expect(JSON.parse(new TextDecoder().decode(decodeBase64url(header)))).toEqual({
      typ: 'dpop+jwt',
      alg: 'ES256',
      jwk: publicJwk(key)
    })
    expect(JSON.parse(new TextDecoder().decode(decodeBase64url(payload)))).toEqual({
      htm: 'POST',
      htu: 'https://daemon.example/api/auth/ws-ticket',
      iat: 1700000000,
      jti: 'request-1',
      ath: base64url(sha256(utf8ToBytes('hxb_device')))
    })
    expect(
      p256.verify(
        decodeBase64url(signature),
        sha256(utf8ToBytes(`${header}.${payload}`)),
        p256.getPublicKey(key)
      )
    ).toBe(true)
    expect(thumbprint(key)).toHaveLength(43)
  })
  it('verifies pinned Ed25519 identities and rejects replay to a different nonce or host', () => {
    const privateKey = new Uint8Array(32).fill(7)
    const pinned = base64url(ed25519.getPublicKey(privateKey))
    const signature = base64url(
      ed25519.sign(
        utf8ToBytes('hexbot-identity-v1\ndaemon-1\nexample.com:9119\nnonce-1'),
        privateKey
      )
    )
    const body = { daemon_id: 'daemon-1', public_key: pinned, signature }
    expect(() =>
      verifyIdentity('http://EXAMPLE.com:9119', 'daemon-1', pinned, 'nonce-1', body)
    ).not.toThrow()
    expect(() =>
      verifyIdentity('http://example.com:9119', 'daemon-1', pinned, 'nonce-2', body)
    ).toThrow()
    expect(() =>
      verifyIdentity('http://impostor.com:9119', 'daemon-1', pinned, 'nonce-1', body)
    ).toThrow()
    expect(() =>
      verifyIdentity('http://example.com:9119', 'different', pinned, 'nonce-1', body)
    ).toThrow()
  })
})
