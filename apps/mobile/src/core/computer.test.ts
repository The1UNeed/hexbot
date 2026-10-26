import { describe, expect, it } from 'vitest'

import { computerActivity } from './computer'

describe('computerActivity', () => {
  it('says what a bot does on the computer', () => {
    expect(computerActivity('Scout', 'click')).toBe('Scout is clicking on the computer')
    expect(computerActivity('Scout', 'type')).toBe('Scout is typing on the computer')
    expect(computerActivity('Scout', 'teleport')).toBe('Scout is using the computer')
  })
})
