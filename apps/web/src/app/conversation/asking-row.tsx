import { ChevronRight } from 'lucide-react'
import { useEffect } from 'react'

import { Avatar } from '../../components/ui/avatar'
import { avatarSrc } from '../../lib/avatar-builder'
import { cn } from '../../lib/cn'
import type { Message } from '../../lib/types'
import { useBot } from '../../stores/bots'
import { uiActions } from '../../stores/ui'

import { type Ask, askLabel, asks } from './steps'

const rowClass =
  'flex items-center gap-1.5 rounded-full py-0.5 pr-1.5 pl-0.5 text-[length:var(--text-meta)] text-muted'

/**
 * One ask: the other bot's face, working while the ask runs, and "Asking
 * Writer" / "Asked Writer". Opens the private conversation between the two
 * bots. A room member sees the call without its arguments: "Asking a
 * teammate", nothing to open.
 */
function AskRow({ ask, sender }: { ask: Ask; sender: null | string }) {
  const target = useBot(ask.target)
  const from = useBot(sender)
  const running = ask.status === 'running'
  const targetName = ask.target ? (target?.display_name ?? ask.target) : null
  const label = askLabel(ask.status, targetName)
  const canOpen = Boolean(ask.target && sender)

  // The thread id arrives with the result; an open panel that was still looking it up takes it.
  useEffect(() => {
    if (ask.target && sender && ask.sectionId) {
      uiActions().resolveThread(ask.target, sender, ask.sectionId)
    }
  }, [ask.sectionId, ask.target, sender])

  const face = (
    <Avatar
      className={cn(running && 'hex-think')}
      image={avatarSrc(target?.avatar)}
      mood={running ? 'working' : undefined}
      name={targetName ?? 'Teammate'}
      size="xs"
    />
  )

  if (!canOpen) {
    return (
      <li className={rowClass} data-testid="asking-row">
        {face}
        <span className="truncate">{label}</span>
      </li>
    )
  }

  return (
    <li data-testid="asking-row">
      <button
        aria-label={`Open the conversation between ${from?.display_name ?? sender} and ${targetName}`}
        className={cn(
          rowClass,
          'group/ask max-w-full transition-colors outline-none hover:bg-surface-2 hover:text-foreground focus-visible:ring-2 focus-visible:ring-foreground/40'
        )}
        onClick={() =>
          uiActions().openThread({
            bot: ask.target!,
            peer: sender!,
            ...(ask.sectionId ? { sectionId: ask.sectionId } : {})
          })
        }
        type="button"
      >
        {face}
        <span className="truncate">{label}</span>
        <ChevronRight
          className="shrink-0 opacity-0 transition-opacity group-hover/ask:opacity-100 group-focus-visible/ask:opacity-100"
          size={12}
        />
      </button>
    </li>
  )
}

/**
 * Above a bot's bubble, after its work line: one row per bot it asked for
 * help this turn, visible from the first moment and kept once done. `sender`
 * is the bot speaking: the section's bot, or the author of a room turn.
 */
export function AskingRow({ message, sender }: { message: Message; sender: null | string }) {
  const list = asks(message)

  if (!list.length) {
    return null
  }

  return (
    <ul className="mt-1 flex flex-wrap gap-1" data-testid="asking-rows">
      {list.map(ask => (
        <AskRow ask={ask} key={ask.target ?? 'teammate'} sender={sender} />
      ))}
    </ul>
  )
}
