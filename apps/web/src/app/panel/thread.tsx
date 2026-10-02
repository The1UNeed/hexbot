import { ChevronsRight } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { Avatar } from '../../components/ui/avatar'
import { SkeletonLines } from '../../components/ui/skeleton'
import { sectionsThread } from '../../lib/api'
import { avatarSrc } from '../../lib/avatar-builder'
import { cn } from '../../lib/cn'
import type { Bot, Message } from '../../lib/types'
import { useBot } from '../../stores/bots'
import { useConnection } from '../../stores/connection'
import { sectionsActions, useLiveSessionId } from '../../stores/sections'
import { useTranscript, useTranscripts } from '../../stores/transcripts'
import { type ThreadRef, useUi } from '../../stores/ui'
import { ApprovalCard, bubbleClass, CardRow, Markdown } from '../conversation'
import { AskingRow } from '../conversation/asking-row'
import { ClarifyCard } from '../conversation/clarify-card'
import { MemoryMarks } from '../conversation/memory-marks'
import { WorkStatus } from '../conversation/work-status'

type Loaded =
  | { kind: 'empty' }
  | { kind: 'error'; text: string }
  | { kind: 'loading' }
  | { kind: 'ready'; messages: Message[]; sectionId: string }

/** What to tell the user when the daemon refused or lost the thread. */
export function threadErrorText(error: unknown): string {
  const code = (error as { code?: number } | null)?.code
  const message = error instanceof Error ? error.message : String(error)

  if (code === 4302 || /owner/i.test(message)) {
    return 'Only the room owner can open this conversation.'
  }

  if (code === 4204 || code === 4205 || /not found/i.test(message)) {
    return 'This conversation is no longer available.'
  }

  return message || 'The conversation could not be opened.'
}

/** One bubble: the face and name of whichever bot spoke, its work, then its words. */
function ThreadMessage({ bot, message, name }: { bot?: Bot; message: Message; name: string }) {
  if (message.role === 'system' || message.role === 'tool') {
    return message.error ? (
      <p className="py-1 text-[length:var(--text-secondary)] text-danger" role="alert">
        {message.error}
      </p>
    ) : null
  }

  const reply = message.role === 'assistant'

  return (
    <article className="flex gap-2 py-1" data-testid={reply ? 'thread-reply' : 'thread-question'}>
      <Avatar
        className={cn('mt-1', message.streaming && 'hex-think')}
        image={avatarSrc(bot?.avatar)}
        mood={message.streaming ? 'working' : undefined}
        name={name}
        size="sm"
      />
      <div className="flex min-w-0 flex-1 flex-col items-start">
        <span className="px-1 text-[length:var(--text-meta)] font-semibold text-muted">{name}</span>
        {/* The name above already marks who is working; show work only once there is some. */}
        {reply && (message.toolCalls.length || !message.streaming) ? (
          <WorkStatus message={message} name={name} />
        ) : null}
        {/* The asked bot may ask a third; its row opens that conversation in turn. */}
        {reply ? <AskingRow message={message} sender={bot?.name ?? null} /> : null}
        {message.text ? (
          <div className={cn(bubbleClass, 'text-[length:var(--text-secondary)]')}>
            <div className="hex-prose">
              <Markdown text={message.text} />
            </div>
          </div>
        ) : null}
        {reply ? <MemoryMarks message={message} /> : null}
      </div>
    </article>
  )
}

/**
 * The right panel while a thread is open: the private conversation in which
 * `peer` asks `bot` for help, read-only. History comes from the thread
 * section; the reply in progress streams in from its live session, and the
 * history is read again once that reply completes so the next question shows.
 */
export function ThreadPanel({ thread }: { thread: ThreadRef }): React.JSX.Element {
  const close = useUi(state => state.closeThread)
  const receiver = useBot(thread.bot)
  const sender = useBot(thread.peer)
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' })
  // Live messages kept on screen after they finish, until the next history read has them.
  const [tail, setTail] = useState<string[]>([])
  const bottom = useRef<HTMLDivElement>(null)
  const sectionId = loaded.kind === 'ready' ? loaded.sectionId : (thread.sectionId ?? null)
  const liveId = useLiveSessionId(sectionId)
  const transcript = useTranscript(liveId)
  const streamingId = transcript?.streamingMessageId ?? null
  // Counts finished replies: each one is a reason to read the history again.
  const [completed, setCompleted] = useState(0)
  const wasStreaming = useRef(false)
  // A daemon restart drops live sessions; read the thread again to pick up its new one.
  const epoch = useConnection(state => state.epoch)
  const changed = useUi(state => state.threadChanged)
  const receiverName = receiver?.display_name ?? thread.bot
  const senderName = sender?.display_name ?? thread.peer

  useEffect(() => {
    let stale = false

    const load = async () => {
      try {
        const id =
          thread.sectionId ?? (await sectionsThread(thread.bot, thread.peer)).section?.id ?? null

        if (!id) {
          if (!stale) {
            setLoaded({ kind: 'empty' })
          }

          return
        }

        const opened = await sectionsActions().openThread(id, thread.peer)

        // A reply still streaming lives in the live transcript, earlier parts included; showing
        // its stored parts as well would repeat them until it completes.
        const streaming = opened.liveSessionId
          ? useTranscripts.getState().bySession[opened.liveSessionId]?.streamingMessageId
          : null

        const lastQuestion = opened.messages.findLastIndex(message => message.role === 'user')

        const messages =
          streaming && lastQuestion >= 0
            ? opened.messages.slice(0, lastQuestion + 1)
            : opened.messages

        if (!stale) {
          setLoaded({ kind: 'ready', messages, sectionId: id })
          setTail([])
        }
      } catch (error) {
        if (!stale) {
          setLoaded({ kind: 'error', text: threadErrorText(error) })
        }
      }
    }

    void load()

    return () => {
      stale = true
    }
  }, [changed, completed, epoch, thread.bot, thread.peer, thread.sectionId])

  // A reply in progress stays on screen once done, until the history read after it lands.
  useEffect(() => {
    if (streamingId) {
      wasStreaming.current = true
      setTail(ids => (ids.includes(streamingId) ? ids : [...ids, streamingId]))
    } else if (wasStreaming.current) {
      wasStreaming.current = false
      setCompleted(count => count + 1)
    }
  }, [streamingId])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        close()
      }
    }

    window.addEventListener('keydown', onKey)

    return () => window.removeEventListener('keydown', onKey)
  }, [close])

  const live = transcript?.messages.filter(item => item.streaming || tail.includes(item.id)) ?? []
  const liveText = live.at(-1)?.text

  useEffect(() => {
    bottom.current?.scrollIntoView?.({ block: 'end' })
  }, [loaded, liveText])

  const row = (message: Message) => (
    <ThreadMessage
      bot={message.role === 'assistant' ? receiver : sender}
      key={message.id}
      message={message}
      name={message.role === 'assistant' ? receiverName : senderName}
    />
  )

  return (
    <div className="flex h-screen min-h-0 flex-col" data-testid="thread-panel">
      <header className="hex-drag flex h-11 shrink-0 items-center gap-2 px-3">
        <span className="flex shrink-0 items-center gap-1">
          <Avatar image={avatarSrc(sender?.avatar)} name={senderName} size="sm" />
          <Avatar image={avatarSrc(receiver?.avatar)} name={receiverName} size="sm" />
        </span>
        <h2 className="hex-no-drag min-w-0 flex-1 truncate text-[length:var(--text-secondary)] font-semibold">
          {senderName} and {receiverName}
        </h2>
        <button
          aria-label="Close the conversation"
          className="hex-no-drag grid size-7 place-items-center rounded-full text-muted transition-colors hover:bg-surface-2 hover:text-foreground"
          onClick={close}
          type="button"
        >
          <ChevronsRight size={16} />
        </button>
      </header>
      <p className="shrink-0 px-4 pb-2 text-[length:var(--text-meta)] text-muted">
        Private to {senderName} and {receiverName}.
      </p>
      <div className="hex-fade min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        {loaded.kind === 'loading' ? (
          <SkeletonLines className="pt-2" label="Loading conversation" />
        ) : loaded.kind === 'error' ? (
          <p className="pt-2 text-[length:var(--text-secondary)] text-muted" role="alert">
            {loaded.text}
          </p>
        ) : loaded.kind === 'empty' && !live.length ? (
          <p className="pt-2 text-[length:var(--text-secondary)] text-muted">
            {senderName} has not asked {receiverName} anything yet.
          </p>
        ) : (
          <>
            {loaded.kind === 'ready' ? loaded.messages.map(row) : null}
            {live.map(row)}
            {/* The owner answers the receiving bot here: threads have no other view. */}
            {transcript?.clarifies.map(clarify => (
              <CardRow bot={receiver} key={clarify.requestId}>
                <ClarifyCard clarify={clarify} />
              </CardRow>
            ))}
            {transcript?.approvals.map(approval => (
              <CardRow bot={receiver} key={approval.requestId}>
                <ApprovalCard approval={approval} />
              </CardRow>
            ))}
            <div ref={bottom} />
          </>
        )}
      </div>
    </div>
  )
}
