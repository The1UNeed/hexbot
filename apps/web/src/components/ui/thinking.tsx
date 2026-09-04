import { Avatar } from './avatar'

export interface ThinkingProps {
  image?: null | string
  name: string
}

/**
 * The bot's face bobbing while it thinks, with a little thought bubble.
 * Shown in place of the first assistant row until the first token arrives.
 */
export function Thinking({ image, name }: ThinkingProps) {
  return (
    <div
      aria-label={`${name} is thinking`}
      className="flex items-end gap-2 py-2"
      data-testid="thinking"
      role="status"
    >
      <div className="hex-think relative w-8 shrink-0">
        <Avatar image={image} name={name} />
      </div>
      <div className="hex-bubble mb-1 flex items-center gap-1 rounded-bubble bg-surface-2 px-3 py-2">
        <span className="hex-dot size-1.5 rounded-full bg-muted" />
        <span
          className="hex-dot size-1.5 rounded-full bg-muted"
          style={{ animationDelay: '150ms' }}
        />
        <span
          className="hex-dot size-1.5 rounded-full bg-muted"
          style={{ animationDelay: '300ms' }}
        />
      </div>
    </div>
  )
}
