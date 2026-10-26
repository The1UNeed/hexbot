/**
 * Hexbot's 100-unit outlines and palette, extracted from avatar-builder.ts,
 * with the capsule eyes of the Hexbot icon. Every mood is a pose of the same
 * capsule. No third-party geometry or behaviour data. See
 * docs/face-provenance.md.
 */

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
export const INK = '#151517'

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
 * What the face is doing. The capsule eyes change with it: upright while idle,
 * wide while it waits on you, narrowed and lowered while it writes, squinted
 * when something went well, shut when it sleeps.
 */
export type FaceMood =
  | 'happy'
  | 'idle'
  | 'listening'
  | 'loading'
  | 'searching'
  | 'sleeping'
  | 'thinking'
  | 'working'
  | 'writing'

/** The radius of the ball frame; eye sizes and poses below are in its units. */
export const BALL = 45

/** Distance between the two eye centres in the ball frame. */
export const EYE_GAP = 29

/**
 * One eye: the upright capsule of the Hexbot icon, one unit from its centre to
 * the top. At the idle size it is the icon's 11.7 by 27 eye. Every pose scales
 * and turns this same outline.
 */
export const CAPSULE_EYE =
  'M-0.4333 -0.5667A0.4333 0.4333 0 0 1 0.4333 -0.5667V0.5667A0.4333 0.4333 0 0 1 -0.4333 0.5667Z'

/**
 * How a mood holds the eyes in the ball frame: both shifted by `dx` and `dy`,
 * `size` from centre to top, flattened to `squash` of their height, and
 * turned by `turn` degrees (90 lays the capsule on its side).
 */
export interface EyePose {
  dx: number
  dy: number
  size: number
  squash: number
  turn: number
}

export const EYE_MOODS: Record<FaceMood, EyePose> = {
  happy: { dx: 0, dy: -2, size: 9.5, squash: 0.7, turn: 90 },
  idle: { dx: 0, dy: 0, size: 13.5, squash: 1, turn: 0 },
  listening: { dx: 0, dy: 1, size: 14.5, squash: 1, turn: 0 },
  loading: { dx: 0, dy: 0, size: 11, squash: 1, turn: 0 },
  searching: { dx: 0, dy: -2, size: 12.5, squash: 1, turn: 0 },
  sleeping: { dx: 0, dy: 3, size: 9, squash: 0.2, turn: 90 },
  thinking: { dx: 2, dy: -4, size: 11, squash: 1, turn: 0 },
  working: { dx: 0, dy: 1, size: 12.5, squash: 1, turn: 0 },
  writing: { dx: 0, dy: 5, size: 12, squash: 0.7, turn: 0 }
}

/** Where one eye sits and how it is drawn, in the ball frame. */
export interface EyePlacement {
  sx: number
  sy: number
  turn: number
  x: number
  y: number
}

/** The two eyes of a mood, left then right. */
export function eyePlacements(mood: FaceMood = 'idle'): EyePlacement[] {
  const pose = EYE_MOODS[mood]

  return [-1, 1].map(side => ({
    sx: pose.size,
    sy: pose.size * pose.squash,
    turn: pose.turn,
    x: side * (EYE_GAP / 2) + pose.dx,
    y: pose.dy
  }))
}

/** An eye's `transform` attribute, for still pictures. */
export function eyeTransform({ sx, sy, turn, x, y }: EyePlacement): string {
  return `translate(${x} ${y}) scale(${sx} ${sy}) rotate(${turn})`
}

/** The same transform as CSS, so the eyes ease from one mood to the next. */
export function eyeTransformCss({ sx, sy, turn, x, y }: EyePlacement): string {
  return `translate(${x}px, ${y}px) scale(${sx}, ${sy}) rotate(${turn}deg)`
}

/** The `transform` that takes the ball frame onto a shape. */
export function ballTransform(ball: Ball): string {
  return `translate(50 ${ball.cy}) scale(${ball.r / BALL})`
}

export type FaceLook = 'left' | 'right'

/** Small fixed poses, also used when motion is disabled. */
export function facePose(mood: FaceMood, look?: FaceLook | null): string {
  if (look) {
    return `translate(${look === 'left' ? -10 : 10} -2)`
  }

  return mood === 'searching' ? 'translate(5 -2)' : 'translate(0 0)'
}
