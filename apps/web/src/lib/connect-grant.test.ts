import { fetchConnect } from './connect-grant'

afterEach(() => vi.unstubAllGlobals())

it.each([400, 401, 403, 500])('does not downgrade after HTTP %s', async status => {
  const fetch = vi.fn().mockResolvedValue(new Response('{}', { status }))
  vi.stubGlobal('fetch', fetch)
  await expect(fetchConnect('/api/daemons/id/grant', 'session', { jkt: 'key' })).rejects.toThrow()
  expect(fetch).toHaveBeenCalledTimes(1)
})
