import { generateKeyPairSync, sign, webcrypto } from 'node:crypto'

import {
  DaemonIdentityError,
  DaemonIdentityUnavailableError,
  DaemonUnreachableError,
  verifyDaemonIdentity
} from './daemon-identity'

const { publicKey, privateKey } = generateKeyPairSync('ed25519')

const daemon = {
  id: 'daemon-1',
  name: 'Studio Mac',
  identity_key: publicKey.export({ format: 'jwk' }).x!
}

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
      'Studio Mac did not prove it is your daemon, so sign-in stopped.'
    )
  }
)

it('proceeds without a known key and does not probe', async () => {
  const fetcher = answer()
  await verifyDaemonIdentity(origin, { id: daemon.id, identity_key: null })
  expect(fetcher).not.toHaveBeenCalled()
})

it('blocks a known-key impostor returning 404 before sending a grant', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 404 }))
  )
  const sendGrant = vi.fn()
  await expect(verifyDaemonIdentity(origin, daemon).then(sendGrant)).rejects.toBeInstanceOf(
    DaemonIdentityError
  )
  expect(sendGrant).not.toHaveBeenCalled()
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
    'did not prove'
  )
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('x'.repeat(65537)))
  )
  await expect(verifyDaemonIdentity(origin, daemon)).rejects.toThrow('did not prove')
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 503 }))
  )
  await expect(verifyDaemonIdentity(origin, daemon)).rejects.toThrow(
    'Studio Mac could not be reached.'
  )
})

it.each(['network', 'timeout', 'body timeout'])(
  'reports %s separately from an identity mismatch',
  async mode => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        if (mode === 'body timeout') {
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new DOMException('timeout', 'TimeoutError'))
              }
            })
          )
        }

        throw mode === 'timeout'
          ? new DOMException('timeout', 'TimeoutError')
          : new TypeError('fetch failed')
      })
    )
    await expect(verifyDaemonIdentity(origin, daemon)).rejects.toBeInstanceOf(
      DaemonUnreachableError
    )
  }
)

it('does not treat an empty supplied key as an older registration', async () => {
  await expect(
    verifyDaemonIdentity(origin, { ...daemon, identity_key: '' })
  ).rejects.toBeInstanceOf(DaemonIdentityError)
})

it.each([{ code: 'identity_unavailable' }, { error: 'Daemon identity is unavailable' }])(
  'reports the daemon JSON 503 as an identity problem', async body => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(body, { status: 503 })))
    const sendGrant = vi.fn()
    await expect(verifyDaemonIdentity(origin, daemon).then(sendGrant)).rejects.toThrow(
      'Studio Mac is running but could not prove it is your daemon.'
    )
    await expect(verifyDaemonIdentity(origin, daemon)).rejects.toBeInstanceOf(DaemonIdentityUnavailableError)
    expect(sendGrant).not.toHaveBeenCalled()
  }
)

it('uses the tunnel hostname when the daemon has no name', async () => {
  answer('invalid')
  await expect(verifyDaemonIdentity(origin, { ...daemon, name: '', tunnel_hostname: 'owl.example' })).rejects.toThrow(
    'owl.example did not prove it is your daemon, so sign-in stopped.'
  )
})
