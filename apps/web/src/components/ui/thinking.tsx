import type { AvatarStyle } from '../../lib/avatar-builder'

import { Avatar } from './avatar'

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
 * The bot's face, alone, bobbing where its next bubble will land. That is
 * the whole working indicator: no spinner, no ring, no "thinking" copy.
 */
export function Thinking({ face = true, image, label, name, style }: ThinkingProps) {
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
        <div className="hex-think shrink-0">
          <Avatar image={image} mood="working" name={name} size="md" style={style} />
        </div>
      ) : null}
      {label ? (
        <span className="truncate text-[length:var(--text-secondary)] text-muted">{label}</span>
      ) : null}
    </div>
  )
}
