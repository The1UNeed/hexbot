/**
 * Generated bot faces: a shape and a colour with two small eyes. Drawn as
 * SVG in the UI and rasterised to PNG for the profile asset (the daemon
 * accepts png, jpeg or webp only). Bots without an uploaded avatar get a
 * face derived from their name so every bot has one.
 */

import { hueFromString } from './cn'

export interface AvatarStyle {
  color: string
  shape: string
}

export const AVATAR_SHAPES: { id: string; label: string; path: string }[] = [
  { id: 'round', label: 'Round', path: 'M50 5a45 45 0 1 1 0 90a45 45 0 1 1 0-90Z' },
  {
    id: 'squircle',
    label: 'Squircle',
    path: 'M50 5c34 0 45 11 45 45S84 95 50 95 5 84 5 50 16 5 50 5Z'
  },
  {
    id: 'square',
    label: 'Square',
    path: 'M24 7h52a17 17 0 0 1 17 17v52a17 17 0 0 1-17 17H24A17 17 0 0 1 7 76V24A17 17 0 0 1 24 7Z'
  },
  {
    id: 'pill',
    label: 'Pill',
    path: 'M50 20c31 0 47 13 47 30S81 80 50 80 3 67 3 50s16-30 47-30Z'
  },
  {
    id: 'triangle',
    label: 'Triangle',
    path: 'M43 12a8 8 0 0 1 14 0l38 66a8 8 0 0 1-7 12H12a8 8 0 0 1-7-12Z'
  },
  {
    id: 'hexagon',
    label: 'Hexagon',
    path: 'M44 6a12 12 0 0 1 12 0l30 17a12 12 0 0 1 6 10v34a12 12 0 0 1-6 10L56 94a12 12 0 0 1-12 0L14 77a12 12 0 0 1-6-10V33a12 12 0 0 1 6-10Z'
  },
  {
    id: 'cloud',
    label: 'Cloud',
    path: 'M26 85a19 19 0 0 1-5.9-37 28 28 0 0 1 55.8-4.6 21 21 0 0 1-3.9 41.6Z'
  },
  { id: 'drop', label: 'Drop', path: 'M50 5c12.7 19.8 38 36.3 38 52a38 38 0 0 1-76 0C12 41.3 37.3 24.8 50 5Z' }
]

export const AVATAR_COLORS: { id: string; label: string; value: string }[] = [
  { id: 'white', label: 'Chalk', value: '#ececf0' },
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

const EYES = '#151517'

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
  return {
    color: AVATAR_COLORS.find(item => item.id === style.color) ?? AVATAR_COLORS[0]!,
    shape: AVATAR_SHAPES.find(item => item.id === style.shape) ?? AVATAR_SHAPES[0]!
  }
}

/** The eyes as SVG markup, shared by the inline face and the rasterised one. */
export function faceEyes(): string {
  return (
    `<g class="hex-eyes">` +
    `<ellipse cx="41" cy="48" rx="3.6" ry="6.2" fill="${EYES}"/>` +
    `<ellipse cx="59" cy="48" rx="3.6" ry="6.2" fill="${EYES}"/>` +
    `</g>`
  )
}

/** The face as an SVG document (100×100 viewBox). */
export function avatarSvg(style: AvatarStyle): string {
  const { color, shape } = resolveStyle(style)

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">` +
    `<path d="${shape.path}" fill="${color.value}"/>` +
    faceEyes() +
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
