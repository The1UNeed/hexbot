/**
 * Generated bot faces: a shape and a colour with two hexagonal eyes, drawn as
 * if painted on a ball. Drawn as SVG in the UI and rasterised to PNG for the
 * profile asset (the daemon accepts png, jpeg or webp only). Bots without an
 * uploaded avatar get a face derived from their name so every bot has one.
 *
 * The eyes live in the "ball frame": a group translated to the shape's eye
 * centre and scaled by the shape's ball radius over `BALL`. The activity
 * poses in face.ts and the motion in tokens.css work
 * in that frame, so the same CSS pose turns a small triangle and a big round
 * face by the same angle and keeps both inside their silhouette.
 */

import { hueFromString } from './cn'
import {
  AVATAR_COLORS,
  AVATAR_SHAPES,
  type AvatarShape,
  type AvatarStyle,
  BALL,
  type Ball,
  ballTransform,
  EYE_GAP,
  EYE_MOODS,
  eyePlacements,
  EYES,
  eyeTransform,
  type FaceMood,
  HEX_EYE,
  INK
} from './face-geometry'

export {
  AVATAR_COLORS,
  AVATAR_SHAPES,
  type AvatarShape,
  type AvatarStyle,
  BALL,
  type Ball,
  ballTransform,
  DEFAULT_AVATAR_STYLE,
  EYE_GAP,
  EYE_MOODS,
  type EyePlacement,
  eyePlacements,
  type EyePose,
  EYES,
  eyeTransform,
  eyeTransformCss,
  type FaceMood,
  HEX_EYE
} from './face-geometry'

/** A stable face for a bot that has no uploaded avatar. */
export function styleForName(name: string): AvatarStyle {
  const hue = hueFromString(name)
  const colors = AVATAR_COLORS.filter(item => !['white', 'gray', 'brown'].includes(item.id))

  return {
    color: colors[hue % colors.length]!.id,
    shape: AVATAR_SHAPES[Math.floor(hue / 7) % AVATAR_SHAPES.length]!.id
  }
}

export function resolveStyle(style: AvatarStyle) {
  const color = AVATAR_COLORS.find(item => item.id === style.color) ?? AVATAR_COLORS[0]!

  return {
    color,
    eyes: color.eyes ?? EYES,
    shape: AVATAR_SHAPES.find(item => item.id === style.shape) ?? AVATAR_SHAPES[0]!
  }
}

/** The eyes as SVG markup, shared by the inline face and the rasterised one. */
export function faceEyes(ball: Ball, fill: string, mood: FaceMood = 'idle'): string {
  const eyes = eyePlacements(mood)
    .map(eye => `<path d="${HEX_EYE}" transform="${eyeTransform(eye)}" fill="${fill}"/>`)
    .join('')

  return (
    `<g transform="${ballTransform(ball)}">` +
    `<g class="hex-gaze"><g class="hex-eyes">${eyes}</g></g>` +
    `</g>`
  )
}

/** The face as an SVG document (100×100 viewBox). */
export function avatarSvg(style: AvatarStyle): string {
  const { color, eyes, shape } = resolveStyle(style)

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">` +
    `<path d="${shape.path}" fill="${color.value}"/>` +
    faceEyes(shape.ball, eyes) +
    `</svg>`
  )
}

export function avatarSvgDataUrl(style: AvatarStyle): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(avatarSvg(style))}`
}

/** PNG data URL for the profile asset. Resolves to `null` where canvas is unavailable. */
export function avatarPng(style: AvatarStyle, size = 512): Promise<null | string> {
  if (typeof document === 'undefined') {
    return Promise.resolve(null)
  }

  return new Promise(resolve => {
    const image = new Image()

    image.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = size
      canvas.height = size
      const context = canvas.getContext('2d')

      if (!context) {
        resolve(null)

        return
      }

      context.drawImage(image, 0, 0, size, size)

      try {
        resolve(canvas.toDataURL('image/png'))
      } catch {
        resolve(null)
      }
    }

    image.onerror = () => resolve(null)
    image.src = avatarSvgDataUrl(style)
  })
}

/** `src` for a bot's uploaded avatar, or `null` when it has none. */
export function avatarSrc(avatar?: null | { data: string; mime: string }): null | string {
  if (!avatar?.data) {
    return null
  }

  return avatar.data.startsWith('data:') ? avatar.data : `data:${avatar.mime};base64,${avatar.data}`
}

const shown = new WeakMap<object, { image: null | string; style?: AvatarStyle }>()

/**
 * What to draw for a bot: the face picked in an app, live, when the daemon
 * stores one (`bot.face`); otherwise its picture, which `Avatar` still reads
 * back into a live face when this module drew it. One result per bot object,
 * so a large picture is not rebuilt or looked up afresh on every render.
 */
export function botFace(
  bot?: null | {
    avatar?: null | { data: string; mime: string }
    face?: AvatarStyle | null
  }
): { image: null | string; style?: AvatarStyle } {
  if (!bot) {
    return { image: null }
  }

  let face = shown.get(bot)

  if (!face) {
    face = bot.face ? { image: null, style: bot.face } : { image: avatarSrc(bot.avatar) }
    shown.set(bot, face)
  }

  return face
}

/** Sampling size; the 100×100 face space, one pixel per unit. */
const SIDE = 100

/** A point on every shape's body, clear of every eye this module has drawn. */
const BODY = [50, 30] as const

/** Where the flat faces had their eyes. */
const LEGACY_EYES = [
  [41, 48],
  [59, 48]
] as const

function pixel(pixels: Uint8ClampedArray, x: number, y: number): number[] {
  const at = (Math.floor(y) * SIDE + Math.floor(x)) * 4

  return Array.from(pixels.subarray(at, at + 4))
}

function near(rgba: number[], hex: string, tolerance: number): boolean {
  const value = Number.parseInt(hex.slice(1), 16)
  const rgb = [(value >> 16) & 255, (value >> 8) & 255, value & 255]

  return (
    rgba[3]! > 240 && rgb.every((channel, index) => Math.abs(channel - rgba[index]!) <= tolerance)
  )
}

/**
 * Matches a 100×100 RGBA picture against every colour and shape, given each
 * shape's mask drawn at the same size, with its eyes where this module puts
 * them now or where it put them before they moved onto the ball. Hexagonal
 * and older capsule eyes share their centres, so both read back. A photo or
 * any other upload matches nothing.
 */
export function matchFace(
  pixels: Uint8ClampedArray,
  masks: Record<string, Uint8ClampedArray>
): AvatarStyle | null {
  const body = pixel(pixels, ...BODY)
  const color = AVATAR_COLORS.find(item => near(body, item.value, 3))

  if (!color) {
    return null
  }

  let shape: AvatarShape | undefined
  let fewest = Number.POSITIVE_INFINITY

  for (const candidate of AVATAR_SHAPES) {
    const mask = masks[candidate.id]

    if (!mask) {
      continue
    }

    let misses = 0

    for (let index = 3; index < pixels.length; index += 4) {
      if (Math.abs(pixels[index]! - mask[index]!) > 128) {
        misses += 1
      }
    }

    if (misses < fewest) {
      fewest = misses
      shape = candidate
    }
  }

  // Antialiasing may flip a pixel or two along the edge; another shape misses hundreds.
  if (!shape || fewest > 40) {
    return null
  }

  const style = { color: color.id, shape: shape.id }
  const scale = shape.ball.r / BALL
  const { ball } = shape

  const eyes = [-1, 1].map(
    side => [50 + side * (EYE_GAP / 2) * scale, ball.cy + EYE_MOODS.idle.dy * scale] as const
  )

  const drawn =
    eyes.every(([x, y]) => near(pixel(pixels, x, y), color.eyes ?? EYES, 24)) ||
    LEGACY_EYES.every(([x, y]) => near(pixel(pixels, x, y), INK, 24))

  return drawn ? style : null
}

/** Enough for every picture on screen; one dropped is read again if it comes back. */
export const READS_KEPT = 32

const reads = new Map<string, AvatarStyle | null>()
const reading = new Map<string, Promise<AvatarStyle | null>>()

/** Only a PNG can be a face this module drew; anything else is a photo. */
const canRead = (src: string) => src.startsWith('data:image/png')

/** What `readFace` found for `src`, or `undefined` until it has finished. */
export function faceReadNow(src: string): AvatarStyle | null | undefined {
  return canRead(src) ? reads.get(src) : null
}

/**
 * Reads a profile picture this module drew back into its style, so a
 * generated face renders live instead of as a still picture. Photos and other
 * uploads give `null`, as does anywhere without a canvas. The last
 * `READS_KEPT` results are kept, so changing pictures all day does not keep
 * every one of them.
 */
export function readFace(src: string): Promise<AvatarStyle | null> {
  if (!canRead(src)) {
    return Promise.resolve(null)
  }

  if (reads.has(src)) {
    const found = reads.get(src)!
    // Most recently used goes last, so the oldest is dropped first.
    reads.delete(src)
    reads.set(src, found)

    return Promise.resolve(found)
  }

  const known = reading.get(src)

  if (known) {
    return known
  }

  const read = samplePicture(src).then(found => {
    reading.delete(src)
    reads.set(src, found)

    for (const oldest of reads.keys()) {
      if (reads.size <= READS_KEPT) {
        break
      }

      reads.delete(oldest)
    }

    return found
  })

  reading.set(src, read)

  return read
}

/** How many pictures are read or being read; for tests. */
export function faceReadsHeld(): number {
  return reads.size + reading.size
}

function samplePicture(src: string): Promise<AvatarStyle | null> {
  if (typeof document === 'undefined') {
    return Promise.resolve(null)
  }

  return new Promise(resolve => {
    const image = new Image()

    image.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = SIDE
      canvas.height = SIDE
      const context = canvas.getContext('2d', { willReadFrequently: true })

      if (!context) {
        resolve(null)

        return
      }

      const draw = (paint: () => void) => {
        context.clearRect(0, 0, SIDE, SIDE)
        paint()

        return context.getImageData(0, 0, SIDE, SIDE).data
      }

      try {
        const pixels = draw(() => context.drawImage(image, 0, 0, SIDE, SIDE))

        const masks = Object.fromEntries(
          AVATAR_SHAPES.map(shape => [shape.id, draw(() => context.fill(new Path2D(shape.path)))])
        )

        resolve(matchFace(pixels, masks))
      } catch {
        resolve(null)
      }
    }

    image.onerror = () => resolve(null)
    image.src = src
  })
}
