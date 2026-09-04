import type { AvatarStyle } from '../../lib/avatar-builder'

import { Avatar } from './avatar'

export interface ThinkingProps {
  image?: null | string
  name: string
  style?: AvatarStyle
}

/**
 * The bot's face bobbing while it works. Shown in place of the first
 * assistant row until the first token arrives.
 */
export function Thinking({ image, name, style }: ThinkingProps) {
  return (
    <div
      aria-label={`${name} is thinking`}
      className="hex-fade flex items-center gap-2.5 py-2"
      data-testid="thinking"
      role="status"
    >
      <div className="hex-think shrink-0">
        <Avatar image={image} name={name} size="sm" style={style} />
      </div>
      <span className="hex-pulse text-[length:var(--text-secondary)] text-muted">
        {name} is working
      </span>
    </div>
  )
}
