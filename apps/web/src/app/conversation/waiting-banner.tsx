import { CircleHelp } from 'lucide-react'

/**
 * A small glass pill pinned under the header while a bot waits on the user.
 * Names the bot in a room, where more than one could be asking.
 */
export function WaitingBanner({ name }: { name?: string }) {
  return (
    <div
      className="hex-glass hex-fade pointer-events-auto mx-auto flex w-fit max-w-full shrink-0 items-center gap-2 rounded-full px-3.5 py-1.5 text-[length:var(--text-secondary)] font-medium text-accent"
      data-testid="waiting-banner"
      role="status"
    >
      <CircleHelp aria-hidden className="shrink-0" size={14} />
      <span className="truncate">{name ? `${name} is waiting on you` : 'Waiting on you'}</span>
    </div>
  )
}
