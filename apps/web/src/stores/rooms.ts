import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'

import {
  roomsAddMember,
  roomsCreate,
  roomsDelete,
  roomsGet,
  roomsList,
  roomsLog,
  roomsMarkRead,
  roomsRemoveMember,
  roomsUpdate
} from '../lib/api'
import type { RoomCreateInput } from '../lib/api'
import type { BotStatus, Room, RoomEvent, RoomTurn } from '../lib/types'

import { botIdleRevision } from './bots'
import { transcriptRevision, useTranscripts } from './transcripts'

export interface RoomsState {
  addMember: (id: string, bot: string) => Promise<void>
  byId: Record<string, Room>
  create: (input: RoomCreateInput) => Promise<Room>
  /** Forget a room the daemon deleted. */
  drop: (id: string) => void
  error: null | string
  eventsByRoom: Record<string, RoomEvent[]>
  handleEvent: (roomId: string, event: RoomEvent) => void
  handleTurn: (turn: RoomTurn) => void
  liveTurnsByRoom: Record<string, Record<string, RoomTurn>>
  loading: boolean
  /** Best effort: failures are swallowed, and a room that is gone is dropped. */
  markRead: (id: string, seq: number) => Promise<void>
  /** Resolves once loaded, or once the room turned out to be gone and was dropped. */
  open: (id: string) => Promise<void>
  order: string[]
  refresh: () => Promise<void>
  /** Resolves true once the daemon answered: the room loaded, or it is gone and was dropped. */
  refreshOne: (id: string) => Promise<boolean>
  remove: (id: string) => Promise<void>
  /** Resolves true when the room was deleted because its last bot left. */
  removeMember: (id: string, bot: string) => Promise<boolean>
  update: (id: string, patch: Parameters<typeof roomsUpdate>[1]) => Promise<void>
}

/** The daemon no longer shows this room to you. */
function roomGone(error: unknown): boolean {
  const code = (error as { code?: number } | null)?.code

  return code === 4230 || code === 4302
}

/** Counts turn changes per room, so a refresh keeps turns that moved while it loaded. */
const turnChanges = new Map<string, number>()
const deletedRooms = new Set<string>()
let roomsRequest = 0
let acceptedRoomsRequest = 0

/** A different daemon may legitimately use the same room id. */
export function clearDeletedRooms(): void {
  deletedRooms.clear()
}

function bumpTurns(roomId: string): void {
  turnChanges.set(roomId, (turnChanges.get(roomId) ?? 0) + 1)
}

/** Live turns rebuilt from the daemon's running turns, for a reconnect. */
function runningTurns(rooms: Room[]): RoomsState['liveTurnsByRoom'] {
  return Object.fromEntries(
    rooms.map(room => [
      room.id,
      Object.fromEntries(
        (room.turns ?? []).map(turn => [
          turn.bot,
          { ...turn, room_id: room.id, status: 'running' } satisfies RoomTurn
        ])
      )
    ])
  )
}

function messageSeq(events: RoomEvent[]): number {
  return events.at(-1)?.seq ?? 0
}

function indexRooms(rooms: Room[]): Pick<RoomsState, 'byId' | 'order'> {
  return {
    byId: Object.fromEntries(rooms.map(room => [room.id, room])),
    order: rooms.map(room => room.id)
  }
}

function mergeRoom(state: RoomsState, room: Room): Partial<RoomsState> {
  if (deletedRooms.has(room.id)) {
    return {}
  }

  return {
    byId: { ...state.byId, [room.id]: room },
    order: state.order.includes(room.id) ? state.order : [room.id, ...state.order]
  }
}

export function completedRoomRetry(
  transcript:
    | {
        bot?: string
        sectionId?: string
        retryResolved?: boolean
        liveStatus?: 'idle' | 'working' | 'needs_you'
        roomTurnRunning?: boolean
        streamingMessageId?: string | null
        waitingRequests?: unknown[]
      }
    | undefined,
  roomId: string,
  bot: string
): boolean {
  return Boolean(
    transcript?.sectionId === `room:${roomId}` &&
    transcript.bot === bot &&
    transcript.retryResolved &&
    (transcript.liveStatus === 'idle' || (!transcript.liveStatus && !transcript.roomTurnRunning)) &&
    !transcript.streamingMessageId &&
    !transcript.waitingRequests?.length
  )
}

function retireCompletedRetries(
  roomId: string,
  bot: string,
  live: string | null,
  revision = Infinity
): void {
  const transcripts = useTranscripts.getState()

  for (const transcript of Object.values(transcripts.bySession)) {
    if (
      transcript.sessionId !== live &&
      transcript.authorityRevision <= revision &&
      completedRoomRetry(transcript, roomId, bot)
    ) {
      transcripts.drop(transcript.sessionId)
    }
  }
}

function dropRoom(state: RoomsState, id: string): Partial<RoomsState> {
  deletedRooms.add(id)
  const transcripts = useTranscripts.getState()

  for (const transcript of Object.values(transcripts.bySession)) {
    if (transcript.sectionId === `room:${id}`) {
      transcripts.drop(transcript.sessionId)
    }
  }

  const byId = { ...state.byId }
  const eventsByRoom = { ...state.eventsByRoom }
  const liveTurnsByRoom = { ...state.liveTurnsByRoom }
  delete byId[id]
  delete eventsByRoom[id]
  delete liveTurnsByRoom[id]

  return { byId, eventsByRoom, liveTurnsByRoom, order: state.order.filter(item => item !== id) }
}

export const useRooms = create<RoomsState>((set, get) => ({
  byId: {},
  error: null,
  eventsByRoom: {},
  liveTurnsByRoom: {},
  loading: false,
  order: [],

  async refresh() {
    const request = ++roomsRequest
    set({ error: null, loading: true })
    const changes = new Map(turnChanges)
    const revision = transcriptRevision()
    const idleRevision = botIdleRevision()

    try {
      const { rooms } = await roomsList(true)
      const listed = (rooms ?? []).filter(room => !deletedRooms.has(room.id))
      const active = listed.filter(room => !room.archived_at)
      const logs = await Promise.all(active.map(room => roomsLog(room.id, { limit: 1000 })))

      if (request < acceptedRoomsRequest) {
        return
      }

      acceptedRoomsRequest = request
      // Turn events are not replayed, so whatever ended while this client was
      // away would stay "working"; the daemon's running turns replace them,
      // except in rooms whose turns changed after the list was read.
      const current = get().liveTurnsByRoom
      const restored = runningTurns(active.filter(room => !deletedRooms.has(room.id)))

      // A daemon without `turns` cannot say, so those rooms keep what they had.
      const liveTurnsByRoom = Object.fromEntries(
        Object.entries(restored).map(([id, turns]) => [
          id,
          turnChanges.get(id) === changes.get(id) && rooms?.find(room => room.id === id)?.turns
            ? turns
            : (current[id] ?? {})
        ])
      )

      const transcripts = useTranscripts.getState()

      for (const turns of Object.values(current)) {
        for (const turn of Object.values(turns)) {
          const running = liveTurnsByRoom[turn.room_id]?.[turn.bot]

          if (
            turn.live_session_id &&
            running?.live_session_id !== turn.live_session_id &&
            !completedRoomRetry(transcripts.bySession[turn.live_session_id], turn.room_id, turn.bot)
          ) {
            transcripts.drop(turn.live_session_id)
          }
        }
      }

      for (const turns of Object.values(liveTurnsByRoom)) {
        for (const turn of Object.values(turns)) {
          if (turn.live_session_id) {
            retireCompletedRetries(turn.room_id, turn.bot, turn.live_session_id, revision)
            transcripts.open(turn.live_session_id, `room:${turn.room_id}`, [], revision, turn.bot, {
              preserveWaiting: true,
              preserveRetryResolved: true,
              roomTurnRunning:
                turns === restored[turn.room_id] && botIdleRevision(turn.bot) <= idleRevision
            })
          }
        }
      }

      set({
        ...indexRooms(listed.filter(room => !deletedRooms.has(room.id))),
        eventsByRoom: Object.fromEntries(
          active.flatMap((room, index) =>
            deletedRooms.has(room.id) ? [] : [[room.id, logs[index]?.events ?? []]]
          )
        ),
        liveTurnsByRoom,
        loading: false
      })
    } catch (error) {
      if (request < acceptedRoomsRequest) {
        return
      }

      set({ error: error instanceof Error ? error.message : String(error), loading: false })
    }
  },

  async refreshOne(id) {
    try {
      const { room } = await roomsGet(id)
      set(state => mergeRoom(state, room))

      return true
    } catch (error) {
      if (roomGone(error)) {
        set(state => dropRoom(state, id))

        return true
      }

      await get().refresh()

      return false
    }
  },

  async open(id) {
    let loaded: [{ room: Room }, { events: RoomEvent[] }]

    try {
      loaded = await Promise.all([roomsGet(id), roomsLog(id, { limit: 1000 })])
    } catch (error) {
      if (!roomGone(error)) {
        throw error
      }

      set(state => dropRoom(state, id))

      return
    }

    const [{ room }, { events }] = loaded

    if (deletedRooms.has(id)) {
      return
    }

    const ordered = [...events].sort((a, b) => a.seq - b.seq)
    set(state => ({
      ...mergeRoom(state, room),
      eventsByRoom: { ...state.eventsByRoom, [id]: ordered }
    }))
    const seq = messageSeq(ordered)

    if (seq) {
      await get().markRead(id, seq)
    }
  },

  async markRead(id, seq) {
    try {
      const { room } = await roomsMarkRead(id, seq)
      set(state => mergeRoom(state, room))
    } catch (error) {
      // Read marks are best effort; a room you were taken out of goes away.
      if (roomGone(error)) {
        set(state => dropRoom(state, id))
      }
    }
  },

  async create(input) {
    const { room } = await roomsCreate(input)
    set(state => mergeRoom(state, room))

    return room
  },

  async addMember(id, bot) {
    const { room } = await roomsAddMember(id, bot)
    set(state => mergeRoom(state, room))
  },

  async removeMember(id, bot) {
    const { room } = await roomsRemoveMember(id, bot)

    if ((room as Room & { deleted?: boolean }).deleted) {
      set(state => dropRoom(state, id))

      return true
    }

    set(state => mergeRoom(state, room))

    return false
  },

  drop(id) {
    set(state => dropRoom(state, id))
  },

  async update(id, patch) {
    const { room } = await roomsUpdate(id, patch)
    set(state => mergeRoom(state, room))
  },

  async remove(id) {
    await roomsDelete(id)
    set(state => dropRoom(state, id))
  },

  handleEvent(roomId, event) {
    if (deletedRooms.has(roomId)) {
      return
    }

    set(state => {
      const current = state.eventsByRoom[roomId] ?? []

      const events = [...current.filter(item => item.seq !== event.seq), event].sort(
        (a, b) => a.seq - b.seq
      )

      const room = state.byId[roomId]
      const turns = { ...(state.liveTurnsByRoom[roomId] ?? {}) }

      if (event.kind === 'message.bot' && event.actor_id) {
        bumpTurns(roomId)
        const turn = turns[event.actor_id]

        if (
          turn?.live_session_id &&
          !completedRoomRetry(
            useTranscripts.getState().bySession[turn.live_session_id],
            roomId,
            event.actor_id
          )
        ) {
          useTranscripts.getState().drop(turn.live_session_id)
        }

        delete turns[event.actor_id]
      }

      return {
        byId: room
          ? {
              ...state.byId,
              [roomId]: {
                ...room,
                last_activity_at: event.created_at,
                updated_at: event.created_at
              }
            }
          : state.byId,
        eventsByRoom: { ...state.eventsByRoom, [roomId]: events },
        liveTurnsByRoom: { ...state.liveTurnsByRoom, [roomId]: turns }
      }
    })
  },

  handleTurn(turn) {
    if (deletedRooms.has(turn.room_id)) {
      return
    }

    bumpTurns(turn.room_id)
    set(state => {
      const current = { ...(state.liveTurnsByRoom[turn.room_id] ?? {}) }

      if (turn.status === 'running' && !turn.live_session_id) {
        retireCompletedRetries(turn.room_id, turn.bot, null)
      }

      if (turn.live_session_id && !['complete', 'failed', 'stopped'].includes(turn.status)) {
        current[turn.bot] = turn
        retireCompletedRetries(turn.room_id, turn.bot, turn.live_session_id)
        useTranscripts
          .getState()
          .open(turn.live_session_id, `room:${turn.room_id}`, [], undefined, turn.bot, {
            preserveWaiting: true,
            roomTurnRunning: turn.status === 'running'
          })
      } else {
        const previous = current[turn.bot]

        if (previous?.live_session_id && previous.live_session_id !== turn.live_session_id) {
          return state
        }

        // The turn is over; its live session may serve the next one, which
        // must not inherit cards nobody can answer any more.
        const live = previous?.live_session_id ?? turn.live_session_id
        const transcript = live ? useTranscripts.getState().bySession[live] : undefined

        if (
          live &&
          transcript?.sectionId === `room:${turn.room_id}` &&
          transcript.bot === turn.bot &&
          !(turn.status === 'complete' && completedRoomRetry(transcript, turn.room_id, turn.bot))
        ) {
          useTranscripts.getState().drop(live)
        }

        delete current[turn.bot]
      }

      return { liveTurnsByRoom: { ...state.liveTurnsByRoom, [turn.room_id]: current } }
    })
  }
}))

/**
 * What the room is doing, folded from its live turns and its latest event:
 * working while any bot has a turn in flight, needs you while the last thing
 * that happened was a bot tagging you, stopped when the last turn failed.
 */
export function roomStatus(
  events: RoomEvent[],
  turns: Record<string, RoomTurn> | undefined
): BotStatus {
  if (turns && Object.keys(turns).length > 0) {
    return 'working'
  }

  const latest = events.at(-1)

  if (latest?.kind === 'turn.failed') {
    return 'stopped'
  }

  return latest?.kind === 'waiting.human' ? 'needs_you' : 'idle'
}

/** The error text of the latest failed turn, when the room's last event is one. */
export function roomFailure(events: RoomEvent[]): null | string {
  const latest = events.at(-1)

  if (latest?.kind !== 'turn.failed') {
    return null
  }

  return typeof latest.payload.error === 'string' && latest.payload.error
    ? latest.payload.error
    : 'The turn did not finish.'
}

/** Unread for `currentId`; without user accounts, for the one human member. */
export function roomUnread(room: Room, events: RoomEvent[], currentId?: string): boolean {
  const human = room.members.find(
    member =>
      member.member_kind === 'human' &&
      !member.left_at &&
      (!currentId || member.member_id === currentId)
  )

  return messageSeq(events) > (human?.last_read_seq ?? 0)
}

export function useRoomList(): Room[] {
  return useRooms(
    useShallow(state =>
      state.order.map(id => state.byId[id]).filter((room): room is Room => Boolean(room))
    )
  )
}
