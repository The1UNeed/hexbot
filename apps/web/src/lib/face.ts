/** Face moods and the poses they share with mobile. Coordinates are in the ball frame. */
import { type FaceEmotion, type FaceMood } from './face-geometry'

export type { FaceEmotion, FaceMood } from './face-geometry'
export { type FaceLook, facePose } from './face-geometry'

export const FACE_MOODS = [
  'idle',
  'thinking',
  'searching',
  'reading',
  'working',
  'writing',
  'computer',
  'listening',
  'happy',
  'sleeping',
  'loading'
] as const satisfies readonly FaceMood[]

/** Reactions a face shows for a moment over what it is doing; see lib/emotions.ts. */
export const FACE_EMOTIONS = [
  'curious',
  'surprised',
  'shy',
  'confused',
  'frustrated',
  'sad',
  'proud',
  'celebrating',
  'bored',
  'drowsy',
  'excited',
  'amused',
  'cheerful',
  'sheepish',
  'determined',
  'relieved'
] as const satisfies readonly FaceEmotion[]

export const FACE_VIEWBOX = '0 0 100 100'

/**
 * A bot's face for its status. While it works, the live face of the reply it
 * is writing (thinking, searching, writing) when one is open, so the sidebar
 * and the header wear the face the chat shows.
 */
export function moodForStatus(status?: null | string, live?: FaceMood | null): FaceMood {
  if (status === 'working' && live) {
    return live
  }

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
