import { rowTime } from './format'

describe('rowTime', () => {
  const now = new Date(2026, 9, 2, 15, 23).getTime()

  it('shows the time today, then Yesterday, a weekday, and a date', () => {
    expect(rowTime(new Date(2026, 9, 2, 15, 10).getTime() / 1000, now)).toMatch(/15:10|3:10/)
    expect(rowTime(new Date(2026, 9, 1, 9, 0).getTime() / 1000, now)).toBe('Yesterday')
    expect(rowTime(new Date(2026, 8, 29, 9, 0).getTime(), now)).toBe(new Date(2026, 8, 29).toLocaleDateString(undefined, { weekday: 'long' }))
    expect(rowTime(new Date(2026, 8, 19, 9, 0).getTime(), now)).toBe(new Date(2026, 8, 19).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }))
    expect(rowTime(null, now)).toBe('')
  })
})
