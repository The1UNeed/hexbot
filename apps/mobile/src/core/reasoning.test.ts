import { describe, expect, it } from 'vitest'
import { reasoningOptions, runningLevel } from './reasoning'
import type { ModelOption } from './types'

const model = (reasoning_levels?: ModelOption['reasoning_levels']): ModelOption => ({
  id: 'm',
  label: 'm',
  provider: 'p',
  ...(reasoning_levels ? { reasoning_levels } : {})
})

describe('reasoning levels', () => {
  it('offers every level when the daemon does not know the model', () => {
    expect(reasoningOptions(model())).toHaveLength(7)
    expect(runningLevel('xhigh', model())).toBe('xhigh')
  })
  it('rounds up to the next supported level, else down, as Pi does', () => {
    const levels = model(['off', 'low', 'high'])
    expect(runningLevel('medium', levels)).toBe('high')
    expect(runningLevel('max', levels)).toBe('high')
    expect(runningLevel('minimal', levels)).toBe('low')
  })
  it('runs a model without levels with thinking off', () => {
    expect(reasoningOptions(model([])).map(l => l.value)).toEqual(['off'])
    expect(runningLevel('high', model([]))).toBe('off')
  })
})
