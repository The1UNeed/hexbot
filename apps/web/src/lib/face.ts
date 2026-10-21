/**
 * The live bot face: the `<morph-bot>` Web Component from the open Grok bot
 * reconstruction (`src/vendor/morph-bot/`, see its NOTICE.md), as it is. This
 * module is the one place that loads it, and it gives the app the words it
 * uses for a face: a mood is one of the component's 39 states, a shape is
 * one of Hexbot's eight, drawn as the component shape nearest to it
 * (`face-rest.ts`), and a look turns the head toward a neighbour.
 */

import {
  MORPH_BOT_STATES,
  type MorphBotElement,
  type MorphBotProject,
  type MorphBotShape,
  type MorphBotState
} from '../vendor/morph-bot/morph-bot.js'

import { FACE_REST } from './face-rest'

export type { MorphBotElement, MorphBotShape }

/** What a face is doing: one of the component's states. */
export type FaceMood = MorphBotState

/** Turned toward a neighbour, as the two faces of an ask are. */
export type FaceLook = 'left' | 'right'

/** Every mood, idle first. */
export const FACE_MOODS: readonly FaceMood[] = MORPH_BOT_STATES

/** The component's view box: a 228-unit head with room around it for its parts. */
export const FACE_VIEWBOX = '-15 -15 259 259'

/** The component shape a Hexbot shape is drawn as; the first shape for an unknown id. */
export function faceShape(shapeId: string): MorphBotShape {
  return (FACE_REST[shapeId] ?? FACE_REST.round!).shape
}

/** How far a look turns the head, in degrees, and shifts it, in head units. */
const LOOK_TURN = 10
const LOOK_SHIFT = 2

/**
 * The component preset for a look and for holding still: the same tuning
 * over every state. `null` when neither applies, so the component keeps its
 * own defaults.
 */
export function facePreset(look: FaceLook | null, still: boolean): MorphBotProject | null {
  if (!look && !still) {
    return null
  }

  const side = look === 'left' ? -1 : look === 'right' ? 1 : 0

  const tuning = {
    ...(side && { headRotation: side * LOOK_TURN, headX: side * LOOK_SHIFT }),
    ...(still && { motionScale: 0 })
  }

  return { states: Object.fromEntries(FACE_MOODS.map(mood => [mood, tuning])) }
}

/** The face that goes with a status, as the mobile app pairs them: the eyes say what the dot says. */
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

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'morph-bot': React.DetailedHTMLProps<
        React.HTMLAttributes<MorphBotElement>,
        MorphBotElement
      > & {
        color?: string
        decorative?: string
        'eye-color'?: string
        'follow-pointer'?: string
        paused?: boolean
        shape?: MorphBotShape
        size?: number
        state?: FaceMood
      }
    }
  }
}
