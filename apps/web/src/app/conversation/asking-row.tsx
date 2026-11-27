import { type CSSProperties, useEffect, useRef, useState } from 'react'

import { Avatar, useFaceColor } from '../../components/ui/avatar'
import { sectionsThread } from '../../lib/api'
import type { AvatarStyle } from '../../lib/avatar-builder'
import { botFace } from '../../lib/avatar-builder'
import { cn } from '../../lib/cn'
import type { Message } from '../../lib/types'
import { useBot } from '../../stores/bots'
import { useSections } from '../../stores/sections'
import { useTranscript, useTranscripts } from '../../stores/transcripts'
import { uiActions } from '../../stores/ui'

import { type Ask, askLabel, asks, askWords, liveMood } from './steps'

/** The face of a teammate whose name the call did not carry. */
const TEAMMATE_FACE: AvatarStyle = { color: 'gray', shape: 'round' }

/** How many times to look a running ask's thread up before giving up on its live reply. */
const LOOKUPS = 4

/**
 * The target's reply while it streams, read from the thread's live session,
 * so its face reacts softly inside the pill while it answers. The reply's
 * text stays in the thread view, and the receiving bot's roster row stays
 * quiet behind the scenes. Nothing changes when the lookup is refused or fails.
 */
function useLiveReply(ask: Ask, sender: null | string): Message | undefined {
  const wanted = ask.status === 'running' && Boolean(ask.target && sender)
  const [liveId, setLiveId] = useState<null | string>(null)
  const lookups = useRef(0)
  // Each refresh of the section index is a chance that the thread now exists, and each new
  // session a chance that it has its live session.
  const sections = useSections(state => state.byId)
  const sessions = useTranscripts(state => Object.keys(state.bySession).length)

  useEffect(() => {
    if (!wanted || liveId || lookups.current >= LOOKUPS) {
      return
    }

    let stale = false
    lookups.current += 1

    sectionsThread(ask.target!, sender!).then(
      ({ section }) => {
        if (!stale && section?.live_session_id) {
          setLiveId(section.live_session_id)
        }
      },
      () => {
        // Not the owner, or no such thread: the face just listens.
        lookups.current = LOOKUPS
      }
    )

    return () => {
      stale = true
    }
  }, [ask.target, liveId, sections, sender, sessions, wanted])

  const transcript = useTranscript(wanted ? liveId : null)
  const streamingId = transcript?.streamingMessageId ?? null

  return streamingId ? transcript?.messages.find(item => item.id === streamingId) : undefined
}

/**
 * One ask, drawn as a centred inline row: a quiet status word beside a rounded
 * pill holding the target bot's face and name ("Messaging [Biology]" while it
 * runs, settling smoothly in place to "Message from [Biology]" or "Messaged
 * [Biology]"). One persistent DOM structure and avatar span both states so the
 * height never jumps and the face interpolates back to idle without remounting.
 * Clicking opens the private conversation in the main view.
 */
function AskRow({
  ask,
  fresh = false,
  sender
}: {
  ask: Ask
  fresh?: boolean
  sender: null | string
}) {
  const target = useBot(ask.target)
  const from = useBot(sender)
  const running = ask.status === 'running'
  const targetName = ask.target ? (target?.display_name ?? ask.target) : null
  const senderName = sender ? (from?.display_name ?? sender) : null
  const label = askLabel(ask, targetName, senderName)
  const { before } = askWords(ask, senderName)
  const canOpen = Boolean(ask.target && sender)
  const reply = useLiveReply(ask, sender)
  const tint = useFaceColor(target, targetName)
  // Settled history draws its prefix still; only live rows or observed status transitions animate.
  const [lastBefore, setLastBefore] = useState(before)
  const [transitioned, setTransitioned] = useState(false)

  if (before !== lastBefore) {
    setLastBefore(before)
    setTransitioned(true)
  }

  const animateLabel = running || fresh || transitioned

  // The thread id arrives with the result; an open view that was still looking it up takes it.
  useEffect(() => {
    if (ask.target && sender && ask.sectionId) {
      uiActions().resolveThread(ask.target, sender, ask.sectionId)
    }
  }, [ask.sectionId, ask.target, sender])

  const open = () =>
    uiActions().openThread({
      bot: ask.target!,
      peer: sender!,
      ...(ask.sectionId ? { sectionId: ask.sectionId } : {})
    })

  const openLabel = `Open the conversation between ${senderName ?? 'the bot'} and ${targetName}`

  const content = (
    <>
      <span className="hex-ask-prefix shrink-0 text-muted">
        <span
          className={cn(animateLabel && 'hex-ask-label', running && 'hex-ask-live-text')}
          key={before}
        >
          {before}
        </span>
      </span>{' '}
      <span
        className={cn(
          'relative inline-flex h-7 min-w-0 max-w-full items-center gap-1.5 rounded-full bg-surface-2 pr-2.5 pl-1.5 text-[length:var(--text-secondary)] font-medium text-foreground/90 ring-1 ring-inset ring-foreground/[0.06] transition-[background-color,box-shadow,color] duration-[var(--hex-motion-panel)] ease-[var(--hex-ease-out)]',
          canOpen &&
            'group-hover/ask:bg-surface-3 group-hover/ask:text-foreground group-hover/ask:ring-foreground/[0.1]'
        )}
        style={tint ? ({ '--hex-ask-tint': tint } as CSSProperties) : undefined}
      >
        <span
          aria-hidden
          className={cn(
            'hex-ask-ring absolute inset-0 rounded-full transition-opacity duration-[var(--hex-motion-panel)] ease-[var(--hex-ease-out)]',
            running ? 'hex-ask-ring-live opacity-100' : 'opacity-0'
          )}
        />
        <Avatar
          {...botFace(target)}
          className="size-[18px] shrink-0"
          mood={running ? (reply ? (liveMood(reply) ?? 'listening') : 'listening') : 'idle'}
          name={targetName ?? 'Teammate'}
          size="xs"
          {...(ask.target ? {} : { style: TEAMMATE_FACE })}
        />
        <span className="truncate">{targetName ?? 'a teammate'}</span>
      </span>
    </>
  )

  return (
    <li
      aria-label={label}
      aria-live={running ? 'polite' : undefined}
      className={cn((running || fresh) && 'hex-ask-enter', 'flex max-w-full justify-center py-1')}
      data-status={running ? 'running' : 'done'}
      data-testid="asking-row"
      role={running ? 'status' : undefined}
    >
      {canOpen ? (
        <button
          aria-label={openLabel}
          className="group/ask hex-focus inline-flex max-w-full items-center gap-2 rounded-full py-0.5 pr-0.5 pl-1 transition-transform duration-[var(--hex-motion-fast)] ease-[var(--hex-ease-out)] active:scale-[0.98] motion-reduce:active:scale-100"
          onClick={open}
          title={label}
          type="button"
        >
          {content}
        </button>
      ) : (
        <div className="inline-flex max-w-full items-center gap-2 py-0.5 pr-0.5 pl-1">
          {content}
        </div>
      )}
    </li>
  )
}

/**
 * Under a bot's message: one row per bot it messaged this turn, visible from
 * the first moment and settled cleanly in place once done. The rows sit in the
 * middle of the column, like the time between messages: they mark what
 * happened, and neither side said them. `sender` is the bot speaking: the
 * section's bot, or the author of a room turn.
 */
export function AskingRow({
  fresh = false,
  message,
  sender
}: {
  fresh?: boolean
  message: Message
  sender: null | string
}) {
  return <AskRows asks={asks(message)} fresh={fresh} sender={sender} />
}

/** The rows for asks known some other way, such as a finished room turn's stored asks. */
export function AskRows({
  asks: list,
  fresh = false,
  sender
}: {
  asks: Ask[]
  fresh?: boolean
  sender: null | string
}) {
  if (!list.length) {
    return null
  }

  return (
    <ul className="flex flex-col items-center py-1.5" data-testid="asking-rows">
      {list.map(ask => (
        <AskRow ask={ask} fresh={fresh} key={ask.target ?? 'teammate'} sender={sender} />
      ))}
    </ul>
  )
}
