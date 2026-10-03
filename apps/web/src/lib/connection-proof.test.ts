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
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('{"ok":true,"device_token":"unbound-token"}'))
  await expect(
    pairWithDaemon('remote.test', 9119, 'CODE', 'Browser', { fetch, bridge: () => null })
  ).resolves.toMatchObject({ deviceToken: 'unbound-token' })
  expect(JSON.parse(fetch.mock.calls[0]![1]?.body as string).return_token).toBe(true)
  expect(fetch).toHaveBeenCalledWith(
    'http://remote.test:9119/auth/password-login',
    expect.objectContaining({ headers: { 'Content-Type': 'application/json' } })
  )
})

it('keeps the cookie path working with an old remote daemon that returns no token', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('{"ticket":"cookie-ticket"}'))
  await resolveWsUrl({ kind: 'remote', host: 'old.test', port: 443, tls: true, deviceToken: '' }, { fetch, bridge: () => null })
  expect(fetch).toHaveBeenCalledWith('https://old.test/api/auth/ws-ticket', expect.objectContaining({ credentials: 'include' }))
  expect(proofHeaders).not.toHaveBeenCalled()
})
