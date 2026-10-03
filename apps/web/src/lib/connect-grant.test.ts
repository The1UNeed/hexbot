import { fetchConnect } from './connect-grant'

afterEach(() => vi.unstubAllGlobals())

it('retries an old Connect route without jkt only on 400', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response('{}', { status: 400 }))
    .mockResolvedValueOnce(new Response('{"grant":"legacy"}'))

  vi.stubGlobal('fetch', fetch)
  await expect(
    fetchConnect('/api/daemons/id/grant', 'session', { device_name: 'app', jkt: 'key' })
  ).resolves.toEqual({ grant: 'legacy' })
  expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({ device_name: 'app', jkt: 'key' })
  expect(JSON.parse(fetch.mock.calls[1]![1].body)).toEqual({ device_name: 'app' })
})
it.each([401, 403, 500])('does not downgrade after HTTP %s', async status => {
  const fetch = vi.fn().mockResolvedValue(new Response('{}', { status }))
  vi.stubGlobal('fetch', fetch)
  await expect(fetchConnect('/api/daemons/id/grant', 'session', { jkt: 'key' })).rejects.toThrow()
  expect(fetch).toHaveBeenCalledTimes(1)
})
