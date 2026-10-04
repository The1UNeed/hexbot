import { pairWithDaemon, resolveWsUrl } from './connection'
import { proofHeaders } from './dpop'

vi.mock('./dpop', () => ({ proofHeaders: vi.fn() }))

afterEach(() => vi.clearAllMocks())

it('adds a fresh token proof to each remote ticket request', async () => {
  vi.mocked(proofHeaders)
    .mockResolvedValueOnce({ DPoP: 'first' })
    .mockResolvedValueOnce({ DPoP: 'second' })
  const fetch = vi.fn(async () => new Response('{"ticket":"single-use"}'))

  const target = {
    kind: 'remote' as const,
    host: 'daemon.test',
    port: 443,
    tls: true,
    deviceToken: 'device-token'
  }

  await resolveWsUrl(target, { fetch })
  await resolveWsUrl(target, { fetch })
  expect(proofHeaders).toHaveBeenCalledWith(
    'POST',
    'https://daemon.test/api/auth/ws-ticket',
    'device-token'
  )

  for (const [index, proof] of ['first', 'second'].entries()) {
    expect(fetch).toHaveBeenNthCalledWith(
      index + 1,
      'https://daemon.test/api/auth/ws-ticket',
      expect.objectContaining({ headers: { Authorization: 'Bearer device-token', DPoP: proof } })
    )
  }
})

it('does not create a proof for a daemon-served cookie session', async () => {
  const fetch = vi.fn(async () => new Response('{"ticket":"single-use"}'))
  await resolveWsUrl({ kind: 'local' }, { fetch, bridge: () => null })
  expect(proofHeaders).not.toHaveBeenCalled()
})

it('continues pairing when proof-key storage is unavailable', async () => {
  vi.mocked(proofHeaders).mockResolvedValue({})
  const fetch = vi.fn<typeof globalThis.fetch>(async url => new Response(String(url).endsWith('/api/auth/ws-ticket') ? '{"ticket":"cookie"}' : '{"ok":true}'))
  await expect(
    pairWithDaemon('remote.test', 9119, 'CODE', 'Browser', { fetch, bridge: () => null })
  ).resolves.toMatchObject({ deviceToken: '' })
  expect(JSON.parse(fetch.mock.calls[0]![1]?.body as string).return_token).toBeUndefined()
  expect(fetch).toHaveBeenCalledWith(
    'http://remote.test:9119/auth/password-login',
    expect.objectContaining({ headers: { 'Content-Type': 'application/json' } })
  )
})

it('keeps the cookie path working with an old remote daemon that returns no token', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(
    async () => new Response('{"ticket":"cookie-ticket"}')
  )

  await resolveWsUrl(
    { kind: 'remote', host: 'old.test', port: 443, tls: true, deviceToken: '' },
    { fetch, bridge: () => null }
  )
  expect(fetch).toHaveBeenCalledWith(
    'https://old.test/api/auth/ws-ticket',
    expect.objectContaining({ credentials: 'include' })
  )
  expect(proofHeaders).not.toHaveBeenCalled()
})

it('does not create a proof for the full edition local token', async () => {
  const bridge = { daemon: { localToken: async () => 'local-token' } } as never

  const fetch = vi.fn<typeof globalThis.fetch>(
    async () => new Response('{"ticket":"local-ticket"}')
  )

  await resolveWsUrl(
    { kind: 'local', origin: 'http://localhost:9119' },
    { fetch, bridge: () => bridge }
  )
  expect(proofHeaders).not.toHaveBeenCalled()
})

it('leaves proof retries to the reconnect supervisor', async () => {
  vi.mocked(proofHeaders)
    .mockResolvedValueOnce({ DPoP: 'first' })
    .mockResolvedValueOnce({ DPoP: 'fresh' })

  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(new Response('{"code":"invalid_dpop_proof"}', { status: 401 }))
    .mockResolvedValueOnce(new Response('{"ticket":"accepted"}'))

  await expect(
    resolveWsUrl(
      { kind: 'remote', host: 'daemon.test', port: 443, tls: true, deviceToken: 'bound' },
      { fetch }
    )
  ).rejects.toMatchObject({ code: 'invalid_dpop_proof' })
  expect(fetch).toHaveBeenCalledTimes(1)
})
