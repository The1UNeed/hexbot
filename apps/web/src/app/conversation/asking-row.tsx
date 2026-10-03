import { ChevronRight } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { Avatar } from '../../components/ui/avatar'
import { sectionsThread } from '../../lib/api'
import type { AvatarStyle } from '../../lib/avatar-builder'
import { avatarSrc } from '../../lib/avatar-builder'
import { cn } from '../../lib/cn'
import type { Message } from '../../lib/types'
import { useBot } from '../../stores/bots'
import { useSections } from '../../stores/sections'
import { useTranscript, useTranscripts } from '../../stores/transcripts'
import { uiActions } from '../../stores/ui'

import { type Ask, askLabel, asks } from './steps'

/** The face of a teammate whose name a room member is not told. */
const TEAMMATE_FACE: AvatarStyle = { color: 'gray', shape: 'round' }

/** How many times to look a running ask's thread up before giving up on its live reply. */
const LOOKUPS = 4

/** Markdown marks that would clutter a one-line preview. */
const MARKS = /[*_`>#]+/g

/**
 * The target's reply as it streams in, read from the thread's live session.
 * The thread is looked up once the ask runs, and again while it is still
 * unknown when a section changes (the thread was just created) or a session
 * appears (the target's session just started, so the thread now names it).
 * Nothing is shown when the lookup is refused (a room member) or fails.
 */
function useLiveReply(ask: Ask, sender: null | string): { streaming: boolean; text: string } {
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
        // Not the owner, or no such thread: the row keeps to its one line.
        lookups.current = LOOKUPS
      }
    )

    return () => {
      stale = true
    }
  }, [ask.target, liveId, sections, sender, sessions, wanted])

  const transcript = useTranscript(wanted ? liveId : null)
  const streamingId = transcript?.streamingMessageId ?? null

  const text = streamingId
    ? (transcript?.messages.find(message => message.id === streamingId)?.text ?? '')
    : ''

  return {
    streaming: Boolean(streamingId),
    text: text.replace(MARKS, '').replace(/\s+/g, ' ').trim()
  }
}

const doneClass =
  'flex max-w-full items-center gap-1.5 rounded-full py-0.5 pr-2 pl-0.5 text-[length:var(--text-meta)] text-muted'

/**
 * One ask: the two bots' faces turned toward each other. While it runs they
 * are full size with "Research is asking Writer", and Writer's reply shows
 * under that line as it streams. Done, the row settles to two small faces
 * still glancing at each other and "Writer helped". Opens the private
 * conversation between the two bots. A room member sees the ask without
 * its arguments: "Research is asking a teammate", nothing to open.
 */
function AskRow({ ask, sender }: { ask: Ask; sender: null | string }) {
  const target = useBot(ask.target)
  const from = useBot(sender)
  const running = ask.status === 'running'
  const targetName = ask.target ? (target?.display_name ?? ask.target) : null
  const senderName = sender ? (from?.display_name ?? sender) : null
  const label = askLabel(ask, targetName, senderName)
  const canOpen = Boolean(ask.target && sender)
  const reply = useLiveReply(ask, sender)

  // The thread id arrives with the result; an open panel that was still looking it up takes it.
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

  const faces = (size: 'md' | 'xs') => (
    <span className="flex shrink-0 items-center">
      <span className={cn(size === 'md' && 'hex-lean-right')}>
        <Avatar
          className="hex-look-right"
          image={avatarSrc(from?.avatar)}
          mood={running ? 'listening' : undefined}
          name={senderName ?? 'Bot'}
          size={size}
        />
      </span>
      <span className={cn(size === 'md' ? 'hex-lean-left' : '-ml-0.5')}>
        <Avatar
          className={cn('hex-look-left', running && reply.streaming && 'hex-think')}
          image={avatarSrc(target?.avatar)}
          mood={running ? (reply.streaming ? 'working' : 'listening') : undefined}
          name={targetName ?? 'Teammate'}
          size={size}
          {...(ask.target ? {} : { style: TEAMMATE_FACE })}
        />
      </span>
    </span>
  )

  if (running) {
    const body = (
      <>
        {faces('md')}
        <span className="ml-1 flex min-w-0 flex-col justify-center text-left">
          <span className="text-[length:var(--text-secondary)] text-foreground">{label}</span>
          {reply.text ? (
            <span className="truncate text-[length:var(--text-meta)] text-muted">{reply.text}</span>
          ) : null}
        </span>
      </>
    )

    return (
      <li
        aria-live="polite"
        className="hex-rise py-1"
        data-status="running"
        data-testid="asking-row"
        role="status"
      >
        {canOpen ? (
          <button
            aria-label={openLabel}
            className="group/ask flex max-w-full items-center gap-2 rounded-full pr-2 transition-colors outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-foreground/40"
            onClick={open}
            type="button"
          >
            {body}
            <ChevronRight
              className="shrink-0 text-muted opacity-0 transition-opacity group-hover/ask:opacity-100 group-focus-visible/ask:opacity-100"
              size={12}
            />
          </button>
        ) : (
          <div className="flex max-w-full items-center gap-2 pr-2">{body}</div>
        )}
      </li>
    )
  }

  if (!canOpen) {
    return (
      <li className={cn(doneClass, 'hex-fade')} data-status="done" data-testid="asking-row">
        {faces('xs')}
        <span className="truncate">{label}</span>
      </li>
    )
  }

  return (
    <li className="hex-fade" data-status="done" data-testid="asking-row">
      <button
        aria-label={openLabel}
        className={cn(
          doneClass,
          'group/ask transition-colors outline-none hover:bg-surface-2 hover:text-foreground focus-visible:ring-2 focus-visible:ring-foreground/40'
        )}
        onClick={open}
        type="button"
      >
        {faces('xs')}
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
 * Under a bot's message: one row per bot it asked for help this turn,
 * visible from the first moment and kept once done. `sender` is the bot
 * speaking: the section's bot, or the author of a room turn.
 */
export function AskingRow({ message, sender }: { message: Message; sender: null | string }) {
  return <AskRows asks={asks(message)} sender={sender} />
}

/** The rows for asks known some other way, such as a finished room turn's stored asks. */
export function AskRows({ asks: list, sender }: { asks: Ask[]; sender: null | string }) {
  if (!list.length) {
    return null
  }

  return (
    <ul className="flex flex-col" data-testid="asking-rows">
      {list.map(ask => (
        <AskRow ask={ask} key={ask.target ?? 'teammate'} sender={sender} />
      ))}
    </ul>
  )
}
