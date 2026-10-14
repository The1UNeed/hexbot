/**
 * Generated bot faces: a shape and a colour with two capsule eyes, drawn as
 * if painted on a ball. Drawn as SVG in the UI and rasterised to PNG for the
 * profile asset (the daemon accepts png, jpeg or webp only). Bots without an
 * uploaded avatar get a face derived from their name so every bot has one.
 *
 * The eyes live in the "ball frame": a group translated to the shape's eye
 * centre and scaled by the shape's ball radius over `BALL`. Everything that
 * moves them (the wander, the look classes, the blink in tokens.css) works
 * in that frame, so the same CSS pose turns a small triangle and a big round
 * face by the same angle and keeps both inside their silhouette.
 */

import { hueFromString } from './cn'

export interface AvatarStyle {
  color: string
  shape: string
}

/** The ball the eyes sit on: its centre is the eyes' resting point. */
export interface Ball {
  cy: number
  r: number
}

export interface AvatarShape {
  ball: Ball
  id: string
  label: string
  path: string
}

export const AVATAR_SHAPES: AvatarShape[] = [
  {
    ball: { cy: 54, r: 45 },
    id: 'round',
    label: 'Round',
    path: 'M50 5a45 45 0 1 1 0 90a45 45 0 1 1 0-90Z'
  },
  {
    ball: { cy: 54, r: 45 },
    id: 'squircle',
    label: 'Squircle',
    path: 'M50 5c34 0 45 11 45 45S84 95 50 95 5 84 5 50 16 5 50 5Z'
  },
  {
    ball: { cy: 53, r: 43 },
    id: 'square',
    label: 'Square',
    path: 'M24 7h52a17 17 0 0 1 17 17v52a17 17 0 0 1-17 17H24A17 17 0 0 1 7 76V24A17 17 0 0 1 24 7Z'
  },
  {
    ball: { cy: 51, r: 32 },
    id: 'pill',
    label: 'Pill',
    path: 'M50 20c31 0 47 13 47 30S81 80 50 80 3 67 3 50s16-30 47-30Z'
  },
  {
    ball: { cy: 67, r: 24 },
    id: 'triangle',
    label: 'Triangle',
    path: 'M43 12a8 8 0 0 1 14 0l38 66a8 8 0 0 1-7 12H12a8 8 0 0 1-7-12Z'
  },
  {
    ball: { cy: 52, r: 44 },
    id: 'hexagon',
    label: 'Hexagon',
    path: 'M44 6a12 12 0 0 1 12 0l30 17a12 12 0 0 1 6 10v34a12 12 0 0 1-6 10L56 94a12 12 0 0 1-12 0L14 77a12 12 0 0 1-6-10V33a12 12 0 0 1 6-10Z'
  },
  {
    ball: { cy: 57, r: 30 },
    id: 'cloud',
    label: 'Cloud',
    path: 'M26 85a19 19 0 0 1-5.9-37 28 28 0 0 1 55.8-4.6 21 21 0 0 1-3.9 41.6Z'
  },
  {
    ball: { cy: 59, r: 37 },
    id: 'drop',
    label: 'Drop',
    path: 'M50 5c12.7 19.8 38 36.3 38 52a38 38 0 0 1-76 0C12 41.3 37.3 24.8 50 5Z'
  }
]

/** Ink for eyes on a body too light for white ones. */
const INK = '#151517'

export const AVATAR_COLORS: { eyes?: string; id: string; label: string; value: string }[] = [
  { eyes: INK, id: 'white', label: 'Chalk', value: '#ececf0' },
  { id: 'brown', label: 'Cocoa', value: '#9a6242' },
  { id: 'red', label: 'Cherry', value: '#ef4444' },
  { id: 'orange', label: 'Tangerine', value: '#f97316' },
  { id: 'amber', label: 'Honey', value: '#f5a524' },
  { id: 'green', label: 'Mint', value: '#22a55b' },
  { id: 'teal', label: 'Lagoon', value: '#14b8a6' },
  { id: 'blue', label: 'Sky', value: '#3b82f6' },
  { id: 'violet', label: 'Iris', value: '#8b5cf6' },
  { id: 'pink', label: 'Bubblegum', value: '#ec2f8a' },
  { id: 'gray', label: 'Slate', value: '#8e8e93' }
]

export const DEFAULT_AVATAR_STYLE: AvatarStyle = { color: 'pink', shape: 'hexagon' }

/** Eyes are white unless the colour says otherwise, so they read as paint on a solid body. */
export const EYES = '#ffffff'

/**
 * What the face is doing. The eyes change shape with it: tall while idle,
 * lowered while it waits on you, narrowed while it works, squinted when
 * something went well, closed when it sleeps.
 */
export type FaceMood = 'happy' | 'idle' | 'listening' | 'sleeping' | 'working'

/** The radius of the ball frame; eye sizes and poses below are in its units. */
export const BALL = 45

/** Distance between the two eye centres in the ball frame. */
export const EYE_GAP = 29

/** One capsule eye in the ball frame: its width, height, and drop below the centre. */
export interface EyeShape {
  dy: number
  h: number
  w: number
}

export const EYE_MOODS: Record<FaceMood, EyeShape> = {
  happy: { dy: -1.5, h: 8, w: 13 },
  idle: { dy: 0, h: 27, w: 11.7 },
  listening: { dy: 3, h: 20, w: 11.7 },
  sleeping: { dy: 1, h: 3, w: 12.5 },
  working: { dy: 1.5, h: 17, w: 10 }
}

/** The two capsules of a mood as `<rect>` attributes in the ball frame. */
export function eyeRects(mood: FaceMood = 'idle') {
  const eye = EYE_MOODS[mood]
  const radius = Math.min(eye.w, eye.h) / 2

  return [-1, 1].map(side => ({
    height: eye.h,
    rx: radius,
    ry: radius,
    width: eye.w,
    x: side * (EYE_GAP / 2) - eye.w / 2,
    y: eye.dy - eye.h / 2
  }))
}

/** The `transform` that takes the ball frame onto a shape. */
export function ballTransform(ball: Ball): string {
  return `translate(50 ${ball.cy}) scale(${ball.r / BALL})`
}

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
  const rects = eyeRects(mood)
    .map(
      eye =>
        `<rect x="${eye.x}" y="${eye.y}" width="${eye.width}" height="${eye.height}"` +
        ` rx="${eye.rx}" ry="${eye.ry}" fill="${fill}"/>`
    )
    .join('')

  return (
    `<g transform="${ballTransform(ball)}">` +
    `<g class="hex-gaze"><g class="hex-eyes">${rects}</g></g>` +
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

/** A point on every shape's body, clear of the eyes old and new. */
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
 * them now or where it put them before they moved onto the ball. A photo or
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
