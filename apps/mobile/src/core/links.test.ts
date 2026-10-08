import { describe, it, expect } from 'vitest'
import { normalizeOrigin, parsePairing, parseConnectCallback } from './links'
describe('connection input', () => {
  it('preserves HTTPS, handles IPv6, and adds the default daemon port to bare hosts', () => {
    expect(normalizeOrigin(' 192.168.1.12 ')).toBe('http://192.168.1.12:9119')
    expect(normalizeOrigin('https://bot.example')).toBe('https://bot.example')
    expect(normalizeOrigin('[::1]:9222')).toBe('http://[::1]:9222')
    for (const input of [
      'file:///tmp',
      'javascript://x',
      'https://user:pass@host',
      'https://host/path',
      'https://host?token=secret'
    ])
      expect(() => normalizeOrigin(input)).toThrow()
  })
  it('reads daemon QR links and one-time browser sign-in links without consuming them', () => {
    expect(parsePairing('hexbot://pair?host=192.168.1.2&port=9119#code=ABCD-EFGH')).toEqual({
      origin: 'http://192.168.1.2:9119',
      code: 'ABCD-EFGH'
    })
    expect(parsePairing('http://localhost:9222/login?code=ABCD-EFGH')).toEqual({
      origin: 'http://localhost:9222',
      code: 'ABCD-EFGH'
    })
    expect(() => parsePairing('hexbot://pair?host=host&port=90000#code=code')).toThrow()
    expect(() => parsePairing('hexbot://pair?host=host&port=9119')).toThrow()
    expect(parsePairing('https://hexbot.app')).toBeNull()
  })
  it('accepts only a matching Connect callback with a fragment token', () => {
    expect(parseConnectCallback('hexbot://connect?state=abc#session=hxc_123', 'abc')).toBe(
      'hxc_123'
    )
    for (const url of [
      'hexbot://connect?state=wrong#session=secret',
      'https://connect?state=abc#session=secret',
      'hexbot://pair?state=abc#session=secret',
      'hexbot://connect?state=abc&session=secret'
    ])
      expect(() => parseConnectCallback(url, 'abc')).toThrow()
  })
})
