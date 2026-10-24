import { render, screen } from '@testing-library/react'

import { isSubscription } from '../components/provider-panel'
import { AvatarBuilder } from '../components/ui/avatar-builder'
import { Thinking } from '../components/ui/thinking'
import {
  AVATAR_COLORS,
  AVATAR_SHAPES,
  avatarSvg,
  avatarSvgDataUrl,
  BALL,
  botFace,
  EYE_GAP,
  eyeRects,
  faceReadNow,
  faceReadsHeld,
  matchFace,
  readFace,
  READS_KEPT
} from '../lib/avatar-builder'
import { FACE_MOODS, facePose } from '../lib/face'

/** A 100×100 picture filled with `hex`, with `dots` painted in other colours. */
function picture(hex: string, dots: [number, number, string][] = []) {
  const pixels = new Uint8ClampedArray(100 * 100 * 4)

  const paint = (at: number, color: string) => {
    const value = Number.parseInt(color.slice(1), 16)
    pixels.set([(value >> 16) & 255, (value >> 8) & 255, value & 255, 255], at * 4)
  }

  for (let at = 0; at < 100 * 100; at += 1) {
    paint(at, hex)
  }

  for (const [x, y, color] of dots) {
    paint(Math.floor(y) * 100 + Math.floor(x), color)
  }

  return pixels
}

// The round mask covers the whole picture; every other shape misses it all.
const masks = Object.fromEntries(
  AVATAR_SHAPES.map(shape => [
    shape.id,
    new Uint8ClampedArray(100 * 100 * 4).fill(shape.id === 'round' ? 255 : 0)
  ])
)

describe('avatar builder', () => {
  it('reads a saved face back into its shape and colour', () => {
    const round = AVATAR_SHAPES.find(item => item.id === 'round')!

    const eyes = [-1, 1].map(
      side => [50 + side * (EYE_GAP / 2), round.ball.cy, '#ffffff'] as [number, number, string]
    )

    expect(matchFace(picture('#f97316', eyes), masks)).toEqual({ color: 'orange', shape: 'round' })
  })

  it('reads a flat face from before the eyes moved, so it renders live too', () => {
    const pixels = picture('#3b82f6', [
      [41, 48, '#151517'],
      [59, 48, '#151517']
    ])

    expect(matchFace(pixels, masks)).toEqual({ color: 'blue', shape: 'round' })
  })

  it('leaves photos and other uploads alone', () => {
    expect(matchFace(picture('#123456'), masks)).toBeNull()
    expect(matchFace(picture('#f97316'), masks)).toBeNull()
  })

  it('draws the chosen shape in the chosen colour with a face', () => {
    const svg = avatarSvg({ color: 'pink', shape: 'hexagon' })
    const hexagon = AVATAR_SHAPES.find(item => item.id === 'hexagon')!
    const pink = AVATAR_COLORS.find(item => item.id === 'pink')!

    expect(svg).toContain(hexagon.path)
    expect(svg).toContain(pink.value)
    expect(svg.match(/<rect/g)).toHaveLength(2)
    expect(svg).toContain('fill="#ffffff"')
    expect(svg).toContain(`translate(50 ${hexagon.ball.cy}) scale(${hexagon.ball.r / BALL})`)
    expect(avatarSvgDataUrl({ color: 'pink', shape: 'hexagon' })).toMatch(/^data:image\/svg\+xml/)
  })

  it('draws ink eyes on Chalk, where white ones would vanish', () => {
    expect(avatarSvg({ color: 'white', shape: 'round' })).toContain('fill="#151517"')
    expect(avatarSvg({ color: 'amber', shape: 'round' })).toContain('fill="#ffffff"')
  })

  it('falls back to the first shape and colour for unknown ids', () => {
    expect(avatarSvg({ color: 'nope', shape: 'nope' })).toContain(AVATAR_SHAPES[0]!.path)
  })

  it('draws both eyes as capsules the same width, mirrored about the centre', () => {
    for (const mood of ['happy', 'idle', 'listening', 'sleeping', 'working'] as const) {
      const [left, right] = eyeRects(mood)

      expect(left!.x + left!.width / 2).toBeCloseTo(-(right!.x + right!.width / 2))
      expect(left!.rx).toBe(Math.min(left!.width, left!.height) / 2)
      expect(left!.y + left!.height / 2).toBeLessThan(BALL / 2)
    }
  })

  it('keeps every activity and neighbour pose inside the original ball', () => {
    for (const mood of FACE_MOODS) {
      for (const look of [null, 'left', 'right'] as const) {
        const [tx, ty] = facePose(mood, look)
          .match(/-?[\d.]+/g)!
          .map(Number)

        for (const eye of eyeRects(mood)) {
          for (const x of [eye.x, eye.x + eye.width]) {
            for (const y of [eye.y, eye.y + eye.height]) {
              // Include the most extreme 4-unit activity movement.
              expect(Math.hypot(x + tx! + 4, y + ty! + 4)).toBeLessThan(BALL)
            }
          }
        }
      }
    }
  })

  it('draws the face picked in an app live, and the picture only when there is none', () => {
    const avatar = { data: 'data:image/png;base64,iVBORw0KGgo=', mime: 'image/png' }
    const picked = { avatar, face: { color: 'orange', shape: 'pill' } }

    expect(botFace(picked)).toEqual({ image: null, style: { color: 'orange', shape: 'pill' } })
    expect(botFace({ avatar, face: null })).toEqual({ image: avatar.data })
    expect(botFace({ avatar: null })).toEqual({ image: null })
    expect(botFace(undefined)).toEqual({ image: null })
    // One result per bot, so a large picture is not rebuilt on every render.
    expect(botFace(picked)).toBe(botFace(picked))
  })

  it('offers every shape and colour as a pressable button', () => {
    const onChange = vi.fn()
    render(<AvatarBuilder onChange={onChange} value={{ color: 'blue', shape: 'round' }} />)

    expect(screen.getByRole('button', { name: 'Round', pressed: true })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sky', pressed: true })).toBeInTheDocument()
    screen.getByRole('button', { name: 'Cloud' }).click()
    expect(onChange).toHaveBeenCalledWith({ color: 'blue', shape: 'cloud' })
  })
})

describe('thinking', () => {
  it('announces what the bot is doing', () => {
    render(<Thinking name="Scout" />)
    expect(screen.getByRole('status', { name: 'Scout is working' })).toBeInTheDocument()
  })
})

describe('isSubscription', () => {
  it('treats any oauth auth type as a browser sign-in', () => {
    expect(isSubscription({ auth_type: 'oauth_external' })).toBe(true)
    expect(isSubscription({ auth_type: 'oauth_device_code' })).toBe(true)
    expect(isSubscription({ auth_type: 'api_key' })).toBe(false)
  })
})

describe('reading faces back from pictures', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps only the last pictures it read and nothing still pending', async () => {
    // A picture that fails to load reads as no face, like a photo.
    vi.stubGlobal(
      'Image',
      class {
        onerror: (() => void) | null = null
        set src(_: string) {
          queueMicrotask(() => this.onerror?.())
        }
      }
    )

    const sources = Array.from(
      { length: READS_KEPT + 8 },
      (_, index) => `data:image/png;base64,${index}`
    )

    await Promise.all(sources.map(readFace))

    expect(faceReadsHeld()).toBe(READS_KEPT)
    expect(faceReadNow(sources[0]!)).toBeUndefined()
    expect(faceReadNow(sources.at(-1)!)).toBeNull()

    // A photo that is not a PNG is never kept.
    await expect(readFace('data:image/jpeg;base64,photo')).resolves.toBeNull()
    expect(faceReadNow('data:image/jpeg;base64,photo')).toBeNull()
    expect(faceReadsHeld()).toBe(READS_KEPT)
  })
})
