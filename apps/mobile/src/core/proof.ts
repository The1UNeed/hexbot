import { p256 } from '@noble/curves/p256'
import { ed25519 } from '@noble/curves/ed25519'
import { sha256 } from '@noble/hashes/sha256'
import { utf8ToBytes, hexToBytes } from '@noble/hashes/utils'
import { fromByteArray, toByteArray } from 'base64-js'
export const base64url = (value: Uint8Array) =>
  fromByteArray(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
export function decodeBase64url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid daemon identity.')
  const input = value.replace(/-/g, '+').replace(/_/g, '/')
  return toByteArray(input + '='.repeat((4 - (input.length % 4)) % 4))
}
const encoded = (value: unknown) => base64url(utf8ToBytes(JSON.stringify(value)))
export function publicJwk(privateHex: string) {
  const publicKey = p256.getPublicKey(hexToBytes(privateHex), false)
  return {
    kty: 'EC',
    crv: 'P-256',
    x: base64url(publicKey.slice(1, 33)),
    y: base64url(publicKey.slice(33))
  }
}
export function thumbprint(privateHex: string): string {
  const { crv, kty, x, y } = publicJwk(privateHex)
  return base64url(sha256(utf8ToBytes(JSON.stringify({ crv, kty, x, y }))))
}
export function createProof(
  privateHex: string,
  method: string,
  address: string,
  jti: string,
  token?: string,
  now = Date.now()
): string {
  const url = new URL(address)
  url.search = ''
  url.hash = ''
  const header = encoded({ typ: 'dpop+jwt', alg: 'ES256', jwk: publicJwk(privateHex) })
  const payload = encoded({
    htm: method.toUpperCase(),
    htu: url.href,
    iat: Math.floor(now / 1000),
    jti,
    ...(token ? { ath: base64url(sha256(utf8ToBytes(token))) } : {})
  })
  const signature = p256
    .sign(sha256(utf8ToBytes(`${header}.${payload}`)), hexToBytes(privateHex))
    .toCompactRawBytes()
  return `${header}.${payload}.${base64url(signature)}`
}
export function verifyIdentity(
  origin: string,
  daemonId: string,
  pinnedKey: string,
  nonce: string,
  body: Record<string, unknown>
): void {
  const invalid = () => new Error('This address did not prove it is your daemon. Sign-in stopped.')
  if (
    body.daemon_id !== daemonId ||
    body.public_key !== pinnedKey ||
    typeof body.signature !== 'string'
  )
    throw invalid()
  const url = new URL(origin)
  const hostname = url.hostname.toLowerCase().replace(/\.+$/, '')
  const host =
    hostname + (url.port && url.port !== '80' && url.port !== '443' ? `:${url.port}` : '')
  const message = utf8ToBytes(`hexbot-identity-v1\n${daemonId}\n${host}\n${nonce}`)
  try {
    if (!ed25519.verify(decodeBase64url(body.signature), message, decodeBase64url(pinnedKey)))
      throw invalid()
  } catch {
    throw invalid()
  }
}
