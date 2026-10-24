/**
 * Generated bot faces: a shape and a colour with two eyes, the hexbot-face
 * component's (`face.ts`) at rest. Drawn as SVG in the UI and rasterised to
 * PNG for the profile asset (the daemon accepts png, jpeg or webp only). Bots
 * without an uploaded avatar get a face derived from their name so every bot
 * has one.
 *
 * A shape is drawn as the component shape nearest to it, with the eyes where
 * the component rests them (`face-rest.ts`). Each shape also keeps the
 * outline and the "ball" (the circle the eyes once sat in) that the earlier
 * flat faces were drawn with, so a picture saved then is still read back.
 */

import { hueFromString } from './cn'
import { FACE_VIEWBOX } from './face'
import { FACE_REST } from './face-rest'

export interface AvatarStyle {
  color: string
  shape: string
}

/** The ball the earlier faces' eyes sat on; its centre was their resting point. */
export interface Ball {
  cy: number
  r: number
}

export interface AvatarShape {
  /** The earlier outline's ball, in the 100-unit frame. */
  ball: Ball
  id: string
  label: string
  /** The earlier outline, in the 100-unit frame, for reading old pictures. */
  legacyPath: string
  /** The head outline, in the component's head frame. */
  path: string
}

const LEGACY: Record<string, { ball: Ball; path: string }> = {
  cloud: {
    ball: { cy: 57, r: 30 },
    path: 'M26 85a19 19 0 0 1-5.9-37 28 28 0 0 1 55.8-4.6 21 21 0 0 1-3.9 41.6Z'
  },
  drop: {
    ball: { cy: 59, r: 37 },
    path: 'M50 5c12.7 19.8 38 36.3 38 52a38 38 0 0 1-76 0C12 41.3 37.3 24.8 50 5Z'
  },
  hexagon: {
    ball: { cy: 52, r: 44 },
    path: 'M44 6a12 12 0 0 1 12 0l30 17a12 12 0 0 1 6 10v34a12 12 0 0 1-6 10L56 94a12 12 0 0 1-12 0L14 77a12 12 0 0 1-6-10V33a12 12 0 0 1 6-10Z'
  },
  pill: {
    ball: { cy: 51, r: 32 },
    path: 'M50 20c31 0 47 13 47 30S81 80 50 80 3 67 3 50s16-30 47-30Z'
  },
  round: { ball: { cy: 54, r: 45 }, path: 'M50 5a45 45 0 1 1 0 90a45 45 0 1 1 0-90Z' },
  square: {
    ball: { cy: 53, r: 43 },
    path: 'M24 7h52a17 17 0 0 1 17 17v52a17 17 0 0 1-17 17H24A17 17 0 0 1 7 76V24A17 17 0 0 1 24 7Z'
  },
  squircle: {
    ball: { cy: 54, r: 45 },
    path: 'M50 5c34 0 45 11 45 45S84 95 50 95 5 84 5 50 16 5 50 5Z'
  },
  triangle: {
    ball: { cy: 67, r: 24 },
    path: 'M43 12a8 8 0 0 1 14 0l38 66a8 8 0 0 1-7 12H12a8 8 0 0 1-7-12Z'
  }
}

export const AVATAR_SHAPES: AvatarShape[] = Object.entries(FACE_REST).map(([id, rest]) => ({
  ball: LEGACY[id]!.ball,
  id,
  label: rest.label,
  legacyPath: LEGACY[id]!.path,
  path: rest.head
}))

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

export type { FaceMood } from './face'

/** The radius of the earlier faces' ball frame. */
export const BALL = 45

/** The head frame's span and offset, as `FACE_VIEWBOX` lays it out. */
const HEAD_SPAN = 259
const HEAD_OFFSET = 15

/** A head-frame coordinate in the 100-unit picture. */
const toPicture = (value: number) => ((value + HEAD_OFFSET) * 100) / HEAD_SPAN

/**
 * The resting eyes of a shape: the component's idle rest (`face-rest.ts`),
 * with each eye's centre in the 100-unit picture frame too. What the still
 * picture of a bot shows.
 */
export function restingEyes(
  shapeId: string
): { cx: number; cy: number; d: string; transform: string }[] {
  const rest = FACE_REST[shapeId] ?? FACE_REST.round!

  return rest.eyes.map(eye => ({
    cx: toPicture(eye.cx),
    cy: toPicture(eye.cy),
    d: eye.d,
    transform: eye.transform
  }))
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

/** The eyes as SVG markup for the rasterised face, clipped to the head as the live one is. */
export function faceEyes(shapeId: string, fill: string): string {
  return restingEyes(shapeId)
    .map(eye => `<path d="${eye.d}" transform="${eye.transform}" fill="${fill}"/>`)
    .join('')
}

/** The face as an SVG document, in the component's head frame (`FACE_VIEWBOX`). */
export function avatarSvg(style: AvatarStyle): string {
  const { color, eyes, shape } = resolveStyle(style)

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${FACE_VIEWBOX}">` +
    `<clipPath id="head"><path d="${shape.path}"/></clipPath>` +
    `<path d="${shape.path}" fill="${color.value}"/>` +
    `<g clip-path="url(#head)">${faceEyes(shape.id, eyes)}</g>` +
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

/** The key of a shape's earlier outline in the masks given to `matchFace`. */
export const legacyMask = (shapeId: string) => `${shapeId}:legacy`

/**
 * Matches a 100×100 RGBA picture against every colour and shape, given each
 * shape's mask drawn at the same size (its outline now, and under
 * `legacyMask` the one before), with its eyes where this module puts them
 * now or where it put them before they moved onto the ball. A photo or any
 * other upload matches nothing.
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
    for (const mask of [masks[candidate.id], masks[legacyMask(candidate.id)]]) {
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
  }

  // Antialiasing may flip a pixel or two along the edge; another shape misses hundreds.
  if (!shape || fewest > 40) {
    return null
  }

  const style = { color: color.id, shape: shape.id }
  const scale = shape.ball.r / BALL
  const { ball } = shape
  const eyes = restingEyes(shape.id).map(eye => [eye.cx, eye.cy] as const)
  // Faces drawn before the eyes looked up and to the right sat on the ball's centre.
  const centred = [-1, 1].map(side => [50 + side * 14.5 * scale, ball.cy] as const)

  const drawn =
    eyes.every(([x, y]) => near(pixel(pixels, x, y), color.eyes ?? EYES, 24)) ||
    centred.every(([x, y]) => near(pixel(pixels, x, y), color.eyes ?? EYES, 24)) ||
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

        // The head frame drawn into the 100-unit picture, as `avatarSvg` lays it out.
        const toPicture = new DOMMatrix().scale(100 / HEAD_SPAN).translate(HEAD_OFFSET, HEAD_OFFSET)

        const masks = Object.fromEntries(
          AVATAR_SHAPES.flatMap(shape => {
            const head = new Path2D()
            head.addPath(new Path2D(shape.path), toPicture)

            return [
              [shape.id, draw(() => context.fill(head))],
              [legacyMask(shape.id), draw(() => context.fill(new Path2D(shape.legacyPath)))]
            ]
          })
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
