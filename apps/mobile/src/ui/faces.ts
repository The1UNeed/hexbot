/**
 * Bot faces: a shape and a colour with two eyes, the same set the web app
 * draws (apps/web/src/lib/avatar-builder.ts). Keep the two in step so a bot
 * looks the same on every client.
 */

export interface FaceStyle {
  color: string
  shape: string
}

/** What the face is doing; the eyes change shape with it. */
export type FaceMood = 'happy' | 'idle' | 'listening' | 'sleeping' | 'working'

export const FACE_SHAPES: { id: string; label: string; path: string }[] = [
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
  {
    id: 'drop',
    label: 'Drop',
    path: 'M50 5c12.7 19.8 38 36.3 38 52a38 38 0 0 1-76 0C12 41.3 37.3 24.8 50 5Z'
  }
]

export const FACE_COLORS: { id: string; label: string; value: string }[] = [
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

export const FACE_EYES = '#151517'

export const EYES: Record<FaceMood, { cy: number; gap: number; rx: number; ry: number }> = {
  happy: { cy: 46, gap: 19, rx: 4.4, ry: 3 },
  idle: { cy: 48, gap: 18, rx: 3.6, ry: 6.2 },
  listening: { cy: 52, gap: 16, rx: 3.8, ry: 4.6 },
  sleeping: { cy: 50, gap: 18, rx: 4.2, ry: 0.9 },
  working: { cy: 49, gap: 17, rx: 3.2, ry: 4.4 }
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
  return {
    color: FACE_COLORS.find(item => item.id === style.color) ?? FACE_COLORS[0]!,
    shape: FACE_SHAPES.find(item => item.id === style.shape) ?? FACE_SHAPES[0]!
  }
}
