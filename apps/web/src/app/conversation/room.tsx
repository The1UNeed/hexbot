import { useNavigate, useParams } from '@tanstack/react-router'
import { Info, Search } from 'lucide-react'
import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { Avatar, useFaceColor } from '../../components/ui/avatar'
import { RoomCluster } from '../../components/ui/room-cluster'
import { ScrollArea } from '../../components/ui/scroll-area'
import { SkeletonLines } from '../../components/ui/skeleton'
import { StatusDot } from '../../components/ui/status-dot'
import { Thinking } from '../../components/ui/thinking'
import { roomsSend, roomsStop } from '../../lib/api'
import { botFace } from '../../lib/avatar-builder'
import { cn } from '../../lib/cn'
import { plainError } from '../../lib/plain-error'
import { useRoomOrLeave } from '../../lib/room-or-leave'
import { useTurnCues } from '../../lib/sounds'
import { toMillis } from '../../lib/time'
import type { Bot, RoomEvent, RoomMember, RoomTurn } from '../../lib/types'
import { useHeight } from '../../lib/use-height'
import { useBots } from '../../stores/bots'
import { connectorsActions } from '../../stores/connectors'
import { useEmotion, useEmotions, useRoomFeelings } from '../../stores/emotions'
import { useMe } from '../../stores/me'
import { roomFailure, roomStatus, useRooms } from '../../stores/rooms'
import { useSearch } from '../../stores/search'
import { useTranscripts } from '../../stores/transcripts'
import { useUi } from '../../stores/ui'

import { AskingRow, AskRows } from './asking-row'
import { ClarifyCard } from './clarify-card'
import { composerFieldClass, ComposerShell } from './composer'
import { useSearchJump } from './search-jump'
import { type Ask, liveMood } from './steps'
import { DeliveryMark, NotSent, SEND_TIMEOUT_MS } from './unsent'
import { WaitingBanner } from './waiting-banner'
import { WorkStatus } from './work-status'

import {
  ApprovalCard,
  botBubbleStyle,
  bubbleClass,
  CardRow,
  ConnectedToolsNotice,
  DaySeparator,
  LoadEarlierMessages,
  Markdown,
  separates,
  transcriptClass,
  userBubbleClass
} from './index'

/** Your room message before the daemon stores it; it becomes a room event once it does. */
interface Unsent {
  /** The room's newest event when it was sent: its copy comes after. */
  after: number
  delivery: 'failed' | 'sending'
  id: string
  reason?: string
  roomId: string
  /** When it was first sent: a matching message of yours from then on is this one. */
  sentAt: number
  text: string
}

// Stable empty values: a fresh [] or {} per render re-renders forever.
const NO_EVENTS: RoomEvent[] = []
const NO_TURNS: Record<string, RoomTurn> = {}

export const RoomEventRow = memo(function RoomEventRow({
  event,
  fresh = false,
  latest = false
}: {
  event: RoomEvent
  fresh?: boolean
  /** The bot's latest message in the room: its face shows what the bot feels. */
  latest?: boolean
}) {
  const bot = useBots(state => (event.actor_id ? state.byName[event.actor_id] : undefined))
  const emotion = useEmotion(latest ? event.actor_id : undefined)
  const text = typeof event.payload.text === 'string' ? event.payload.text : ''

  // Member events name the bot or person who came or went; other events their actor.
  const memberId = [event.payload.bot, event.payload.user, event.actor_id].find(
    (id): id is string => typeof id === 'string'
  )

  const memberKind = event.payload.bot ? 'bot' : event.payload.user ? 'human' : event.actor_kind
  const me = useMe(state => state.me)

  // The room's member rows keep names of bots and people who have since left.
  const memberName = useRooms(state =>
    memberId
      ? state.byId[event.room_id]?.members.find(
          item => item.member_kind === memberKind && item.member_id === memberId
        )?.display_name
      : undefined
  )

  const botName = useBots(state => (memberId ? state.byName[memberId]?.display_name : undefined))

  const member =
    (me && memberKind === 'human' && memberId === me.id ? me.display_name : undefined) ??
    (memberKind === 'bot' ? botName : undefined) ??
    memberName ??
    memberId

  const system = ['member.added', 'member.left', 'note'].includes(event.kind)

  const said = event.kind === 'message.bot'
  const color = useFaceColor(said ? bot : undefined, said ? (member ?? 'Bot') : null)

  if (event.kind === 'turn.started') {
    return null
  }

  if (event.kind === 'turn.failed') {
    const error = typeof event.payload.error === 'string' ? plainError(event.payload.error) : ''

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

  // Your messages are the right-hand bubble; other people speak like the bots.
  // Without user accounts (or before you are known) every message is yours.
  const mine = event.kind === 'message.user' && (!me || event.actor_id === me.id)
  const name = member
  // The teammates this bot asked during its turn, kept with its reply.
  const asked = event.kind === 'message.bot' ? storedAsks(event.payload.asks) : []

  return (
    <>
      <article
        className={`flex gap-2 py-1 ${mine ? 'flex-row-reverse' : ''}`}
        data-testid="room-event"
      >
        {mine ? null : (
          <Avatar
            className="mt-1"
            {...botFace(bot)}
            mood={emotion}
            name={name ?? 'Bot'}
            size="sm"
          />
        )}
        <div className="flex min-w-0 max-w-[80%] flex-col items-start">
          <div
            className={cn(
              mine ? userBubbleClass : bubbleClass,
              'max-w-full',
              fresh && 'hex-message',
              fresh && mine && 'hex-message-mine'
            )}
            style={mine ? undefined : botBubbleStyle(color)}
          >
            {!mine ? (
              <div className="mb-0.5 text-[length:var(--text-meta)] font-semibold text-muted">
                {name}
              </div>
            ) : null}
            <div className="hex-prose">
              <Markdown text={text} />
            </div>
          </div>
        </div>
      </article>
      {asked.length ? <AskRows asks={asked} sender={event.actor_id ?? null} /> : null}
    </>
  )
})

/** A finished turn's asks from its `message.bot` payload: `[{to, section_id}]`. */
function storedAsks(value: unknown): Ask[] {
  return Array.isArray(value)
    ? value.flatMap(item =>
        item && typeof item.to === 'string'
          ? [
              {
                sectionId: typeof item.section_id === 'string' ? item.section_id : null,
                sent: false,
                status: 'ok' as const,
                target: item.to
              }
            ]
          : []
      )
    : []
}

/** The bot behind the latest "waiting on a human" event, for the banner. */
function waitingBot(
  events: RoomEvent[],
  bots: Record<string, Bot>,
  members: RoomMember[]
): string | undefined {
  const actor = events.findLast(event => event.kind === 'waiting.human')?.actor_id

  return actor
    ? (bots[actor]?.display_name ??
        members.find(member => member.member_kind === 'bot' && member.member_id === actor)
          ?.display_name ??
        actor)
    : undefined
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
      className="hex-glass-strong hex-menu-in absolute bottom-full left-14 mb-1 min-w-52 rounded-[14px] p-1"
      role="listbox"
    >
      {suggestions.map(member => (
        <button
          className="block w-full rounded-[10px] px-3 py-2 text-left text-[length:var(--text-secondary)] hover:bg-foreground/[0.06]"
          key={member.member_id}
          onClick={() => onSelect(member.member_id)}
          type="button"
        >
          @{member.member_id}{' '}
          <span className="text-muted">
            {bots[member.member_id]?.display_name ?? member.display_name}
          </span>
        </button>
      ))}
    </div>
  )
}

export function RoomConversation() {
  const { room: roomId } = useParams({ strict: false }) as { room: string }
  const navigate = useNavigate()
  const searching = useSearch(state => state.open)
  const setSearching = useSearch(state => state.setOpen)
  const room = useRoomOrLeave(roomId, 'open')
  const events = useRooms(state => state.eventsByRoom[roomId] ?? NO_EVENTS)
  const loaded = useRooms(state => roomId in state.eventsByRoom)
  const turns = useRooms(state => state.liveTurnsByRoom[roomId] ?? NO_TURNS)
  const transcripts = useTranscripts(state => state.bySession)
  const bots = useBots(state => state.byName)
  const [text, setText] = useState('')
  const [unsent, setUnsent] = useState<Unsent[]>([])
  const attempts = useRef(new Map<string, number>())
  // Each send's request still out, answering whether it posted.
  const inflight = useRef(new Map<string, Promise<boolean>>())
  // Room events a send's reply named, by room and seq: they belong to that
  // send, never another.
  const answered = useRef(new Set<string>())
  const me = useMe(state => state.me)
  const bottom = useRef<HTMLDivElement>(null)
  const viewport = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)
  const [composerBox, composerHeight] = useHeight<HTMLDivElement>()
  const earlierAnchor = useRef<{ height: number; top: number } | null>(null)
  // Keep the first shown event while live events append, so reading older messages stays put.
  const [historyWindow, setWindow] = useState({ room: roomId, first: events.at(-60)?.seq })
  const first = historyWindow.room === roomId ? historyWindow.first : events.at(-60)?.seq

  // A live event can arrive before hydration prepends the history. Always
  // include at least the recent suffix once that earlier history arrives.
  const start =
    first === undefined
      ? 0
      : Math.min(
          Math.max(
            0,
            events.findIndex(event => event.seq >= first)
          ),
          Math.max(0, events.length - 60)
        )

  if (historyWindow.room !== roomId || (first === undefined && events.length)) {
    setWindow({ room: roomId, first: events.at(-60)?.seq ?? events[0]?.seq })
  } else if (first !== undefined && events[start] && events[start].seq !== first) {
    // Keep the window where hydration widened it, or the next event slides it.
    setWindow({ room: roomId, first: events[start].seq })
  }

  // A search result older than the shown part widens the window to reach it.
  const jump = useSearch(state => state.jump)
  const jumpSeq = jump ? Number(jump.id) : NaN

  if (jumpSeq < (events[start]?.seq ?? 0) && events.some(event => event.seq === jumpSeq)) {
    setWindow({ room: roomId, first: jumpSeq })
  }

  const shown = events.slice(start)
  useSearchJump(viewport, start)

  const loadEarlier = () => {
    const node = viewport.current

    if (node) {
      earlierAnchor.current = { height: node.scrollHeight, top: node.scrollTop }
    }

    setWindow({ room: roomId, first: events[Math.max(0, start - 60)]?.seq })
  }

  useLayoutEffect(() => {
    const node = viewport.current
    const anchor = earlierAnchor.current

    if (node && anchor) {
      node.scrollTop = anchor.top + node.scrollHeight - anchor.height
    }

    earlierAnchor.current = null
  }, [first, roomId])
  useLayoutEffect(() => {
    atBottom.current = true
    earlierAnchor.current = null
  }, [roomId])
  // Messages that arrive after the room opened spring in; history is drawn still.
  const opened = useRef({ at: Date.now(), id: roomId })

  if (opened.current.id !== roomId) {
    opened.current = { at: Date.now(), id: roomId }
  }

  const openedAt = opened.current.at

  // Presence, not the room object: every read mark stores a fresh room.
  const present = Boolean(room)
  // Hidden behind a clicked bot's loading face, the room is not being read.
  const hidden = useUi(state => state.openingBot !== null)
  useEffect(() => {
    const seq = events.at(-1)?.seq

    if (seq && present && !hidden) {
      void useRooms.getState().markRead(roomId, seq)
    }
  }, [events, hidden, present, roomId])
  useEffect(() => {
    if (atBottom.current) {
      void bottom.current?.scrollIntoView({ block: 'end' })
    }
  }, [composerHeight, events, transcripts, unsent])

  const members = useMemo(
    () => room?.members.filter(member => member.member_kind === 'bot' && !member.left_at) ?? [],
    [room?.members]
  )

  // Connector tools are named from each bot's catalog ("Connecting to Project tools").
  useEffect(() => {
    for (const member of members) {
      void connectorsActions().load(member.member_id)
    }
  }, [members])

  const mention = /(?:^|\s)@([\w-]*)$/.exec(text)?.[1]
  const streaming = Object.keys(turns).length > 0
  const status = roomStatus(events, turns)
  const failure = roomFailure(events)

  const waiting = Object.values(turns).reduce((count, turn) => {
    const transcript = turn.live_session_id ? transcripts[turn.live_session_id] : undefined

    return (
      count +
      (transcript?.approvals.filter(card => !card.decision).length ?? 0) +
      (transcript?.clarifies.filter(
        card => !card.expired && Object.keys(card.answers).length < card.questions.length
      ).length ?? 0)
    )
  }, 0)

  const ended = useRooms(state => state.endedByRoom[roomId])
  useTurnCues(roomId, { failed: Boolean(failure) || ended === 'failed', streaming, waiting })
  useRoomFeelings(roomId, events, turns, transcripts, loaded)
  const feelings = useEmotions(state => state.feelings)

  // Each bot's latest message, whose face shows what it feels.
  const latestByBot = useMemo(() => {
    const latest: Record<string, number> = {}

    for (const event of events) {
      if (event.kind === 'message.bot' && event.actor_id) {
        latest[event.actor_id] = event.seq
      }
    }

    return latest
  }, [events])

  // A room message carries no key the daemon could refuse twice. One of yours
  // with the same text since it was sent is this one, each claimed once, oldest
  // send first.
  const landedIn = (list: RoomEvent[], items: Unsent[]) => {
    const claimed = new Set(answered.current)

    return new Set(
      items.flatMap(item => {
        const event = list.find(
          event =>
            !claimed.has(`${item.roomId}:${event.seq}`) &&
            event.kind === 'message.user' &&
            (!me || event.actor_id === me.id) &&
            event.payload.text === item.text &&
            event.seq > item.after &&
            toMillis(event.created_at) >= item.sentAt - 1000
        )

        return event ? (claimed.add(`${item.roomId}:${event.seq}`), [item.id]) : []
      })
    )
  }

  // The room's copy can land before the send's reply: the bubble goes then.
  const landedHere = landedIn(
    events,
    unsent.filter(item => item.roomId === roomId)
  )

  const unsentHere = unsent.filter(item => item.roomId === roomId && !landedHere.has(item.id))

  const patch = (id: string, next: null | Partial<Unsent>) =>
    setUnsent(list =>
      next
        ? list.map(item => (item.id === id ? { ...item, ...next } : item))
        : list.filter(item => item.id !== id)
    )

  const deliver = async (item: Unsent) => {
    const attempt = (attempts.current.get(item.id) ?? 0) + 1
    const current = () => attempts.current.get(item.id) === attempt
    attempts.current.set(item.id, attempt)

    // A retry while an earlier try is still out waits for its answer: a
    // second request could post the message twice.
    const earlier = inflight.current.get(item.id)

    if (earlier) {
      patch(item.id, { delivery: 'sending', reason: undefined })

      if ((await earlier) || !current()) {
        return
      }
    }

    // A retry first looks for the first try in the room, as the list does.
    const landed = landedIn(
      useRooms.getState().eventsByRoom[item.roomId] ?? [],
      unsent.filter(other => other.roomId === item.roomId)
    ).has(item.id)

    if (attempt > 1 && landed) {
      attempts.current.delete(item.id)
      patch(item.id, null)

      return
    }

    patch(item.id, { delivery: 'sending', reason: undefined })

    const timer = setTimeout(() => {
      if (current()) {
        patch(item.id, { delivery: 'failed', reason: 'The daemon has not answered yet.' })
      }
    }, SEND_TIMEOUT_MS)

    const request = roomsSend(item.roomId, item.text).then(
      ({ event }) => {
        answered.current.add(`${item.roomId}:${event.seq}`)
        // Lands the event now, so the bubble never blinks out before the broadcast.
        useRooms.getState().handleEvent(item.roomId, event)
        attempts.current.delete(item.id)
        patch(item.id, null)

        return true
      },
      (error: unknown) => {
        if (current()) {
          patch(item.id, {
            delivery: 'failed',
            reason: plainError(error instanceof Error ? error.message : String(error))
          })
        }

        return false
      }
    )

    inflight.current.set(item.id, request)
    await request
    clearTimeout(timer)

    if (inflight.current.get(item.id) === request) {
      inflight.current.delete(item.id)
    }
  }

  // The bubble holds the message now, greyed until the room takes it and with
  // Retry if it does not, so the field clears at once.
  const send = () => {
    if (!text.trim()) {
      return
    }

    const item: Unsent = {
      after: events.reduce((newest, event) => Math.max(newest, event.seq), 0),
      delivery: 'sending',
      id: crypto.randomUUID(),
      roomId,
      sentAt: Date.now(),
      text: text.trim()
    }

    setUnsent(list => [...list, item])
    setText('')
    void deliver(item)
  }

  if (!room) {
    return (
      <div className="grid h-full place-content-center">
        <SkeletonLines className="w-64" label="Loading room" />
      </div>
    )
  }

  return (
    <div className="h-full min-h-0 bg-background">
      {/* The room runs under its floating header and composer, as a bot's chat does. */}
      <ScrollArea
        bottom={
          <div className="mx-auto max-w-[52rem] px-1" data-testid="room-composer" ref={composerBox}>
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
              notice={status === 'stopped' && failure ? plainError(failure) : null}
              onSend={send}
              onStop={() => void roomsStop(roomId)}
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
                    send()
                  }
                }}
                placeholder={`Message ${room.name}`}
                rows={1}
                value={text}
              />
            </ComposerShell>
          </div>
        }
        className="h-full"
        onScroll={event => {
          const node = event.currentTarget
          atBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80
        }}
        top={
          <>
            <header className="flex flex-col items-center gap-2 pt-2.5 pr-[max(6rem,calc(var(--hex-overlay,0px)+1rem))] pl-[max(1rem,calc(6rem-var(--hex-overlay,0px)))] max-[700px]:pl-[max(3.5rem,calc(6rem-var(--hex-overlay,0px)))] transition-[padding] duration-[var(--hex-motion-panel)] ease-[var(--hex-ease-out)]">
              <div className="hex-glass flex h-9 max-w-[min(100%,30rem)] min-w-0 items-center gap-2 rounded-full pr-4 pl-1.5">
                <RoomCluster bots={bots} room={room} size="sm" status={status} />
                <h2 className="truncate text-[length:var(--text-secondary)] font-semibold">
                  {room.name}
                </h2>
                <span className="shrink-0 text-[length:var(--text-secondary)] text-muted">
                  {members.length} bot{members.length === 1 ? '' : 's'}
                </span>
              </div>
              {status === 'needs_you' ? (
                <WaitingBanner name={waitingBot(events, bots, room.members)} />
              ) : null}
              <ConnectedToolsNotice sectionId={`room:${roomId}`} />
            </header>
            <div className="absolute top-2.5 right-3 flex items-center gap-1.5">
              {searching ? null : (
                <button
                  aria-label="Search this room"
                  className="hex-glass hex-glass-press hex-focus hex-fade grid size-9 place-items-center rounded-full text-foreground/70 hover:text-foreground"
                  onClick={() => setSearching(true)}
                  title="Search"
                  type="button"
                >
                  <Search size={16} />
                </button>
              )}
              <button
                aria-label="Room settings"
                className="hex-glass hex-glass-press hex-focus grid size-9 place-items-center rounded-full text-foreground/70 hover:text-foreground"
                onClick={() => void navigate({ params: { room: roomId }, to: '/r/$room/settings' })}
                type="button"
              >
                <Info size={16} />
              </button>
            </div>
          </>
        }
        viewportRef={viewport}
      >
        <div className={transcriptClass}>
          {start > 0 ? <LoadEarlierMessages onClick={loadEarlier} /> : null}
          {shown.map((event, index) => {
            const previous = shown[index - 1]

            const separator = separates(
              previous && toMillis(previous.created_at),
              toMillis(event.created_at)
            )

            return (
              <div key={event.seq}>
                {separator ? <DaySeparator time={event.created_at} /> : null}
                <div data-search-id={event.seq}>
                  <RoomEventRow
                    event={event}
                    fresh={toMillis(event.created_at) > openedAt}
                    latest={event.actor_id ? latestByBot[event.actor_id] === event.seq : false}
                  />
                </div>
              </div>
            )
          })}
          {unsentHere.map(item => (
            <article
              className="flex flex-col items-end gap-1 py-1"
              data-testid="room-unsent"
              key={item.id}
            >
              <div className="flex max-w-[80%] flex-row-reverse gap-1">
                <div
                  className={cn('min-w-0 max-w-full', item.delivery === 'sending' && 'hex-pending')}
                >
                  <div className={cn(userBubbleClass, 'hex-message hex-message-mine')}>
                    <div className="hex-prose">
                      <Markdown text={item.text} />
                    </div>
                  </div>
                </div>
                <DeliveryMark
                  delivery={item.delivery}
                  onRetry={item.delivery === 'failed' ? () => void deliver(item) : undefined}
                />
              </div>
              {item.delivery === 'failed' ? (
                <NotSent label="Not sent" onRetry={() => void deliver(item)} reason={item.reason} />
              ) : null}
            </article>
          ))}
          {Object.values(turns).map(turn => {
            const transcript = turn.live_session_id ? transcripts[turn.live_session_id] : undefined
            const message = transcript?.messages.at(-1)
            const bot = bots[turn.bot]

            const name =
              bot?.display_name ??
              room.members.find(
                member => member.member_kind === 'bot' && member.member_id === turn.bot
              )?.display_name ??
              turn.bot

            // Members see the bot wait while the owner answers an approval or
            // question; the daemon writes the text ("Waiting for Alice").
            const waiting = transcript?.status?.kind === 'waiting' ? transcript.status.text : ''
            // Only the owner receives the cards; answered or expired ones leave.
            const approvals = transcript?.approvals.filter(approval => !approval.decision) ?? []

            const clarifies =
              transcript?.clarifies.filter(
                clarify =>
                  !clarify.expired && Object.keys(clarify.answers).length < clarify.questions.length
              ) ?? []

            return (
              <Fragment key={turn.bot}>
                <article className="flex gap-2 py-1" data-testid="room-event">
                  <span className="relative mt-1 shrink-0">
                    <Avatar
                      {...botFace(bot)}
                      mood={
                        feelings[turn.bot] ??
                        (message ? (liveMood(message) ?? 'working') : 'thinking')
                      }
                      name={name}
                      size="sm"
                    />
                    <StatusDot size="sm" status="working" />
                  </span>
                  <div className="flex min-w-0 max-w-[80%] flex-col">
                    {waiting ? (
                      <p
                        className="py-1 text-[length:var(--text-secondary)] text-muted"
                        role="status"
                      >
                        {waiting}
                      </p>
                    ) : null}
                    {/* The bot's words arrive whole, as its room message when the turn ends. */}
                    {/* The live status sits at the foot of the turn until it is done. */}
                    {message ? (
                      <WorkStatus checking={transcript?.checking} message={message} name={name} />
                    ) : (
                      <Thinking name={name} />
                    )}
                  </div>
                </article>
                {message ? <AskingRow message={message} sender={turn.bot} /> : null}
                {clarifies.map(clarify => (
                  <CardRow bot={bot} key={clarify.requestId}>
                    <ClarifyCard bot={bot} clarify={clarify} />
                  </CardRow>
                ))}
                {approvals.map(approval => (
                  <CardRow bot={bot} key={approval.requestId}>
                    <ApprovalCard approval={approval} />
                  </CardRow>
                ))}
              </Fragment>
            )
          })}
          <div ref={bottom} />
        </div>
      </ScrollArea>
    </div>
  )
}
