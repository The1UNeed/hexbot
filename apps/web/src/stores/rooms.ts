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

import { useTranscripts } from './transcripts'

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
  markRead: (id: string, seq: number) => Promise<void>
  open: (id: string) => Promise<void>
  order: string[]
  refresh: () => Promise<void>
  refreshOne: (id: string) => Promise<void>
  remove: (id: string) => Promise<void>
  /** Resolves true when the room was deleted because its last bot left. */
  removeMember: (id: string, bot: string) => Promise<boolean>
  update: (id: string, patch: Parameters<typeof roomsUpdate>[1]) => Promise<void>
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
  return {
    byId: { ...state.byId, [room.id]: room },
    order: state.order.includes(room.id) ? state.order : [room.id, ...state.order]
  }
}

function dropRoom(state: RoomsState, id: string): Partial<RoomsState> {
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
    set({ error: null, loading: true })

    try {
      const { rooms } = await roomsList(true)
      const listed = rooms ?? []
      const active = listed.filter(room => !room.archived_at)
      const logs = await Promise.all(active.map(room => roomsLog(room.id, { limit: 1000 })))
      set({
        ...indexRooms(listed),
        eventsByRoom: Object.fromEntries(
          active.map((room, index) => [room.id, logs[index]?.events ?? []])
        ),
        loading: false
      })
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error), loading: false })
    }
  },

  async refreshOne(id) {
    try {
      const { room } = await roomsGet(id)
      set(state => mergeRoom(state, room))
    } catch {
      await get().refresh()
    }
  },

  async open(id) {
    const [{ room }, { events }] = await Promise.all([roomsGet(id), roomsLog(id, { limit: 1000 })])
    const ordered = [...events].sort((a, b) => a.seq - b.seq)
    set(state => ({
      ...mergeRoom(state, room),
      eventsByRoom: { ...state.eventsByRoom, [id]: ordered }
    }))
    const seq = messageSeq(ordered)

    if (seq) {
      const result = await roomsMarkRead(id, seq)
      set(state => mergeRoom(state, result.room))
    }
  },

  async markRead(id, seq) {
    const { room } = await roomsMarkRead(id, seq)
    set(state => mergeRoom(state, room))
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
    set(state => {
      const current = state.eventsByRoom[roomId] ?? []

      const events = [...current.filter(item => item.seq !== event.seq), event].sort(
        (a, b) => a.seq - b.seq
      )

      const room = state.byId[roomId]
      const turns = { ...(state.liveTurnsByRoom[roomId] ?? {}) }

      if (event.kind === 'message.bot' && event.actor_id) {
        const turn = turns[event.actor_id]

        if (turn?.live_session_id) {
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
    set(state => {
      const current = { ...(state.liveTurnsByRoom[turn.room_id] ?? {}) }

      if (turn.live_session_id && !['complete', 'failed', 'stopped'].includes(turn.status)) {
        current[turn.bot] = turn
        useTranscripts.getState().open(turn.live_session_id, `room:${turn.room_id}`, [])
      } else {
        const previous = current[turn.bot]

        if (previous?.live_session_id) {
          useTranscripts.getState().messageComplete(previous.live_session_id)
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

export function roomUnread(room: Room, events: RoomEvent[]): boolean {
  const human = room.members.find(member => member.member_kind === 'human' && !member.left_at)

  return messageSeq(events) > (human?.last_read_seq ?? 0)
}

export function useRoomList(): Room[] {
  return useRooms(
    useShallow(state =>
      state.order.map(id => state.byId[id]).filter((room): room is Room => Boolean(room))
    )
  )
}
