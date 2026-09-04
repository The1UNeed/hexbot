import { describe, expect, it } from 'vitest'
import { parseEdition } from './edition'

describe('edition', () => {
  it('defaults to the full package unless the build asked for client', () => {
    expect(parseEdition(undefined)).toBe('full')
    expect(parseEdition('full')).toBe('full')
    expect(parseEdition('client')).toBe('client')
    expect(parseEdition('anything-else')).toBe('full')
  })
})
