import { Menu } from '@base-ui/react/menu'
import { SmilePlus } from 'lucide-react'

import { cn } from '../../lib/cn'
import { REACTIONS, useMessageReactions, useReactions } from '../../stores/reactions'

/** What a reaction reads as to a screen reader; the glyph alone says little. */
const NAMES: Record<string, string> = {
  '❤️': 'heart',
  '🎉': 'celebrate',
  '👍': 'thumbs up',
  '👎': 'thumbs down',
  '😂': 'laugh',
  '🤔': 'thinking'
}

const nameOf = (emoji: string) => NAMES[emoji] ?? emoji

/**
 * The control beside one of a bot's bubbles: a face that opens a row of
 * emoji. The one you already left is marked; picking it again takes it back.
 * Shown on hover, and always on a screen without one.
 */
export function ReactButton({
  messageId,
  sectionId
}: {
  messageId: string
  sectionId: string
}): React.JSX.Element {
  const reactions = useMessageReactions(sectionId, messageId)
  const mine = reactions.find(reaction => reaction.by === 'user')?.emoji

  const react = (emoji: string) =>
    // A refusal puts the bubble back as it was; there is nothing more to say.
    void useReactions
      .getState()
      .react(sectionId, messageId, emoji)
      .catch(() => undefined)

  return (
    <Menu.Root orientation="horizontal">
      <Menu.Trigger
        aria-label="React"
        className="hex-focus grid size-7 shrink-0 place-items-center self-end rounded-full text-muted opacity-0 transition-[opacity,background-color,color] duration-[var(--hex-motion-fast)] group-hover/bubble:opacity-100 hover:bg-foreground/[0.06] hover:text-foreground focus-visible:opacity-100 data-[popup-open]:bg-foreground/[0.06] data-[popup-open]:opacity-100 touch:opacity-100"
        title="React"
      >
        <SmilePlus size={15} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner align="start" className="z-50 outline-none" side="top" sideOffset={6}>
          <Menu.Popup
            aria-label="Reactions"
            className="hex-glass-strong hex-menu-in flex gap-0.5 rounded-full p-1 outline-none"
          >
            {REACTIONS.map(emoji => (
              <Menu.Item
                aria-label={mine === emoji ? `Remove ${nameOf(emoji)}` : nameOf(emoji)}
                className={cn(
                  'grid size-9 cursor-default place-items-center rounded-full text-[19px] leading-none outline-none data-[highlighted]:bg-foreground/[0.08]',
                  mine === emoji && 'bg-foreground/[0.1]'
                )}
                key={emoji}
                onClick={() => react(emoji)}
              >
                {emoji}
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}

const chipClass =
  'hex-fade grid h-[22px] min-w-[26px] place-items-center rounded-full bg-background px-1 text-[13px] leading-none ring-1 ring-foreground/10'

/**
 * The reactions on a bubble: small chips tucked under its corner, as in a
 * messaging app. Yours, on a bot's bubble, is a button that takes it back;
 * the bot's, on yours, only says who left it.
 */
export function BubbleReactions({
  botName,
  inputId,
  messageId,
  mine,
  sectionId
}: {
  /** The bot of the chat, for naming its reaction. */
  botName: string
  /** The key your message was sent with, while it is not read back from history. */
  inputId?: string
  messageId?: string
  /** On your own bubble: the chips sit under its right corner. */
  mine: boolean
  sectionId?: string
}): null | React.JSX.Element {
  const reactions = useMessageReactions(sectionId, messageId, inputId)

  if (!sectionId || !reactions.length) {
    return null
  }

  return (
    <div
      className={cn('relative z-[1] -mt-2 flex gap-1 px-2.5', mine && 'justify-end')}
      data-testid="reactions"
    >
      {reactions.map(reaction =>
        reaction.by === 'user' ? (
          <button
            aria-label={`Remove your ${nameOf(reaction.emoji)} reaction`}
            className={cn(chipClass, 'hex-focus cursor-pointer hover:bg-surface-2')}
            key="user"
            onClick={() =>
              void useReactions
                .getState()
                .react(sectionId, reaction.message_id, reaction.emoji)
                .catch(() => undefined)
            }
            title="Remove your reaction"
            type="button"
          >
            {reaction.emoji}
          </button>
        ) : (
          <span
            aria-label={`${botName} reacted with ${nameOf(reaction.emoji)}`}
            className={chipClass}
            key={`bot:${reaction.bot ?? ''}`}
            role="img"
            title={`${botName} reacted`}
          >
            {reaction.emoji}
          </span>
        )
      )}
    </div>
  )
}
