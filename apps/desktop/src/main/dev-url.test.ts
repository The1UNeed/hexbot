import { describe, expect, it } from 'vitest'

import { resolveWebDevUrl } from './dev-url'

describe('resolveWebDevUrl', () => {
  it('uses the default for an empty value and preserves an override', () => {
    expect(resolveWebDevUrl('')).toBe('http://localhost:5173')
    expect(resolveWebDevUrl(' http://localhost:4173 ')).toBe('http://localhost:4173')
  })
})
