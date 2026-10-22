/** Hexbot's original capsule-eye poses. All coordinates are in the ball frame. */
import { type FaceMood } from './face-geometry'

export type { FaceMood } from './face-geometry'
export { type FaceLook, facePose } from './face-geometry'

export const FACE_MOODS = [
  'idle',
  'thinking',
  'searching',
  'working',
  'writing',
  'listening',
  'happy',
  'sleeping',
  'loading'
] as const satisfies readonly FaceMood[]

export const FACE_VIEWBOX = '0 0 100 100'

export function moodForStatus(status?: null | string): FaceMood {
  switch (status) {
    case 'working':
      return 'working'

    case 'needs_you':
      return 'listening'

    case 'done':
      return 'happy'

    default:
      return 'idle'
  }
}
