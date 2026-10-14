/**
 * Bot faces: a shape and a colour with two capsule eyes painted on a ball,
 * the same set the web app draws (apps/web/src/lib/avatar-builder.ts). Keep
 * the two in step so a bot looks the same on every client.
 */

export interface FaceStyle {
  color: string
  shape: string
}

/** What the face is doing; the eyes change shape with it. */
export type FaceMood = 'happy' | 'idle' | 'listening' | 'sleeping' | 'working'

/** The ball the eyes sit on: its centre is the eyes' resting point. */
export interface Ball {
  cy: number
  r: number
}

export const FACE_SHAPES: { ball: Ball; id: string; label: string; path: string }[] = [
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

export const FACE_COLORS: { eyes?: string; id: string; label: string; value: string }[] = [
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

/** Eyes are white unless the colour says otherwise, so they read as paint on a solid body. */
export const FACE_EYES = '#ffffff'

/** The radius of the ball frame; eye sizes below are in its units. */
export const BALL = 45

/** Distance between the two eye centres in the ball frame. */
const EYE_GAP = 29

/** One capsule eye in the ball frame: its width, height, and drop below the centre. */
export const EYE_MOODS: Record<FaceMood, { dy: number; h: number; w: number }> = {
  happy: { dy: -1.5, h: 8, w: 13 },
  idle: { dy: 0, h: 27, w: 11.7 },
  listening: { dy: 3, h: 20, w: 11.7 },
  sleeping: { dy: 1, h: 3, w: 12.5 },
  working: { dy: 1.5, h: 17, w: 10 }
}

/** The two capsules of a mood as rect attributes in the ball frame. */
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

function hueFromString(value: string): number {
  let hash = 0

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) % 360_000
  }

  return hash % 360
}

/** A stable face for a bot that has no uploaded avatar; matches the web app. */
export function faceForName(name: string): FaceStyle {
  const hue = hueFromString(name)
  const colors = FACE_COLORS.filter(item => !['white', 'gray', 'brown'].includes(item.id))

  return {
    color: colors[hue % colors.length]!.id,
    shape: FACE_SHAPES[Math.floor(hue / 7) % FACE_SHAPES.length]!.id
  }
}

export function resolveFace(style: FaceStyle) {
  const color = FACE_COLORS.find(item => item.id === style.color) ?? FACE_COLORS[0]!

  return {
    color,
    eyes: color.eyes ?? FACE_EYES,
    shape: FACE_SHAPES.find(item => item.id === style.shape) ?? FACE_SHAPES[0]!
  }
}

/** How much of a bot's face colour washes its bubbles, as on the web. */
const WASH = { dark: 0.2, light: 0.14 } as const

function rgb(hex: string): number[] {
  const value = Number.parseInt(hex.slice(1), 16)

  return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}

/**
 * A bot bubble's fill: the plain fill washed with the face colour. A bot with
 * an uploaded picture keeps the plain fill; its colour is not known here.
 */
export function faceWash(
  source: { face?: FaceStyle | null; imageUri?: string | null; name: string },
  fill: string,
  scheme: 'dark' | 'light'
): string {
  if (source.imageUri) {
    return fill
  }

  const color = rgb(resolveFace(source.face ?? faceForName(source.name)).color.value)
  const base = rgb(fill)
  const amount = WASH[scheme]
  const mixed = base.map((channel, index) => Math.round(channel + (color[index]! - channel) * amount))

  return `#${mixed.map(channel => channel.toString(16).padStart(2, '0')).join('')}`
}
