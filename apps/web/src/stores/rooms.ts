import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'

import {
  roomsAddMember,
  roomsCreate,
  roomsGet,
  roomsList,
  roomsLog,
  roomsMarkRead,
  roomsRemoveMember
} from '../lib/api'
import type { RoomCreateInput } from '../lib/api'
import type { Room, RoomEvent, RoomTurn } from '../lib/types'

import { useTranscripts } from './transcripts'

export interface RoomsState {
  addMember: (id: string, bot: string) => Promise<void>
  byId: Record<string, Room>
  create: (input: RoomCreateInput) => Promise<Room>
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
  removeMember: (id: string, bot: string) => Promise<void>
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
    set(state => mergeRoom(state, room))
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
