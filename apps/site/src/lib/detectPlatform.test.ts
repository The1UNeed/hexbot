import { describe, expect, it } from 'vitest'
import { detectTarget } from './detectPlatform'

const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15'

describe('detectTarget', () => {
  it('trusts client hints on a Mac', () => {
    expect(detectTarget({ userAgent: mac, architecture: 'arm' })).toBe('mac-arm64')
    expect(detectTarget({ userAgent: mac, architecture: 'x86' })).toBe('mac-x64')
  })

  it('falls back to the GPU, then to Apple Silicon', () => {
    expect(detectTarget({ userAgent: mac, renderer: 'Apple GPU' })).toBe('mac-arm64')
    expect(detectTarget({ userAgent: mac, renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)' })).toBe('mac-arm64')
    expect(detectTarget({ userAgent: mac, renderer: 'Intel(R) Iris(TM) Plus Graphics' })).toBe('mac-x64')
    expect(detectTarget({ userAgent: mac, renderer: 'ANGLE (AMD, ANGLE Metal Renderer: AMD Radeon Pro 5500M, Unspecified Version)' })).toBe('mac-x64')
    expect(detectTarget({ userAgent: mac })).toBe('mac-arm64')
  })

  it('knows Linux, and that phones, tablets, and Windows have no build', () => {
    expect(detectTarget({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0' })).toBe('linux')
    expect(detectTarget({ userAgent: mac, maxTouchPoints: 5 })).toBe('other')
    expect(detectTarget({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128.0' })).toBe('other')
    expect(detectTarget({ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/128.0 Mobile' })).toBe('other')
    expect(detectTarget({ userAgent: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) Chrome/128.0' })).toBe('other')
  })
})
