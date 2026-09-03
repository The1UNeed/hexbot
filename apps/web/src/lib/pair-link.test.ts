import { parseAddress, parsePairLink } from './pair-link'

describe('pair links', () => {
  it('parses the QR link and fallback port', () => {
    expect(parsePairLink('hexbot://pair?host=box.local&port=9120#code=ABCD')).toEqual({ code: 'ABCD', host: 'box.local', port: 9120 })
    expect(parsePairLink('https://box.local')).toBeNull()
  })
  it('normalizes daemon addresses', () => expect(parseAddress('https://example.test:9443/path')).toEqual({ host: 'example.test', port: 9443 }))
})
