/** The proof key and device targets belong to this browser/Electron app profile. */
export interface DeviceKey {
  privateKey: CryptoKey
  publicJwk: JsonWebKey
  jkt: string
}

let pending: Promise<DeviceKey | null> | undefined
let warned = false
const bytes = (value: string) => new TextEncoder().encode(value)

const base64url = (value: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(value)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

const hash = async (value: string) => base64url(await crypto.subtle.digest('SHA-256', bytes(value)))

export async function generateDeviceKey(): Promise<DeviceKey> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, [
    'sign',
    'verify'
  ])

  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
  const publicJwk = { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }

  return { privateKey: pair.privateKey, publicJwk, jkt: await hash(JSON.stringify(publicJwk)) }
}

async function storedKey(): Promise<DeviceKey> {
  if (!globalThis.crypto?.subtle || !globalThis.indexedDB) {
    throw new Error('Device key storage is unavailable')
  }

  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open('hexbot.device-key', 1)
    open.onupgradeneeded = () => open.result.createObjectStore('keys')
    open.onsuccess = () => resolve(open.result)
    open.onerror = () => reject(open.error)
    open.onblocked = () => reject(new Error('Device key storage is blocked'))
  })

  try {
    // Generate outside the transaction. The read/write transaction selects one key
    // even if two tabs create their first target at the same time.
    const candidate = await generateDeviceKey()

    return await new Promise<DeviceKey>((resolve, reject) => {
      const tx = db.transaction('keys', 'readwrite')
      const store = tx.objectStore('keys')
      const read = store.get('profile')
      let result: DeviceKey

      read.onsuccess = () => {
        result = (read.result as DeviceKey | undefined) ?? candidate

        if (!read.result) {
          store.put(candidate, 'profile')
        }
      }

      tx.oncomplete = () => resolve(result)
      tx.onabort = () => reject(tx.error ?? new Error('Device key storage failed'))
      tx.onerror = () => reject(tx.error)
    })
  } finally {
    db.close()
  }
}

/** Storage/crypto failure permits an unbound login. It never changes a token's server binding. */
export function deviceKey(): Promise<DeviceKey | null> {
  pending ??= storedKey().catch(() => {
    if (!warned) {
      console.warn('Device proof keys are unavailable; new logins will use unbound tokens.')
      warned = true
    }

    return null
  })

  return pending
}

export async function deviceProof(
  key: DeviceKey,
  method: string,
  input: string,
  token?: string
): Promise<string> {
  const url = new URL(input)
  url.search = ''
  url.hash = ''

  const header = base64url(
    bytes(JSON.stringify({ typ: 'dpop+jwt', alg: 'ES256', jwk: key.publicJwk })).buffer
  )

  const claims = base64url(
    bytes(
      JSON.stringify({
        htm: method.toUpperCase(),
        htu: url.href,
        iat: Math.floor(Date.now() / 1000),
        jti: crypto.randomUUID(),
        ...(token ? { ath: await hash(token) } : {})
      })
    ).buffer
  )

  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key.privateKey,
    bytes(`${header}.${claims}`)
  )

  return `${header}.${claims}.${base64url(signature)}`
}

export async function proofHeaders(
  method: string,
  url: string,
  token?: string
): Promise<Record<string, string>> {
  const key = await deviceKey()

  return key ? { DPoP: await deviceProof(key, method, url, token) } : {}
}
