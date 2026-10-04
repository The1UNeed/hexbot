import { generateKeyPairSync, sign, webcrypto } from 'node:crypto'

import { verifyDaemonIdentity } from './daemon-identity'

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const daemon = { id: 'daemon-1', identity_key: publicKey.export({ format: 'jwk' }).x! }
const origin = 'https://owl.example'

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function answer(mode = 'valid') {
  const fetcher = vi.fn(async (input: string) => {
    const nonce = new URL(input).searchParams.get('nonce')
    const id = mode === 'wrong daemon' ? 'other' : daemon.id
    const message = `hexbot-identity-v1\n${id}\n${mode === 'wrong host' ? 'other.example' : 'owl.example'}\n${mode === 'replayed nonce' ? 'old' : nonce}`

    return Response.json({
      daemon_id: id,
      public_key: daemon.identity_key,
      signature:
        mode === 'invalid'
          ? Buffer.alloc(64).toString('base64url')
          : sign(null, Buffer.from(message), privateKey).toString('base64url')
    })
  })

  vi.stubGlobal('fetch', fetcher)

  return fetcher
}

it('verifies a fresh host-bound signature without sending credentials', async () => {
  const fetcher = answer()
  await verifyDaemonIdentity('https://OWL.example.:443', daemon)
  await verifyDaemonIdentity(origin, daemon)
  expect(fetcher.mock.calls[0]?.[0]).not.toBe(fetcher.mock.calls[1]?.[0])
  expect(fetcher).toHaveBeenCalledWith(
    expect.stringContaining('/api/connect/identity?nonce='),
    expect.objectContaining({ credentials: 'omit', redirect: 'error' })
  )
})

it.each(['invalid', 'wrong daemon', 'wrong host', 'replayed nonce'])(
  'refuses %s before a grant can be sent',
  async mode => {
    answer(mode)
    await expect(verifyDaemonIdentity(origin, daemon)).rejects.toThrow(
      'This address is not answering as your daemon.'
    )
  }
)

it('proceeds without a known key and does not probe', async () => {
  const fetcher = answer()
  await verifyDaemonIdentity(origin, { id: daemon.id, identity_key: null })
  expect(fetcher).not.toHaveBeenCalled()
})

it('proceeds when an older daemon returns 404', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 404 }))
  )
  await expect(verifyDaemonIdentity(origin, daemon)).resolves.toBeUndefined()
})

it('proceeds when WebCrypto does not implement Ed25519', async () => {
  const fetcher = answer()
  const unsupported = Object.assign(new Error('Unavailable'), { name: 'NotSupportedError' })
  vi.stubGlobal('crypto', { subtle: { importKey: vi.fn().mockRejectedValue(unsupported) } })
  await expect(verifyDaemonIdentity(origin, daemon)).resolves.toBeUndefined()
  expect(fetcher).not.toHaveBeenCalled()
})

it('refuses malformed keys, oversized bodies and failed requests', async () => {
  answer()
  await expect(verifyDaemonIdentity(origin, { ...daemon, identity_key: 'bad' })).rejects.toThrow(
    'not answering'
  )
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('x'.repeat(65537)))
  )
  await expect(verifyDaemonIdentity(origin, daemon)).rejects.toThrow('not answering')
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 503 }))
  )
  await expect(verifyDaemonIdentity(origin, daemon)).rejects.toThrow('not answering')
})
