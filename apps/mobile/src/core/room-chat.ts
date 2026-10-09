import type { GatewayEvent } from '@hermes/shared'
import { emptyChat, emptyTurn, reduceChat } from './chat'
import type { ChatMessage, ChatState, Room, RoomEvent, RoomTurnState } from './types'

const newTurn = (bot: string, sessionId: string): RoomTurnState => ({
  ...emptyTurn(),
  bot,
  sessionId,
  busy: true
})

/** A room stays busy until every bot's turn has ended, including waiting turns. */
export function roomChat(state: ChatState): ChatState {
  const turns = Object.values(state.turns)
  return {
    ...state,
    busy: turns.length > 0,
    activity: turns
      .map(t => t.activity)
      .filter(Boolean)
      .join(' · '),
    approvals: turns.flatMap(t => t.approvals),
    questions: turns.flatMap(t => t.questions)
  }
}

export function roomMessage(event: RoomEvent, room: Room): ChatMessage | null {
  const base = { id: `room-${event.seq}`, createdAt: event.created_at * 1000 }
  if (event.kind === 'turn.failed' || event.kind === 'limit.tripped') {
    const limits: Record<string, string> = {
      bot_turns_per_human_turn: 'Bot reply limit reached.',
      budget_tokens_per_human_turn: 'Room token budget reached.',
      bot_daily_token_budget: 'Bot daily token budget reached.'
    }
    return {
      ...base,
      role: 'system',
      tone: 'danger',
      text:
        typeof event.payload.error === 'string' && event.payload.error
          ? event.payload.error
          : event.kind === 'turn.failed'
            ? 'The turn did not finish.'
            : (limits[String(event.payload.limit)] ?? 'Room limit reached.')
    }
  }
  if (event.kind !== 'message.user' && event.kind !== 'message.bot') return null
  return {
    ...base,
    role: event.kind === 'message.user' ? 'user' : 'assistant',
    text: String(event.payload.text ?? ''),
    sender: event.actor_id ?? undefined,
    senderName:
      event.kind === 'message.user'
        ? room.members.find(m => m.member_kind === 'human' && m.member_id === event.actor_id)
            ?.display_name || 'Former member'
        : undefined
  }
}

/** Reconnection starts from a fresh snapshot; only active sessions can receive replayed cards. */
export function restoreRoom(room: Room, events: RoomEvent[]): ChatState {
  return roomChat({
    ...emptyChat(),
    messages: events.flatMap(e => {
      const m = roomMessage(e, room)
      return m ? [m] : []
    }),
    turns: Object.fromEntries(
      (room.turns ?? []).flatMap(t =>
        t.live_session_id ? [[t.live_session_id, newTurn(t.bot, t.live_session_id)]] : []
      )
    )
  })
}

export function reduceRoom(
  state: ChatState,
  event: GatewayEvent,
  room: Room,
  botName: (id: string) => string
): ChatState {
  const p = (event.payload ?? {}) as Record<string, unknown>
  const turns = { ...state.turns }
  if (event.type === 'hexbot.rooms.turn' && p.room_id === room.id) {
    const id = typeof p.live_session_id === 'string' ? p.live_session_id : undefined
    const bot = String(p.bot ?? '')
    if (id && ['running', 'working', 'waiting'].includes(String(p.status))) {
      turns[id] = { ...(turns[id] ?? newTurn(bot, id)), activity: `${botName(bot)} is working` }
    } else {
      for (const [key, turn] of Object.entries(turns))
        if (key === id || turn.bot === bot) delete turns[key]
    }
    return roomChat({ ...state, turns })
  }
  if (event.type === 'hexbot.rooms.event' && p.room_id === room.id) {
    const incoming = p.event as RoomEvent | undefined
    if (!incoming || state.messages.some(m => m.id === `room-${incoming.seq}`)) return state
    const message = roomMessage(incoming, room)
    // A durable reply replaces only that bot's transient text.
    if (incoming.kind === 'message.bot') {
      for (const [id, turn] of Object.entries(turns))
        if (turn.bot === incoming.actor_id) turns[id] = { ...turn, streaming: '', interim: [] }
    }
    return roomChat({
      ...state,
      turns,
      messages: message ? [...state.messages, message] : state.messages
    })
  }
  const id = event.session_id
  if (!id || !turns[id]) return state
  const turn = turns[id]
  const reduced = reduceChat({ ...emptyChat(), ...turn }, event)
  // Durable room replies arrive separately; session completion retires its pending cards.
  const { messages: _messages, turns: _turns, ...transient } = reduced
  turns[id] = { ...turn, ...transient }
  return roomChat({ ...state, turns })
}
