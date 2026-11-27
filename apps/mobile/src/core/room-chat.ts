import type { GatewayEvent } from '@hermes/shared'
import { asksCompatible } from '../../../web/src/lib/asks'
import { emptyChat, emptyTurn, reduceChat } from './chat'
import type { ChatMessage, ChatState, ChatTool, Room, RoomEvent, RoomTurn, RoomTurnState } from './types'

const toAskCall = (tool: ChatTool) => ({
  args: tool.args,
  name: tool.name,
  ...(tool.occurrenceId && { occurrenceId: tool.occurrenceId }),
  result: tool.detail,
  status: tool.status,
  summary: tool.action
})

const sameAskOccurrence = (a: ChatTool, b: ChatTool) => {
  if (a.id !== b.id || a.name !== b.name) return false
  if ((a.parentToolCallId ?? '') !== (b.parentToolCallId ?? '')) return false
  if (a.parentOccurrenceId && b.parentOccurrenceId && a.parentOccurrenceId !== b.parentOccurrenceId) {
    return false
  }
  if (a.occurrenceId && b.occurrenceId) return a.occurrenceId === b.occurrenceId
  if (a.parentToolCallId && (b.hydrated || (a.parentOccurrenceId && b.parentOccurrenceId))) {
    if (a.row && b.row && a.row !== b.row) return false
    return asksCompatible(toAskCall(a), toAskCall(b))
  }
  if (a.row && b.row) {
    if (a.row !== b.row) return false
    return asksCompatible(toAskCall(a), toAskCall(b))
  }
  if (a.status !== 'running' && b.status === 'running') return false
  if ((a.row || b.row) && !a.parentToolCallId) {
    if (a.status !== 'running' || (a.row && !a.hydrated)) return false
  }
  return asksCompatible(toAskCall(a), toAskCall(b))
}

export const mergeAsked = (
  existing: ChatTool[] = [],
  incoming: ChatTool[],
  order: 'append' | 'prepend' = 'append'
): ChatTool[] => {
  const result = [...existing]
  const incomingAsks = incoming.filter(tool => tool.name === 'message_bot')
  const used = new Set<number>()
  const matchedIndices: (number | null)[] = []

  for (const tool of incomingAsks) {
    const at = result.findIndex(
      (item, index) => !used.has(index) && index < existing.length && sameAskOccurrence(item, tool)
    )
    if (at >= 0) {
      used.add(at)
      const prev = result[at]!
      // Preserve an already-settled ask when replaying an older `tool.start`, and
      // keep earlier metadata (such as `section_id` in `detail`, `occurrenceId`, or `row`).
      result[at] =
        prev.status !== 'running' && tool.status === 'running'
          ? {
              ...prev,
              ...(tool.occurrenceId && !prev.occurrenceId && { occurrenceId: tool.occurrenceId }),
              ...(tool.parentOccurrenceId &&
                !prev.parentOccurrenceId && { parentOccurrenceId: tool.parentOccurrenceId }),
              ...(tool.parentToolCallId &&
                !prev.parentToolCallId && { parentToolCallId: tool.parentToolCallId }),
              ...(tool.row && !prev.row && { row: tool.row }),
              ...(tool.action && !prev.action && { action: tool.action }),
              args: prev.args ?? tool.args
            }
          : {
              ...tool,
              ...(prev.liveStarted && !tool.liveStarted && { liveStarted: true }),
              ...(prev.liveCompleted && !tool.liveCompleted && { liveCompleted: true }),
              ...(prev.occurrenceId && !tool.occurrenceId && { occurrenceId: prev.occurrenceId }),
              ...(prev.parentOccurrenceId &&
                !tool.parentOccurrenceId && { parentOccurrenceId: prev.parentOccurrenceId }),
              ...(prev.parentToolCallId &&
                !tool.parentToolCallId && { parentToolCallId: prev.parentToolCallId }),
              ...(prev.row && !tool.row && { row: prev.row }),
              ...(prev.action && !tool.action && { action: prev.action }),
              args: tool.args ?? prev.args,
              detail: tool.detail || prev.detail
            }
      matchedIndices.push(at)
    } else {
      matchedIndices.push(null)
    }
  }

  // Insert missing asks in first-call order: before their next matched neighbor when
  // one follows, or immediately after the last matched call so missed snapshot asks
  // land ahead of newer live calls that arrived after the snapshot was sampled.
  let lastMatchedIdx: number | null = null
  for (const pos of matchedIndices) {
    if (pos !== null) lastMatchedIdx = pos
  }
  const unmatched: ChatTool[] = []
  let nextMatch: number | null = null
  for (let idx = incomingAsks.length - 1; idx >= 0; idx--) {
    const pos = matchedIndices[idx]!
    if (pos !== null) {
      nextMatch = pos
    } else if (nextMatch !== null) {
      result.splice(nextMatch, 0, incomingAsks[idx]!)
    } else if (lastMatchedIdx !== null) {
      result.splice(lastMatchedIdx + 1, 0, incomingAsks[idx]!)
    } else {
      unmatched.unshift(incomingAsks[idx]!)
    }
  }

  return order === 'prepend' ? [...unmatched, ...result] : [...result, ...unmatched]
}

const newTurn = (bot: string, sessionId: string, roomTurnId?: string): RoomTurnState => ({
  ...emptyTurn(),
  bot,
  sessionId,
  ...(roomTurnId && { roomTurnId }),
  busy: true,
  asked: [],
  completed: false,
  silent: false
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
    // A room shows a card only while it waits; an answered one leaves.
    approvals: turns.flatMap(t => t.approvals).filter(a => !a.decision),
    questions: turns.flatMap(t => t.questions)
  }
}

const LIMITS: Record<string, string> = {
  daily_tokens: 'Daily token limit reached.',
  room_bot_turns_per_human_turn: 'Bot reply limit reached.',
  room_budget_tokens_per_human_turn: 'Room token budget reached.',
  bot_daily_token_budget: 'Bot daily token budget reached.'
}

const memberName = (room: Room, kind: 'bot' | 'human', id: string | null) =>
  room.members.find(m => m.member_kind === kind && m.member_id === id)?.display_name

export function roomMessage(event: RoomEvent, room: Room): ChatMessage | null {
  const base = { id: `room-${event.seq}`, createdAt: event.created_at * 1000 }
  const error = typeof event.payload.error === 'string' ? event.payload.error : ''
  if (event.kind === 'turn.failed') {
    const who =
      event.actor_kind === 'bot' ? memberName(room, 'bot', event.actor_id) || event.actor_id : null
    return {
      ...base,
      role: 'system',
      tone: 'danger',
      text: [`${who || 'The room'} stopped`, error].filter(Boolean).join(' · ')
    }
  }
  if (event.kind === 'limit.tripped')
    return {
      ...base,
      role: 'system',
      tone: 'danger',
      text: LIMITS[String(event.payload.limit)] ?? 'A room limit was reached.'
    }
  if (event.kind !== 'message.user' && event.kind !== 'message.bot') return null
  const asks =
    event.kind === 'message.bot' && Array.isArray(event.payload.asks)
      ? event.payload.asks.flatMap((entry, index) => {
          const item = entry as {
            failed?: unknown
            section_id?: unknown
            to?: unknown
            waited?: unknown
          } | null
          if (!item || typeof item.to !== 'string') return []
          const sent = item.waited === 0 || item.waited === false
          const failed = item.failed === 1 || item.failed === true
          return [
            {
              id: `ask-${event.seq}-${index}`,
              name: 'message_bot',
              args: { to: item.to },
              detail: JSON.stringify({
                ...(typeof item.section_id === 'string' ? { section_id: item.section_id } : {}),
                ...(sent ? { status: 'sent' } : {})
              }),
              status: failed ? ('error' as const) : ('ok' as const)
            }
          ]
        })
      : []
  return {
    ...base,
    role: event.kind === 'message.user' ? 'user' : 'assistant',
    text: String(event.payload.text ?? ''),
    sender: event.actor_id ?? undefined,
    ...(asks.length ? { tools: asks } : {}),
    senderName:
      event.kind !== 'message.user'
        ? undefined
        : // Someone in a Discord channel, named as Discord showed them.
          event.actor_kind === 'discord'
          ? event.payload.author?.name || 'Someone'
          : memberName(room, 'human', event.actor_id) || 'Former member'
  }
}

const turnAsks = (asks?: RoomTurn['asks']): ChatTool[] =>
  (asks ?? []).map(ask => ({
    id: ask.tool_id,
    name: 'message_bot',
    args: ask.args ?? null,
    ...(ask.context ? { action: ask.context } : {}),
    detail:
      ask.result != null
        ? typeof ask.result === 'string'
          ? ask.result
          : JSON.stringify(ask.result)
        : ask.section_id
          ? JSON.stringify({ section_id: ask.section_id })
          : '',
    status: ask.status,
    ...(ask.status === 'running' ? { hydrated: true } : {}),
    ...(ask.occurrence_id ? { occurrenceId: ask.occurrence_id } : {}),
    ...(ask.parent_occurrence_id ? { parentOccurrenceId: ask.parent_occurrence_id } : {}),
    ...(ask.parent_tool_call_id ? { parentToolCallId: ask.parent_tool_call_id } : {}),
    ...(ask.message_id ? { row: ask.message_id } : {}),
    ...(ask.turn_id ? { turnId: ask.turn_id } : {})
  }))

/** Reconnection starts from a fresh snapshot; only active sessions can receive replayed cards. */
export function restoreRoom(room: Room, events: RoomEvent[]): ChatState {
  return roomChat({
    ...emptyChat(),
    messages: events.flatMap(e => {
      const m = roomMessage(e, room)
      return m ? [m] : []
    }),
    turns: Object.fromEntries(
      (room.turns ?? []).flatMap(t => {
        if (!t.live_session_id) return []
        const asks = turnAsks(t.asks)
        const turnId = t.turn_id ?? asks.find(a => a.turnId)?.turnId
        return [
          [
            t.live_session_id,
            {
              ...newTurn(t.bot, t.live_session_id, t.id),
              ...(asks.length && { asked: asks, fromSnapshot: true, tools: asks }),
              ...(turnId && { turnId })
            }
          ]
        ]
      })
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
  const completingAsks = { ...(state.completingAsks ?? {}) }
  if (event.type === 'hexbot.rooms.turn' && p.room_id === room.id) {
    const id = typeof p.live_session_id === 'string' ? p.live_session_id : undefined
    const roomTurnId = typeof p.id === 'string' && p.id ? p.id : undefined
    const bot = String(p.bot ?? '')
    const status = String(p.status ?? '')
    if (id && ['running', 'working', 'waiting'].includes(status)) {
      if (bot) delete completingAsks[bot]
      const existingTurn =
        turns[id] && roomTurnId && turns[id].roomTurnId && turns[id].roomTurnId !== roomTurnId
          ? undefined
          : turns[id]
      turns[id] = {
        ...(existingTurn ?? newTurn(bot, id, roomTurnId)),
        ...(roomTurnId && { roomTurnId }),
        activity: `${botName(bot)} is working`
      }
    } else {
      const endedTools = Object.entries(turns).flatMap(([key, turn]) =>
        (key === id || turn.bot === bot) && !turn.silent
          ? (turn.asked?.length ? turn.asked : turn.tools)
              .filter(t => t.name === 'message_bot')
              .map(t => (t.status === 'running' ? { ...t, status: 'ok' as const } : t))
          : []
      )
      for (const [key, turn] of Object.entries(turns))
        if (key === id || turn.bot === bot) delete turns[key]
      if (bot) {
        if (status === 'complete' && endedTools.length) completingAsks[bot] = endedTools
        else delete completingAsks[bot]
      }
    }
    return roomChat({ ...state, completingAsks, turns })
  }
  if (event.type === 'hexbot.rooms.event' && p.room_id === room.id) {
    const incoming = p.event as RoomEvent | undefined
    if (!incoming || state.messages.some(m => m.id === `room-${incoming.seq}`)) return state
    const message = roomMessage(incoming, room)
    // A durable reply replaces only that bot's transient text and completing asks.
    if (incoming.kind === 'message.bot') {
      if (incoming.actor_id) delete completingAsks[incoming.actor_id]
      for (const [id, turn] of Object.entries(turns))
        if (turn.bot === incoming.actor_id) turns[id] = { ...turn, streaming: '', interim: [] }
    } else if (incoming.kind === 'turn.failed' && incoming.actor_id) {
      delete completingAsks[incoming.actor_id]
    }
    return roomChat({
      ...state,
      completingAsks,
      turns,
      messages: message ? [...state.messages, message] : state.messages
    })
  }
  const id = event.session_id
  if (!id || !turns[id]) return state
  const turn = turns[id]
  const incomingTurnId = typeof p.turn_id === 'string' ? p.turn_id : undefined
  // Keep earlier asks across a fallback continuation (`!turn.completed`) or a
  // buffered `message.start` for a snapshotted turn. Only reset `asked` when a
  // reused live session starts a new turn after an earlier `message.complete`.
  const preserveOnStart = Boolean(
    event.type === 'message.start' &&
      !turn.completed &&
      (Boolean(turn.asked?.length) ||
        (turn.fromSnapshot && (!incomingTurnId || !turn.turnId || incomingTurnId === turn.turnId)))
  )
  const reduced = preserveOnStart
    ? {
        ...emptyChat(),
        ...turn,
        busy: true,
        streaming: '',
        interim: [],
        interimIds: [],
        streamId: undefined,
        turnId: incomingTurnId ?? turn.turnId,
        error: null
      }
    : reduceChat({ ...emptyChat(), ...turn }, event)
  // Keep every message_bot call across `message.complete` (which empties `reduced.tools` into
  // `reduced.messages`) so live asks survive through `hexbot.rooms.turn(complete)` -> `message.bot`.
  // A fresh `message.start` after `message.complete` begins a new turn and clears earlier asks.
  const asked = preserveOnStart
    ? (turn.asked ?? [])
    : mergeAsked(event.type === 'message.start' ? [] : turn.asked, [
        ...reduced.messages.flatMap(m => m.tools ?? []),
        ...reduced.tools
      ])
  const completed =
    event.type === 'message.complete'
      ? true
      : event.type === 'message.start'
        ? false
        : turn.completed
  const fromSnapshot =
    event.type === 'message.start' || event.type === 'message.complete'
      ? false
      : turn.fromSnapshot
  let silent = turn.silent ?? false
  if (event.type === 'message.complete') {
    // Match the daemon (`rooms.rs`): decide silence from the final completion answer, not interim text.
    const finalText = (typeof p.text === 'string' ? p.text : turn.streaming).trim()
    silent = !finalText || finalText.toLowerCase() === '(pass)'
  } else if (
    event.type === 'message.start' ||
    event.type === 'message.delta' ||
    event.type === 'message.interim'
  ) {
    silent = false
  }
  // Durable room replies arrive separately; session completion retires its pending cards.
  const { messages: _messages, turns: _turns, ...transient } = reduced
  turns[id] = { ...turn, ...transient, asked, completed, fromSnapshot, silent }
  return roomChat({ ...state, turns })
}
