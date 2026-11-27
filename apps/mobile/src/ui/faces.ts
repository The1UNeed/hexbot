/**
 * Bot faces: a shape and a colour with two capsule eyes painted on a ball,
 * the same set the web app draws (apps/web/src/lib/avatar-builder.ts). Keep
 * the two in step so a bot looks the same on every client.
 */

import {
  AVATAR_COLORS as FACE_COLORS,
  AVATAR_SHAPES as FACE_SHAPES,
  type AvatarStyle as FaceStyle,
  EYES as FACE_EYES,
  NAME_COLORS,
  NAME_SHAPES,
  NEUTRAL_COLORS
} from './face-geometry'

export {
  AVATAR_COLORS as FACE_COLORS,
  AVATAR_SHAPES as FACE_SHAPES,
  type AvatarStyle as FaceStyle,
  BALL,
  type Ball,
  ballTransform,
  EYE_MOODS,
  eyePlacements,
  eyeTransform,
  EYES as FACE_EYES,
  facePose,
  type FaceMood,
  CAPSULE_EYE
} from './face-geometry'

function hueFromString(value: string): number {
  let hash = 0

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) % 360_000
  }

  return hash % 360
}

/**
 * The face a bot without a stored one draws: an older daemon's bots, and room
 * members known only by name. The daemon stores a face for every bot it has.
 */
export function faceForName(name: string): FaceStyle {
  const hue = hueFromString(name)

  return {
    color: NAME_COLORS[hue % NAME_COLORS.length]!,
    shape: NAME_SHAPES[Math.floor(hue / 7) % NAME_SHAPES.length]!
  }
}

/**
 * A random face for a new bot, one none of `taken` has while any is left; the
 * daemon picks the same way when a client sends none. The bot keeps it
 * whatever it is called.
 */
export function randomFace(taken: readonly (FaceStyle | null | undefined)[] = []): FaceStyle {
  const colors = FACE_COLORS.filter(item => !NEUTRAL_COLORS.includes(item.id))
  const all = FACE_SHAPES.flatMap(shape =>
    colors.map(color => ({ color: color.id, shape: shape.id }))
  )
  const free = all.filter(
    face => !taken.some(other => other?.shape === face.shape && other?.color === face.color)
  )
  const pool = free.length ? free : all

  return pool[Math.floor(Math.random() * pool.length)]!
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
 * A bot's face colour and the colour its eyes are painted in, for things drawn
 * in the bot's colour. Null for a bot with an uploaded picture.
 */
export function faceColor(source: FaceSourceLike): { color: string; on: string } | null {
  if (source.imageUri) {
    return null
  }

  const { color, eyes } = resolveFace(source.face ?? faceForName(source.name))

  return { color: color.value, on: eyes }
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
