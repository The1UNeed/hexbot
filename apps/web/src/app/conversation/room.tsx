import { useParams } from '@tanstack/react-router'
import { Crown, Plus, Send, Square, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { Avatar } from '../../components/ui/avatar'
import { Button } from '../../components/ui/button'
import { Menu } from '../../components/ui/menu'
import { Textarea } from '../../components/ui/textarea'
import { roomsSend, roomsStop } from '../../lib/api'
import { toMillis } from '../../lib/time'
import type { Bot, RoomEvent, RoomMember, RoomTurn } from '../../lib/types'
import { useBots } from '../../stores/bots'
import { useRooms } from '../../stores/rooms'
import { useTranscripts } from '../../stores/transcripts'

// Stable empty values: a fresh [] or {} per render re-renders forever.
const NO_EVENTS: RoomEvent[] = []
const NO_TURNS: Record<string, RoomTurn> = {}

const avatarData = (bot?: Bot) =>
  bot?.avatar ? `data:${bot.avatar.mime};base64,${bot.avatar.data}` : null

function RoomEventRow({ event }: { event: RoomEvent }) {
  const bot = useBots(state => (event.actor_id ? state.byName[event.actor_id] : undefined))
  const text = typeof event.payload.text === 'string' ? event.payload.text : ''
  const member = typeof event.payload.bot === 'string' ? event.payload.bot : event.actor_id
  const system = ['member.added', 'member.left', 'note'].includes(event.kind)

  if (event.kind === 'turn.started' || event.kind === 'turn.failed') {
    return null
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

  if (event.kind === 'waiting.human' || event.kind === 'limit.tripped') {
    return (
      <div
        className={`my-3 rounded-control px-3 py-2 ${event.kind === 'limit.tripped' ? 'bg-warning/12 text-warning' : 'bg-accent/12 text-accent'}`}
        data-testid="room-event"
      >
        {event.kind === 'waiting.human' ? 'Waiting on you' : text || 'A room limit was reached.'}
      </div>
    )
  }

  const human = event.kind === 'message.user'

  return (
    <article
      className={`flex gap-3 py-3 ${human ? 'flex-row-reverse' : ''}`}
      data-testid="room-event"
    >
      {human ? null : (
        <Avatar image={avatarData(bot)} name={bot?.display_name ?? event.actor_id ?? 'Bot'} />
      )}
      <div
        className={human ? 'max-w-[80%] rounded-message bg-accent/12 px-3 py-2' : 'min-w-0 flex-1'}
      >
        {!human ? (
          <div className="mb-1 text-[length:var(--text-secondary)] font-medium">
            {bot?.display_name ?? event.actor_id}
          </div>
        ) : null}
        <p className="whitespace-pre-wrap">{text}</p>
        <time className="mt-1 block text-[length:var(--text-meta)] text-muted">
          {new Date(toMillis(event.created_at)).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit'
          })}
        </time>
      </div>
    </article>
  )
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
      className="absolute bottom-full left-12 mb-1 min-w-52 rounded-control border border-border bg-surface p-1 shadow-popup"
      role="listbox"
    >
      {suggestions.map(member => (
        <button
          className="block w-full rounded-control px-3 py-2 text-left hover:bg-surface-2"
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
    return <div className="grid h-screen place-content-center text-muted">Loading room…</div>
  }

  return (
    <div className="flex h-screen min-h-0 flex-col bg-background">
      <header className="flex min-h-16 items-center gap-3 border-b border-border bg-surface px-4">
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold">{room.name}</h2>
          <div className="mt-1 flex items-center -space-x-1">
            {members.map(member => {
              const bot = bots[member.member_id]

              return (
                <div className="group relative" data-testid="room-member" key={member.member_id}>
                  <Avatar
                    image={avatarData(bot)}
                    name={bot?.display_name ?? member.member_id}
                    size="sm"
                  />
                  {room.main_bot === member.member_id ? (
                    <Crown
                      className="absolute -top-2 -right-1 fill-warning text-warning"
                      size={11}
                    />
                  ) : null}
                  <button
                    aria-label={`Remove ${bot?.display_name ?? member.member_id}`}
                    className="absolute inset-0 hidden place-items-center rounded-full bg-foreground/60 text-accent-fg group-hover:grid"
                    onClick={() => void useRooms.getState().removeMember(roomId, member.member_id)}
                    type="button"
                  >
                    <X size={12} />
                  </button>
                </div>
              )
            })}
          </div>
        </div>
        <Menu
          items={Object.values(bots)
            .filter(bot => !members.some(m => m.member_id === bot.name))
            .map(bot => ({
              label: bot.display_name,
              onSelect: () => void useRooms.getState().addMember(roomId, bot.name)
            }))}
          trigger={
            <Button aria-label="Add member" icon={<Plus size={14} />} size="sm">
              Add
            </Button>
          }
        />
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-5 py-4">
          {events.map(event => (
            <RoomEventRow event={event} key={event.seq} />
          ))}
          {Object.values(turns).map(turn => {
            const transcript = turn.live_session_id ? transcripts[turn.live_session_id] : undefined
            const message = transcript?.messages.at(-1)
            const bot = bots[turn.bot]

            return message?.text ? (
              <article className="flex gap-3 py-3" data-testid="room-event" key={turn.bot}>
                <Avatar image={avatarData(bot)} name={bot?.display_name ?? turn.bot} />
                <div>
                  <div className="mb-1 text-[length:var(--text-secondary)] font-medium">
                    {bot?.display_name ?? turn.bot}
                  </div>
                  <p className="whitespace-pre-wrap">
                    {message.text}
                    <span className="ml-1 inline-block h-4 w-px animate-pulse bg-accent" />
                  </p>
                </div>
              </article>
            ) : null
          })}
          <div ref={bottom} />
        </div>
      </div>
      <div className="relative border-t border-border bg-surface p-3" data-testid="room-composer">
        {mention === undefined ? null : (
          <RoomMentionPopover
            bots={bots}
            members={members}
            onSelect={name => setText(value => value.replace(/@([\w-]*)$/, `@${name} `))}
            query={mention}
          />
        )}
        <div className="flex items-end gap-2 rounded-panel border border-border px-2 py-2 focus-within:ring-2 focus-within:ring-accent/40">
          <Textarea
            aria-label="Message room"
            className="min-h-9 flex-1 border-0 p-2 focus-visible:ring-0"
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
          {streaming ? (
            <Button
              icon={<Square size={14} />}
              onClick={() => void roomsStop(roomId)}
              variant="primary"
            >
              Stop
            </Button>
          ) : (
            <Button
              busy={sending}
              disabled={!text.trim()}
              icon={<Send size={15} />}
              onClick={() => void send()}
              variant="primary"
            >
              Send
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
