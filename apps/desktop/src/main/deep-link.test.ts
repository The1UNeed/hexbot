import { describe, expect, it } from 'vitest'

import { parseDeepLink } from './deep-link'

describe('parseDeepLink', () => {
  it('parses pair and Connect fragments', () => {
    expect(parseDeepLink('hexbot://pair?host=box.local&port=9120#code=ABCD')).toEqual({
      kind: 'pair',
      code: 'ABCD',
      host: 'box.local',
      port: 9120
    })
    expect(parseDeepLink('hexbot://connect?state=nonce#session=secret')).toEqual({
      kind: 'connect',
      session: 'secret',
      state: 'nonce'
    })
  })

  it('accepts a query session only on Linux', () => {
    const link = 'hexbot://connect?state=nonce&session=secret'
    expect(parseDeepLink(link, 'linux')).toEqual({
      kind: 'connect',
      session: 'secret',
      state: 'nonce'
    })
    expect(parseDeepLink(link, 'darwin')).toBeNull()
  })
})
