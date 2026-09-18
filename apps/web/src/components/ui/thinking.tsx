import { useEffect, useState } from 'react'

import type { AvatarStyle } from '../../lib/avatar-builder'

import { Avatar } from './avatar'
import type { HexbotActName } from './hexbot-act'

/** What a bot does while it works on a reply, in turn. */
const WORK_ACTS: HexbotActName[] = ['type', 'read', 'tinker', 'inspect', 'hammer', 'coffee']

export interface ThinkingProps {
  /** False once a bubble already carries the face: only the label is drawn. */
  face?: boolean
  image?: null | string
  /** The step in progress, shown beside the face only while a tool runs. */
  label?: string
  name: string
  style?: AvatarStyle
}

/**
 * The bot's face, alone, busy with an act where its next bubble will land.
 * That is the whole working indicator: no spinner, no ring, no "thinking" copy.
 */
export function Thinking({ face = true, image, label, name, style }: ThinkingProps) {
  const [turn, setTurn] = useState(0)

  useEffect(() => {
    const timer = setInterval(() => setTurn(value => value + 1), 8000)

    return () => clearInterval(timer)
  }, [])

  if (!face && !label) {
    return null
  }

  return (
    <div
      aria-label={label ? `${name}: ${label}` : `${name} is working`}
      aria-live="polite"
      className="hex-fade flex items-center gap-2 py-1"
      data-testid="thinking"
      role="status"
    >
      {face ? (
        <Avatar
          act={WORK_ACTS[turn % WORK_ACTS.length]}
          className="mr-5 shrink-0"
          image={image}
          name={name}
          size="md"
          style={style}
        />
      ) : null}
      {label ? (
        <span className="truncate text-[length:var(--text-secondary)] text-muted">{label}</span>
      ) : null}
    </div>
  )
}
