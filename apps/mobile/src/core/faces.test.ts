import { describe, expect, it, vi } from 'vitest'

import { bubbleFill, FACE_COLORS, faceWash } from '../ui/faces'
import { palettes } from '../ui/theme'

vi.mock('react-native', () => ({
  Platform: {
    OS: 'ios',
    select: (choices: { default?: string; ios?: string }) => choices.ios ?? choices.default
  }
}))

function luminance(hex: string): number {
  const value = Number.parseInt(hex.slice(1), 16)
  const [r, g, b] = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map(channel => {
    const c = channel / 255

    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })

  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)

  return (light! + 0.05) / (dark! + 0.05)
}

const orange = { face: { color: 'orange', shape: 'pill' }, name: '中文' }

describe('faceWash', () => {
  it('washes a bot bubble with its face colour', () => {
    expect(faceWash(orange, '#f0f0f2', 'light')).toBe('#f1dfd3')
    expect(faceWash(orange, '#2a2a2d', 'dark')).toBe('#533928')
  })

  it('keeps the plain fill for an uploaded picture', () => {
    expect(faceWash({ imageUri: 'file:///me.png', name: 'Photo' }, '#f0f0f2', 'light')).toBe('#f0f0f2')
  })

  it('keeps bubble text at 4.5:1 on every face colour, light and dark', () => {
    for (const theme of [palettes.light, palettes.dark]) {
      for (const color of FACE_COLORS) {
        const fill = faceWash({ face: { color: color.id, shape: 'round' }, name: '' }, theme.fill, theme.scheme)

        expect(contrast(theme.text, fill), `${color.label}, ${theme.scheme}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })
})

describe('bubbleFill', () => {
  const theme = palettes.light
  const washed = faceWash(orange, theme.fill, theme.scheme)

  it("gives a reply in a bot's own thread that bot's colour, though it names no author", () => {
    expect(bubbleFill({ role: 'bot' }, { face: orange, room: false }, theme)).toBe(washed)
  })

  it('takes the named bot in a room, and leaves an unnamed reply plain', () => {
    expect(bubbleFill({ author: orange, role: 'bot' }, { face: null, room: true }, theme)).toBe(washed)
    expect(bubbleFill({ role: 'bot' }, { face: orange, room: true }, theme)).toBe(theme.fill)
  })

  it('keeps people plain and yours on ink', () => {
    expect(bubbleFill({ author: { name: 'Ada' }, role: 'human' }, { room: true }, theme)).toBe(theme.fill)
    expect(bubbleFill({ role: 'user' }, { face: orange, room: false }, theme)).toBe(theme.ink)
  })
})
