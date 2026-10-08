import { describe, expect, it } from 'vitest'

import { reasoningOptions, runningLevel } from './reasoning'
import type { ModelOption } from './types'

const glm: ModelOption = {
  id: 'glm-5.3-flash',
  label: 'glm-5.3-flash',
  provider: 'opencode-go',
  reasoning_levels: ['low', 'high', 'max']
}

describe('reasoning levels', () => {
  it('offers only the levels a model supports', () => {
    expect(reasoningOptions(glm).map(level => level.label)).toEqual(['Low', 'High', 'Max'])
    expect(reasoningOptions({ ...glm, reasoning_levels: undefined })).toHaveLength(7)
  })

  it('rounds up to the next supported level like Pi, else down', () => {
    expect(runningLevel('medium', glm)).toBe('high')
    expect(runningLevel('xhigh', glm)).toBe('max')
    expect(runningLevel('off', glm)).toBe('low')
    expect(runningLevel('max', { ...glm, reasoning_levels: ['low', 'high'] })).toBe('high')
    expect(runningLevel('xhigh', undefined)).toBe('xhigh')
  })
})
