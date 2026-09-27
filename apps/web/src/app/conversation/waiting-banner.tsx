import { CircleHelp } from 'lucide-react'

/**
 * Pinned under the header, above the transcript, while a bot waits on the
 * user. Names the bot in a room, where more than one could be asking.
 */
export function WaitingBanner({ name }: { name?: string }) {
  return (
    <div
      className="hex-fade flex shrink-0 items-center gap-2 border-b border-accent/20 bg-accent/10 px-4 py-2 text-[length:var(--text-secondary)] text-accent"
      data-testid="waiting-banner"
      role="status"
    >
      <CircleHelp aria-hidden className="shrink-0" size={14} />
      <span className="truncate">{name ? `${name} is waiting on you` : 'Waiting on you'}</span>
    </div>
  )
}
