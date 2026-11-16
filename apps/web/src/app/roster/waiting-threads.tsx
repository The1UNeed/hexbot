import { Avatar } from '../../components/ui/avatar'
import { botFace } from '../../lib/avatar-builder'
import type { Bot } from '../../lib/types'
import { uiActions } from '../../stores/ui'

/**
 * Bots waiting on you in a thread, the conversation in which another bot
 * asked them for help. A thread has no row of its own, so without this the
 * bot's dot asks for you and nothing leads to the card.
 */
export function waitingInThreads(bots: Bot[]): Bot[] {
  return bots.filter(bot => bot.status === 'needs_you' && Boolean(bot.status_detail?.peer_bot))
}

/** One line per bot waiting in a thread; each opens that thread beside the chat. */
export function WaitingThreads({ bots }: { bots: Bot[] }) {
  const waiting = waitingInThreads(bots)

  if (!waiting.length) {
    return null
  }

  return (
    <div className="grid gap-1 pb-1" data-testid="roster-waiting">
      {waiting.map(bot => (
        <button
          className="flex w-full items-center gap-2.5 rounded-panel bg-foreground/[0.04] px-2.5 py-2 text-left outline-none transition-colors duration-[var(--hex-motion-fast)] hover:bg-foreground/[0.07] focus-visible:ring-1 focus-visible:ring-foreground/40"
          key={bot.name}
          onClick={() =>
            uiActions().openThread({
              bot: bot.name,
              peer: bot.status_detail!.peer_bot!,
              ...(bot.status_detail?.section_id ? { sectionId: bot.status_detail.section_id } : {})
            })
          }
          type="button"
        >
          <Avatar {...botFace(bot)} mood="listening" name={bot.display_name} size="sm" />
          <span className="min-w-0 flex-1 truncate text-[length:var(--text-secondary)]">
            {bot.display_name} is waiting for you
          </span>
          <span className="shrink-0 text-[length:var(--text-secondary)] font-medium text-accent">
            Review
          </span>
        </button>
      ))}
    </div>
  )
}
