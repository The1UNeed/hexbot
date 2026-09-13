import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { connectBaseUrl, DEFAULT_CONNECT_URL, grantTarget } from './connect-url'

const items = new Map<string, string>()

beforeEach(() =>
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => items.get(key) ?? null,
    removeItem: (key: string) => items.delete(key),
    setItem: (key: string, value: string) => items.set(key, value)
  })
)
afterEach(() => {
  items.clear()
  vi.unstubAllGlobals()
})

describe('connectBaseUrl', () => {
  it('defaults to the hosted service', () => {
    expect(connectBaseUrl()).toBe(DEFAULT_CONNECT_URL)
  })

  it('honours a stored override without a trailing slash', () => {
    localStorage.setItem('hexbot.connect.url', 'http://localhost:3000/')
    expect(connectBaseUrl()).toBe('http://localhost:3000')
  })
})

describe('grantTarget', () => {
  it('uses the daemon address from the grant', () => {
    expect(
      grantTarget({ daemon: { host: '127.0.0.1', port: 9119, tls: false } }, 'x.hexbot.app')
    ).toEqual({ host: '127.0.0.1', port: 9119, tls: false })
  })

  it('falls back to the tunnel hostname over TLS', () => {
    expect(grantTarget({}, 'x.hexbot.app')).toEqual({ host: 'x.hexbot.app', port: 443, tls: true })
  })
})
