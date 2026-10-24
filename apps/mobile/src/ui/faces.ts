/**
 * Bot faces: a shape and a colour with two capsule eyes painted on a ball,
 * the same set the web app draws (apps/web/src/lib/avatar-builder.ts). Keep
 * the two in step so a bot looks the same on every client.
 */

import {
  AVATAR_COLORS as FACE_COLORS,
  AVATAR_SHAPES as FACE_SHAPES,
  type AvatarStyle as FaceStyle,
  EYES as FACE_EYES
} from './face-geometry'

export {
  AVATAR_COLORS as FACE_COLORS,
  AVATAR_SHAPES as FACE_SHAPES,
  type AvatarStyle as FaceStyle,
  BALL,
  type Ball,
  ballTransform,
  EYE_MOODS,
  eyeRects,
  EYES as FACE_EYES,
  facePose,
  type FaceMood
} from './face-geometry'

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

/** A bot as the faces here need it; `BotFace`'s props. */
interface FaceSourceLike {
  face?: FaceStyle | null
  imageUri?: string | null
  name: string
}

/**
 * A bot bubble's fill: the plain fill washed with the face colour. A bot with
 * an uploaded picture keeps the plain fill; its colour is not known here.
 */
export function faceWash(source: FaceSourceLike, fill: string, scheme: 'dark' | 'light'): string {
  if (source.imageUri) {
    return fill
  }

  const color = rgb(resolveFace(source.face ?? faceForName(source.name)).color.value)
  const base = rgb(fill)
  const amount = WASH[scheme]
  const mixed = base.map((channel, index) =>
    Math.round(channel + (color[index]! - channel) * amount)
  )

  return `#${mixed.map(channel => channel.toString(16).padStart(2, '0')).join('')}`
}

/**
 * A message bubble's fill: ink for yours, the plain fill for other people,
 * and the bot's wash for a bot. Rooms name the bot on every reply; a bot's own
 * thread sends replies without one, so they belong to the thread's bot.
 */
export function bubbleFill(
  item: { author?: FaceSourceLike | null; role: 'bot' | 'human' | 'user' },
  chat: { face?: FaceSourceLike | null; room: boolean },
  theme: { fill: string; ink: string; scheme: 'dark' | 'light' }
): string {
  if (item.role === 'user') {
    return theme.ink
  }

  const author = item.role === 'bot' ? (item.author ?? (chat.room ? null : chat.face)) : null

  return author ? faceWash(author, theme.fill, theme.scheme) : theme.fill
}
