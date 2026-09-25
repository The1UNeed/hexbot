export interface ThinkingProps {
  /** The step in progress, shown while a tool runs. */
  label?: string
  name: string
}

/**
 * The line beside the bot's face while it works: the running step, or
 * nothing but the announcement. The face itself sits in the message column
 * and bobs (`hex-think`); that is the whole working indicator.
 */
export function Thinking({ label, name }: ThinkingProps) {
  return (
    <div
      aria-label={label ? `${name}: ${label}` : `${name} is working`}
      aria-live="polite"
      className="hex-fade mt-1 flex min-h-6 items-center pb-1 text-[length:var(--text-meta)] text-muted"
      data-testid="thinking"
      role="status"
    >
      {label ? <span className="truncate">{label}</span> : null}
    </div>
  )
}
