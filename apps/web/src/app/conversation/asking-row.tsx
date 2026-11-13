import { ChevronRight } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { Avatar } from '../../components/ui/avatar'
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
import { BotName } from './tags'

/** The face of a teammate whose name the call did not carry. */
const TEAMMATE_FACE: AvatarStyle = { color: 'gray', shape: 'round' }

/** How many times to look a running ask's thread up before giving up on its live reply. */
const LOOKUPS = 4

/**
 * The target's reply while it streams, read from the thread's live session,
 * so its face writes as it answers. The reply's text stays in the thread:
 * the row keeps to its one line until the answer is in. The thread is looked
 * up once the ask runs, and again while it is still unknown when a section
 * changes (the thread was just created) or a session appears (the target's
 * session just started, so the thread now names it). Nothing changes when
 * the lookup is refused or fails.
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

const doneClass =
  'group/tag flex max-w-full items-center rounded-full px-1.5 py-0.5 text-[length:var(--text-meta)] text-muted'

/**
 * One ask, marked with the other bot's tag: its face and its name in its
 * colour. While it runs the two bots' faces are turned toward each other with
 * "Research is asking Writer", and nothing more. Done, the row settles to one
 * quiet line: "Writer helped" once a reply came back, "Messaged Writer" when
 * none was waited for. The row opens the private conversation between the two
 * bots, which holds the reply. A call that came without its arguments reads
 * "Research is asking a teammate", with nothing to open.
 */
function AskRow({ ask, sender }: { ask: Ask; sender: null | string }) {
  const target = useBot(ask.target)
  const from = useBot(sender)
  const running = ask.status === 'running'
  const targetName = ask.target ? (target?.display_name ?? ask.target) : null
  const senderName = sender ? (from?.display_name ?? sender) : null
  const label = askLabel(ask, targetName, senderName)
  const { after, before } = askWords(ask, senderName)
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

  // The line's words around the other bot: its tag, or plain words for one the roster lacks.
  const line = (face: boolean) => (
    <span className="truncate">
      {before ? `${before} ` : null}
      {target ? (
        <BotName bot={target} face={face} />
      ) : (
        (targetName ?? (before ? 'a teammate' : 'A teammate'))
      )}
      {after ? ` ${after}` : null}
    </span>
  )

  if (running) {
    const body = (
      <>
        <span className="flex shrink-0 items-center">
          <Avatar
            {...botFace(from)}
            look="right"
            mood="listening"
            name={senderName ?? 'Bot'}
            size="md"
          />
          <Avatar
            {...botFace(target)}
            look="left"
            mood={reply ? (liveMood(reply) ?? 'thinking') : 'listening'}
            name={targetName ?? 'Teammate'}
            size="md"
            {...(ask.target ? {} : { style: TEAMMATE_FACE })}
          />
        </span>
        <span className="ml-1 flex min-w-0 text-[length:var(--text-secondary)] text-muted">
          {line(false)}
        </span>
      </>
    )

    return (
      <li
        aria-label={label}
        aria-live="polite"
        className="hex-rise max-w-full py-1"
        data-status="running"
        data-testid="asking-row"
        role="status"
      >
        {canOpen ? (
          <button
            aria-label={openLabel}
            className="group/tag flex max-w-full items-center gap-2 rounded-full pr-2 transition-colors outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-foreground/40"
            onClick={open}
            type="button"
          >
            {body}
            <ChevronRight
              className="shrink-0 text-muted opacity-0 transition-opacity group-hover/tag:opacity-100 group-focus-visible/tag:opacity-100"
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
      <li
        aria-label={label}
        className={cn(doneClass, 'hex-fade')}
        data-status="done"
        data-testid="asking-row"
      >
        {line(true)}
      </li>
    )
  }

  return (
    <li className="hex-fade max-w-full" data-status="done" data-testid="asking-row">
      <button
        aria-label={openLabel}
        className={cn(
          doneClass,
          'transition-colors outline-none hover:bg-surface-2 hover:text-foreground focus-visible:ring-2 focus-visible:ring-foreground/40'
        )}
        onClick={open}
        title={label}
        type="button"
      >
        {line(true)}
        <ChevronRight
          className="ml-1 shrink-0 opacity-0 transition-opacity group-hover/tag:opacity-100 group-focus-visible/tag:opacity-100"
          size={12}
        />
      </button>
    </li>
  )
}

/**
 * Under a bot's message: one row per bot it asked for help this turn,
 * visible from the first moment and kept once done. The rows sit in the
 * middle of the column, like the time between messages: they mark what
 * happened, and neither side said them. `sender` is the bot
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
    <ul className="flex flex-col items-center pt-1.5" data-testid="asking-rows">
      {list.map(ask => (
        <AskRow ask={ask} key={ask.target ?? 'teammate'} sender={sender} />
      ))}
    </ul>
  )
}
