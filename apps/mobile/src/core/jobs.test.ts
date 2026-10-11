import { describe, it, expect } from 'vitest'
import { scheduleChange } from './jobs'
describe('job schedule', () => {
  it('a new job always sends its schedule', () => {
    expect(scheduleChange('every day at 8:00')).toEqual({ schedule: 'every day at 8:00' })
  })
  it('an edit keeps a relative schedule unless it changed', () => {
    expect(scheduleChange('in 30m', 'in 30m')).toEqual({})
    expect(scheduleChange('every 2h', 'in 30m')).toEqual({ schedule: 'every 2h' })
  })
})
