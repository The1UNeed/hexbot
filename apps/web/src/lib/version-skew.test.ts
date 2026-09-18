import { daemonBehind } from './version-skew'

describe('daemonBehind', () => {
  it('compares nightlies by date and run', () => {
    expect(daemonBehind('0.1.5-nightly.20260916.9', '0.1.5-nightly.20260914.6')).toBe(true)
    expect(daemonBehind('0.1.5-nightly.20260914.6', '0.1.5-nightly.20260916.9')).toBe(false)
    expect(daemonBehind('0.1.5-nightly.20260916.9', '0.1.5-nightly.20260916.9')).toBe(false)
    expect(daemonBehind('0.1.5-nightly.20260916.10', '0.1.5-nightly.20260916.9')).toBe(true)
  })

  it('compares everything else by the core version only', () => {
    expect(daemonBehind('0.1.6-alpha.1', '0.1.5-alpha.1')).toBe(true)
    expect(daemonBehind('0.1.5-alpha.2', '0.1.5-alpha.1')).toBe(false)
    expect(daemonBehind('0.1.5-alpha.1', '0.1.5-nightly.20260916.9')).toBe(false)
    expect(daemonBehind('0.2.0', '0.1.9')).toBe(true)
    expect(daemonBehind('1.0.0', '1.0.0')).toBe(false)
  })

  it('ignores missing versions and treats unparsable ones as different', () => {
    expect(daemonBehind(null, '0.1.5')).toBe(false)
    expect(daemonBehind('0.1.5', null)).toBe(false)
    expect(daemonBehind('dev', '0.1.5')).toBe(true)
    expect(daemonBehind('dev', 'dev')).toBe(false)
  })
})
