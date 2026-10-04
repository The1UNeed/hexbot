export interface ThinkingProps {
  /** The step in progress, shown while a tool runs. */
  label?: string
  name: string
}

/**
 * The live capsule for a bot whose turn has started but sent nothing yet,
 * as rooms show it before the first event. Same shape as the chat's live
 * status; the face beside the row bobs (`hex-think`), the capsule does not.
 */
export function Thinking({ label, name }: ThinkingProps) {
  return (
    <div
      aria-label={label ? `${name}: ${label}` : `${name} is working`}
      aria-live="polite"
      className="hex-bubble mt-1 flex"
      data-testid="thinking"
      role="status"
    >
      <span className="flex h-9 max-w-full items-center rounded-full bg-bubble px-3.5 text-[length:var(--text-secondary)] text-muted">
        <span className="truncate">{label ?? `${name} is working`}</span>
      </span>
    </div>
  )
}
