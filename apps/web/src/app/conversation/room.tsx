import { useNavigate, useParams } from '@tanstack/react-router'
import { Info } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { Avatar } from '../../components/ui/avatar'
import { RoomCluster } from '../../components/ui/room-cluster'
import { SkeletonLines } from '../../components/ui/skeleton'
import { StatusDot } from '../../components/ui/status-dot'
import { Thinking } from '../../components/ui/thinking'
import { roomsSend, roomsStop } from '../../lib/api'
import { avatarSrc } from '../../lib/avatar-builder'
import { cn } from '../../lib/cn'
import { toMillis } from '../../lib/time'
import type { Bot, RoomEvent, RoomMember, RoomTurn } from '../../lib/types'
import { useBots } from '../../stores/bots'
import { roomFailure, roomStatus, useRooms } from '../../stores/rooms'
import { useTranscripts } from '../../stores/transcripts'

import { composerFieldClass, ComposerShell } from './composer'
import { MemoryMarks } from './memory-marks'
import { WaitingBanner } from './waiting-banner'
import { WorkStatus } from './work-status'

import { bubbleClass, DaySeparator, Markdown, transcriptClass, userBubbleClass } from './index'

// Stable empty values: a fresh [] or {} per render re-renders forever.
const NO_EVENTS: RoomEvent[] = []
const NO_TURNS: Record<string, RoomTurn> = {}

const avatarData = (bot?: Bot) => avatarSrc(bot?.avatar)

export function RoomEventRow({ event }: { event: RoomEvent }) {
  const bot = useBots(state => (event.actor_id ? state.byName[event.actor_id] : undefined))
  const text = typeof event.payload.text === 'string' ? event.payload.text : ''
  const memberId = typeof event.payload.bot === 'string' ? event.payload.bot : event.actor_id

  const member =
    useBots(state => (memberId ? state.byName[memberId]?.display_name : undefined)) ?? memberId

  const system = ['member.added', 'member.left', 'note'].includes(event.kind)

  if (event.kind === 'turn.started') {
    return null
  }

  if (event.kind === 'turn.failed') {
    const error = typeof event.payload.error === 'string' ? event.payload.error : ''

    return (
      <div
        className="hex-bubble my-3 flex items-center gap-2 rounded-bubble bg-danger/12 px-4 py-2.5 text-[length:var(--text-secondary)] text-danger"
        data-testid="room-event"
        role="alert"
      >
        <span aria-hidden className="size-2 shrink-0 rounded-full bg-danger" />
        <span className="min-w-0 flex-1 truncate">
          <span className="font-semibold">{member} stopped</span>
          {error ? ` · ${error}` : ''}
        </span>
      </div>
    )
  }

  if (system) {
    const copy =
      event.kind === 'member.added'
        ? `${member} joined the room`
        : event.kind === 'member.left'
          ? `${member} left the room`
          : text

    return (
      <div
        className="py-2 text-center text-[length:var(--text-secondary)] text-muted"
        data-testid="room-event"
      >
        {copy}
      </div>
    )
  }

  // Waiting on a human is the banner under the header, not a transcript line.
  if (event.kind === 'waiting.human') {
    return null
  }

  if (event.kind === 'limit.tripped') {
    return (
      <div
        className="hex-bubble my-3 rounded-bubble bg-warning/12 px-4 py-2.5 text-[length:var(--text-secondary)] text-warning"
        data-testid="room-event"
      >
        {text || 'A room limit was reached.'}
      </div>
    )
  }

  const human = event.kind === 'message.user'

  return (
    <article
      className={`flex gap-2 py-1 ${human ? 'flex-row-reverse' : ''}`}
      data-testid="room-event"
    >
      {human ? null : (
        <Avatar
          className="mt-1"
          image={avatarData(bot)}
          name={bot?.display_name ?? event.actor_id ?? 'Bot'}
          size="sm"
        />
      )}
      <div className={cn(human ? userBubbleClass : bubbleClass, 'max-w-[80%]')}>
        {!human ? (
          <div className="mb-0.5 text-[length:var(--text-meta)] font-semibold text-muted">
            {bot?.display_name ?? event.actor_id}
          </div>
        ) : null}
        <div className="hex-prose">
          <Markdown text={text} />
        </div>
      </div>
    </article>
  )
}

/** The bot behind the latest "waiting on a human" event, for the banner. */
function waitingBot(events: RoomEvent[], bots: Record<string, Bot>): string | undefined {
  const actor = events.findLast(event => event.kind === 'waiting.human')?.actor_id

  return actor ? bots[actor]?.display_name : undefined
}

export function RoomMentionPopover({
  bots,
  members,
  onSelect,
  query
}: {
  bots: Record<string, Bot>
  members: RoomMember[]
  onSelect: (name: string) => void
  query: string
}) {
  const suggestions = members.filter(member =>
    member.member_id.toLowerCase().includes(query.toLowerCase())
  )

  if (!suggestions.length) {
    return null
  }

  return (
    <div
      className="hex-bubble absolute bottom-full left-14 mb-1 min-w-52 rounded-panel border border-border bg-surface p-1 shadow-popup"
      role="listbox"
    >
      {suggestions.map(member => (
        <button
          className="block w-full rounded-control px-3 py-2 text-left text-[length:var(--text-secondary)] hover:bg-surface-2"
          key={member.member_id}
          onClick={() => onSelect(member.member_id)}
          type="button"
        >
          @{member.member_id}{' '}
          <span className="text-muted">{bots[member.member_id]?.display_name}</span>
        </button>
      ))}
    </div>
  )
}

export function RoomConversation() {
  const { room: roomId } = useParams({ strict: false }) as { room: string }
  const navigate = useNavigate()
  const room = useRooms(state => state.byId[roomId])
  const events = useRooms(state => state.eventsByRoom[roomId] ?? NO_EVENTS)
  const turns = useRooms(state => state.liveTurnsByRoom[roomId] ?? NO_TURNS)
  const transcripts = useTranscripts(state => state.bySession)
  const bots = useBots(state => state.byName)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const bottom = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void useRooms.getState().open(roomId)
  }, [roomId])
  useEffect(() => {
    const seq = events.at(-1)?.seq

    if (seq) {
      void useRooms.getState().markRead(roomId, seq)
    }
  }, [events, roomId])
  useEffect(() => {
    void bottom.current?.scrollIntoView({ block: 'end' })
  }, [events, transcripts])

  const members = useMemo(
    () => room?.members.filter(member => member.member_kind === 'bot' && !member.left_at) ?? [],
    [room?.members]
  )

  const mention = /(?:^|\s)@([\w-]*)$/.exec(text)?.[1]
  const streaming = Object.keys(turns).length > 0
  const status = roomStatus(events, turns)
  const failure = roomFailure(events)

  const send = async () => {
    if (!text.trim()) {
      return
    }

    setSending(true)

    try {
      await roomsSend(roomId, text.trim())
      setText('')
    } finally {
      setSending(false)
    }
  }

  if (!room) {
    return (
      <div className="grid h-screen place-content-center">
        <SkeletonLines className="w-64" label="Loading room" />
      </div>
    )
  }

  return (
    <div className="flex h-screen min-h-0 flex-col bg-background">
      <header className="hex-drag flex h-11 shrink-0 items-center gap-2 px-4 max-[700px]:pl-12">
        <RoomCluster bots={bots} room={room} size="sm" status={status} />
        <div className="hex-no-drag flex min-w-0 flex-1 items-baseline gap-2">
          <h2 className="truncate text-[length:var(--text-secondary)] font-semibold">
            {room.name}
          </h2>
          <span className="shrink-0 text-[length:var(--text-meta)] text-muted">
            {members.length} bot{members.length === 1 ? '' : 's'}
          </span>
        </div>
        <button
          aria-label="Room settings"
          className="hex-no-drag grid size-7 place-items-center rounded-full text-muted transition-colors hover:bg-surface-2 hover:text-foreground"
          onClick={() => void navigate({ params: { room: roomId }, to: '/r/$room/settings' })}
          type="button"
        >
          <Info size={16} />
        </button>
      </header>
      {status === 'needs_you' ? <WaitingBanner name={waitingBot(events, bots)} /> : null}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className={transcriptClass}>
          {events.map((event, index) => {
            const previous = events[index - 1]

            const separator =
              !previous || toMillis(event.created_at) - toMillis(previous.created_at) > 20 * 60_000

            return (
              <div key={event.seq}>
                {separator ? <DaySeparator time={event.created_at} /> : null}
                <RoomEventRow event={event} />
              </div>
            )
          })}
          {Object.values(turns).map(turn => {
            const transcript = turn.live_session_id ? transcripts[turn.live_session_id] : undefined
            const message = transcript?.messages.at(-1)
            const bot = bots[turn.bot]
            const name = bot?.display_name ?? turn.bot

            return (
              <article className="flex gap-2 py-1" data-testid="room-event" key={turn.bot}>
                <span className="relative mt-1 shrink-0">
                  <Avatar
                    className="hex-think"
                    image={avatarData(bot)}
                    mood="working"
                    name={name}
                    size="sm"
                  />
                  <StatusDot size="sm" status="working" />
                </span>
                <div className="flex min-w-0 max-w-[80%] flex-col">
                  {message ? <WorkStatus message={message} name={name} /> : <Thinking name={name} />}
                  {message?.text ? (
                    <div className={bubbleClass}>
                      <div className="mb-0.5 text-[length:var(--text-meta)] font-semibold text-muted">
                        {name}
                      </div>
                      <p className="whitespace-pre-wrap">{message.text}</p>
                    </div>
                  ) : null}
                  {message ? <MemoryMarks message={message} /> : null}
                </div>
              </article>
            )
          })}
          <div ref={bottom} />
        </div>
      </div>
      <div data-testid="room-composer">
        <ComposerShell
          above={
            mention === undefined ? null : (
              <RoomMentionPopover
                bots={bots}
                members={members}
                onSelect={name => setText(value => value.replace(/@([\w-]*)$/, `@${name} `))}
                query={mention}
              />
            )
          }
          canSend={Boolean(text.trim())}
          notice={status === 'stopped' ? failure : null}
          onSend={() => void send()}
          onStop={() => void roomsStop(roomId)}
          sending={sending}
          status={status}
          streaming={streaming}
        >
          <textarea
            aria-label="Message room"
            className={composerFieldClass}
            onChange={event => setText(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void send()
              }
            }}
            placeholder={`Message ${room.name}`}
            rows={1}
            value={text}
          />
        </ComposerShell>
      </div>
    </div>
  )
}
