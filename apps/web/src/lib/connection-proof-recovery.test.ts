import { webcrypto } from 'node:crypto'

import { IDBFactory } from 'fake-indexeddb'

beforeEach(() => {
  vi.resetModules()
  vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal('indexedDB', new IDBFactory())
  localStorage.clear()
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const target = {
  kind: 'remote' as const,
  host: 'daemon.test',
  port: 443,
  tls: true,
  deviceToken: 'bound-token'
}

it.each([
  ['dpop_clock_skew', 401, /clock differs.*10 minutes/],
  ['invalid_dpop_proof', 401, /rejected the device proof/],
  ['dpop_cache_full', 503, /busy checking device proofs/],
  ['dpop_proof_required', 401, /key could not be loaded/]
] as const)(
  'keeps the saved target after %s and explains after one retry',
  async (code, status, message) => {
    const { ConnectionSupervisor } = await import('./connection')
    const { useConnection } = await import('../stores/connection')
    useConnection.getState().setTarget(target)
    const proofs: string[] = []

    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      if (!String(url).endsWith('/api/auth/ws-ticket')) {
        return new Response('')
      }

      proofs.push(new Headers(init?.headers).get('DPoP')!)

      return new Response(JSON.stringify({ code, server_time: 1000, proof_time: 1600 }), { status })
    })

    const supervisor = new ConnectionSupervisor({ fetch })
    await supervisor.start(target)
    expect(proofs).toHaveLength(2)
    expect(proofs[0]).not.toBe(proofs[1])
    expect(useConnection.getState()).toMatchObject({
      target,
      status: 'offline',
      error: expect.stringMatching(message)
    })
    expect(JSON.parse(localStorage.getItem('hexbot.target')!)).toEqual(target)
    supervisor.stop()
  }
)

it('a deleted key routes to sign-in with an accurate message and preserves the saved target', async () => {
  const { deviceKey } = await import('./dpop')
  const original = await deviceKey()
  expect(original).not.toBeNull()
  // Simulate losing IndexedDB while the localStorage target survives a reload.
  vi.stubGlobal('indexedDB', new IDBFactory())
  vi.resetModules()
  const { ConnectionSupervisor } = await import('./connection')
  const { useConnection } = await import('../stores/connection')
  useConnection.getState().setTarget(target)

  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    if (!String(url).endsWith('/api/auth/ws-ticket')) {
      return new Response('')
    }

    const proof = new Headers(init?.headers).get('DPoP')!
    const { jwk } = JSON.parse(Buffer.from(proof.split('.')[0]!, 'base64url').toString())

    const jkt = Buffer.from(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(jwk)))
    ).toString('base64url')

    expect(jkt).not.toBe(original!.jkt)

    return new Response('{"code":"dpop_key_mismatch"}', { status: 401 })
  })

  const supervisor = new ConnectionSupervisor({ fetch })
  await supervisor.start(target)
  expect(useConnection.getState()).toMatchObject({
    target,
    status: 'unauthorized',
    error: 'The saved device key no longer matches this daemon. Sign in again.'
  })
  expect(fetch).toHaveBeenCalledTimes(3)
  expect(JSON.parse(localStorage.getItem('hexbot.target')!)).toEqual(target)
  supervisor.stop()
})

it('clears the target only for a real credential rejection', async () => {
  const { ConnectionSupervisor } = await import('./connection')
  const { useConnection } = await import('../stores/connection')
  useConnection.getState().setTarget(target)

  const fetch = vi.fn<typeof globalThis.fetch>(
    async url =>
      new Response('', { status: String(url).endsWith('/api/auth/ws-ticket') ? 401 : 200 })
  )

  const supervisor = new ConnectionSupervisor({ fetch })
  await supervisor.start(target)
  expect(useConnection.getState()).toMatchObject({ target: null, status: 'unauthorized' })
  expect(localStorage.getItem('hexbot.target')).toBeNull()
  supervisor.stop()
})

it.each([403, 500, 503])(
  'retains the saved token for an ordinary HTTP %s failure',
  async status => {
    const { ConnectionSupervisor } = await import('./connection')
    const { useConnection } = await import('../stores/connection')
    useConnection.getState().setTarget(target)

    const fetch = vi.fn<typeof globalThis.fetch>(
      async url =>
        new Response('', {
          status: String(url).endsWith('/api/auth/ws-ticket') ? status : 200
        })
    )

    const supervisor = new ConnectionSupervisor({ fetch })
    await supervisor.start(target)
    expect(useConnection.getState()).toMatchObject({ target, status: 'offline' })
    expect(JSON.parse(localStorage.getItem('hexbot.target')!)).toEqual(target)
    supervisor.stop()
  }
)
