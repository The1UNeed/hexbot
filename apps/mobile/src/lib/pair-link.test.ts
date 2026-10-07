import { formatAddress, parseAddress, parsePairLink } from './pair-link'

describe('pair links', () => {
  it('parses the QR link and fallback port', () => {
    expect(parsePairLink('hexbot://pair?host=box.local&port=9120#code=ABCD')).toEqual({
      code: 'ABCD',
      host: 'box.local',
      port: 9120,
      tls: false
    })
    expect(parsePairLink('https://box.local')).toBeNull()
  })
  it('normalizes daemon addresses', () =>
    expect(parseAddress('https://example.test:9443/path')).toEqual({
      host: 'example.test',
      port: 9443,
      tls: true
    }))
  it('preserves TLS and default ports in typed addresses and pairing links', () => {
    expect(parseAddress('https://example.test')).toEqual({
      host: 'example.test',
      port: 443,
      tls: true
    })
    expect(parseAddress('wss://example.test:9443')).toEqual({
      host: 'example.test',
      port: 9443,
      tls: true
    })
    expect(parseAddress('box.local')).toEqual({ host: 'box.local', port: 9119, tls: false })
    const link = parsePairLink('hexbot://pair?host=example.test&port=9443&tls=true#code=ABCD')!
    expect(link.tls).toBe(true)
    expect(parseAddress(formatAddress(link))).toEqual({
      host: 'example.test',
      port: 9443,
      tls: true
    })
    expect(parseAddress(formatAddress({ host: 'fd7a:115c::1', port: 9119, tls: false }))).toEqual({
      host: '[fd7a:115c::1]',
      port: 9119,
      tls: false
    })
    expect(parseAddress('box.local:80')).toEqual({ host: 'box.local', port: 80, tls: false })
    expect(parseAddress('box.local:443')).toEqual({ host: 'box.local', port: 443, tls: true })
    expect(parseAddress('ftp://example.test')).toBeNull()
  })
})
