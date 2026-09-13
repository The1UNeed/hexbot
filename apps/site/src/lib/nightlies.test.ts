import { describe, expect, it } from 'vitest'
import { nightlyRows, type NightlyEntry } from './nightlies'

const entry = (version: string): NightlyEntry => ({
  version,
  date: '2026-09-13T07:00:00Z',
  commit: 'abc1234',
  files: {
    full: {
      'mac-arm64': `Hexbot-${version}-mac-arm64.dmg`,
      'mac-x64': `Hexbot-${version}-mac-x64.dmg`,
      linux: `Hexbot-${version}-linux-x86_64.AppImage`,
      'linux-deb': `Hexbot-${version}-linux-amd64.deb`
    },
    client: {}
  }
})

describe('nightlyRows', () => {
  it('lists newest first with dates and direct links', () => {
    const rows = nightlyRows([entry('0.1.5-nightly.20260913.2'), entry('0.1.5-nightly.20260912.1')], { version: '0.1.5-nightly.20260913.2' })
    expect(rows.map(r => [r.day, r.latest])).toEqual([['13 September 2026', true], ['12 September 2026', false]])
    expect(rows[0].files[0]).toEqual({
      key: 'mac-arm64',
      label: 'Mac, Apple Silicon',
      url: 'https://updates.hexbot.app/full/mac/arm64/Hexbot-0.1.5-nightly.20260913.2-mac-arm64.dmg'
    })
    expect(rows[1].files).toHaveLength(4)
  })

  it('adds the current build on top when the index lags or is missing', () => {
    const rows = nightlyRows([entry('0.1.5-nightly.20260912.1')], { version: '0.1.5-nightly.20260913.2' })
    expect(rows.map(r => r.version)).toEqual(['0.1.5-nightly.20260913.2', '0.1.5-nightly.20260912.1'])
    expect(rows[0].files).toEqual([])
    expect(nightlyRows([], { version: '0.1.5-nightly.20260913.2' })).toHaveLength(1)
    expect(nightlyRows([], null)).toEqual([])
  })
})
