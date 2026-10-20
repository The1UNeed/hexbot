import { AVATAR_COLORS } from '../lib/avatar-builder'
import tokens from '../styles/tokens.css?raw'

/** Every block that sets the theme tokens: system light and dark, then the forced themes. */
function blocks(): Record<string, string> {
  const roots = [...tokens.matchAll(/:root\s*\{([^}]*)\}/g)].map(match => match[1]!)

  const forced = (theme: string) =>
    new RegExp(`\\[data-theme='${theme}'\\]\\s*\\{([^}]*)\\}`).exec(tokens)![1]!

  return {
    dark: forced('dark'),
    light: forced('light'),
    'system dark': roots[1]!,
    'system light': roots[0]!
  }
}

function token(block: string, name: string): string {
  const value = new RegExp(`--hex-${name}:\\s*([^;]+);`).exec(block)?.[1]?.trim()

  expect(value, `--hex-${name}`).toBeDefined()

  return value!
}

function rgb(hex: string): number[] {
  const value = Number.parseInt(hex.slice(1), 16)

  return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}

function luminance(color: number[]): number {
  const [r, g, b] = color.map(channel => {
    const value = channel / 255

    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })

  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}

function contrast(a: number[], b: number[]): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)

  return (light! + 0.05) / (dark! + 0.05)
}

describe('bot bubble contrast', () => {
  it('keeps text and secondary text at 4.5:1 on every face colour, light and dark', () => {
    for (const [theme, block] of Object.entries(blocks())) {
      const bubble = rgb(token(block, 'bubble'))
      const wash = Number.parseFloat(token(block, 'bot-wash')) / 100

      for (const color of AVATAR_COLORS) {
        const face = rgb(color.value)
        // color-mix(in srgb, face wash, bubble)
        const fill = bubble.map((channel, index) => channel + (face[index]! - channel) * wash)

        for (const name of ['text', 'bot-muted']) {
          const ratio = contrast(rgb(token(block, name)), fill)

          expect(ratio, `${name} on ${color.label}, ${theme}`).toBeGreaterThanOrEqual(4.5)
        }
      }
    }
  })
})
