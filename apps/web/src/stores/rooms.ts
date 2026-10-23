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
import { CatalogAuthority, type ReadOutcome } from '../lib/catalog-authority'
import type { BotStatus, Room, RoomEvent, RoomTurn } from '../lib/types'

import { connectionRead } from './connection'
import { useTranscripts } from './transcripts'

export interface RoomsState {
  addMember: (id: string, bot: string) => Promise<void>
  byId: Record<string, Room>
  answers: Record<string, ReadOutcome>
  create: (input: RoomCreateInput) => Promise<Room>
  /** Forget a room the daemon deleted. */
  drop: (id: string) => void
  error: null | string
  eventsByRoom: Record<string, RoomEvent[]>
  /** First verified event; absent for a log made only from live events. */
  logBaseline: Record<string, number>
  handleEvent: (roomId: string, event: RoomEvent) => void
  handleTurn: (turn: RoomTurn) => void
  liveTurnsByRoom: Record<string, Record<string, RoomTurn>>
  loading: boolean
  /** A successful network list, including an empty one, supersedes cached membership. */
  loaded: boolean
  rosterRevision: number
  /** Clear room state and authority when the selected connection is discarded. */
  reset: () => void
  /** Best effort: failures are swallowed, and a room that is gone is dropped. */
  markRead: (id: string, seq: number) => Promise<void>
  /** Resolves once loaded, or once the room turned out to be gone and was dropped. */
  open: (id: string) => Promise<ReadOutcome>
  order: string[]
  refresh: () => Promise<void>
  /** A discarded response never establishes membership or absence. */
  refreshOne: (id: string) => Promise<ReadOutcome>
  remove: (id: string) => Promise<void>
  /** Rooms and logs this device kept from the last time, drawn before the daemon answers. */
  restore: (
    rooms: Room[],
    eventsByRoom: Record<string, RoomEvent[]>,
    baseline?: Record<string, number>
  ) => void
  /** Only pass false after confirming room deletion. Resolves true if the room was deleted. */
  removeMember: (id: string, bot: string, keepRoom: boolean) => Promise<boolean>
  update: (id: string, patch: Parameters<typeof roomsUpdate>[1]) => Promise<void>
}

/** The daemon no longer shows this room to you. */
function roomGone(error: unknown): boolean {
  const code = (error as { code?: number } | null)?.code

  return code === 4230 || code === 4302
}

const authority = new CatalogAuthority()
const looking = new Map<string, Promise<ReadOutcome>>()
const opening = new Map<string, { request: Promise<ReadOutcome>; current: () => boolean }>()

export function roomCacheRead(): (id: string) => boolean {
  const connected = connectionRead()
  const current = authority.cacheRead()

  return id => connected() && current(id)
}

function roomRead(id: string): () => boolean {
  const connected = connectionRead()
  const current = authority.capture(id)

  return () => connected() && current()
}

/** Counts turn changes per room, so a refresh keeps turns that moved while it loaded. */
const turnChanges = new Map<string, number>()

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

export const LOG_PAGE = 1000
export const CACHED_ROOMS = 20

/** Only recent active rooms need startup logs; opening any room still reads it. */
export function recentRooms(rooms: Room[]): Room[] {
  return rooms
    .filter(room => !room.archived_at)
    .sort(
      (a, b) =>
        (b.last_activity_at ?? b.updated_at ?? 0) - (a.last_activity_at ?? a.updated_at ?? 0)
    )
    .slice(0, CACHED_ROOMS)
}

/**
 * The last seq a log holds without a gap. A room's seqs count up by one and are
 * never removed, so a gap is events this client missed: a live event can land
 * past those missed while it was away.
 */
export function syncedSeq(events: RoomEvent[]): number {
  let seq = events[0]?.seq ?? 0

  for (const event of events.slice(1)) {
    if (event.seq !== seq + 1) {
      break
    }

    seq = event.seq
  }

  return seq
}

/** Events the daemon sent for a log, and whether they replace what the client holds. */
interface LogUpdate {
  events: RoomEvent[]
  latest: boolean
}

/**
 * What a log is missing: the events after its synced part, or the room's latest
 * page when it holds none or has fallen more than a page behind.
 */
async function fetchLog(
  id: string,
  current: RoomEvent[],
  baseline: number | undefined
): Promise<LogUpdate> {
  const after = !baseline ? 0 : syncedSeq(current.filter(event => event.seq >= baseline))

  if (after) {
    const { events } = await roomsLog(id, { after_seq: after, limit: LOG_PAGE })

    if (events.length < LOG_PAGE) {
      return { events, latest: false }
    }
  }

  const { events } = await roomsLog(id, { before_seq: Number.MAX_SAFE_INTEGER, limit: LOG_PAGE })

  return { events, latest: true }
}

/** `current` with `update` applied, in seq order; live events that came in meanwhile stay. */
export function applyLog(current: RoomEvent[], update: LogUpdate): RoomEvent[] {
  const first = update.events[0]?.seq ?? 0
  const kept = update.latest ? current.filter(event => event.seq >= first) : current
  const bySeq = new Map(kept.map(event => [event.seq, event]))

  for (const event of update.events) {
    bySeq.set(event.seq, event)
  }

  return [...bySeq.values()].sort((a, b) => a.seq - b.seq)
}

function indexRooms(rooms: Room[]): Pick<RoomsState, 'byId' | 'order'> {
  return {
    byId: Object.fromEntries(rooms.map(room => [room.id, room])),
    order: rooms.map(room => room.id)
  }
}

function mergeRoom(state: RoomsState, room: Room): Partial<RoomsState> {
  return {
    answers: authority.outcomes(),
    byId: { ...state.byId, [room.id]: room },
    order: state.order.includes(room.id) ? state.order : [room.id, ...state.order]
  }
}

function dropRoom(state: RoomsState, id: string): Partial<RoomsState> {
  const byId = { ...state.byId }
  const eventsByRoom = { ...state.eventsByRoom }
  const liveTurnsByRoom = { ...state.liveTurnsByRoom }
  const logBaseline = { ...state.logBaseline }
  delete logBaseline[id]
  delete byId[id]
  delete eventsByRoom[id]
  delete liveTurnsByRoom[id]

  return {
    answers: authority.outcomes(),
    byId,
    eventsByRoom,
    liveTurnsByRoom,
    logBaseline,
    order: state.order.filter(item => item !== id)
  }
}

export const useRooms = create<RoomsState>((set, get) => ({
  byId: {},
  answers: {},
  error: null,
  eventsByRoom: {},
  logBaseline: {},
  liveTurnsByRoom: {},
  loading: false,
  loaded: false,
  rosterRevision: 0,
  order: [],

  reset() {
    authority.reset()
    looking.clear()
    opening.clear()
    turnChanges.clear()
    set({
      byId: {},
      answers: {},
      order: [],
      eventsByRoom: {},
      logBaseline: {},
      liveTurnsByRoom: {},
      loaded: false,
      rosterRevision: 0,
      loading: false,
      error: null
    })
  },

  async refresh() {
    const connected = connectionRead()
    const request = authority.request()
    const currentRead = () => connected() && authority.same(request)
    set({ error: null, loading: true })
    const changes = new Map(turnChanges)
    const readAt = Date.now()

    try {
      const { rooms } = await roomsList(true)

      if (!currentRead()) {
        return
      }

      const state = get()
      const listed = authority.list(request, rooms ?? [], state.byId, room => room.id)

      if (!listed) {
        return
      }

      const active = listed.filter(room => !room.archived_at)
      const activeIds = new Set(active.map(room => room.id))
      // Turn events are not replayed. Rebuild from the reconciled metadata,
      // keeping turns that changed after the list request.
      const current = state.liveTurnsByRoom
      const read = runningTurns(active)

      const liveTurnsByRoom = Object.fromEntries(
        Object.entries(read).map(([id, turns]) => [
          id,
          turnChanges.get(id) === changes.get(id) && listed.find(room => room.id === id)?.turns
            ? turns
            : (current[id] ?? {})
        ])
      )

      const transcripts = useTranscripts.getState()

      for (const turns of Object.values(current)) {
        for (const turn of Object.values(turns)) {
          const running = liveTurnsByRoom[turn.room_id]?.[turn.bot]

          if (turn.live_session_id && running?.live_session_id !== turn.live_session_id) {
            transcripts.drop(turn.live_session_id)
          }
        }
      }

      for (const [id, turns] of Object.entries(liveTurnsByRoom)) {
        for (const turn of Object.values(turns)) {
          const pending = turns === read[id] ? turn.pending_requests : undefined

          if (turn.live_session_id) {
            transcripts.open(
              turn.live_session_id,
              `room:${turn.room_id}`,
              [],
              undefined,
              pending ? { pending, readAt } : undefined
            )
          }
        }
      }

      // Publish membership and prune old state before any optional log reads.
      set(state => ({
        ...indexRooms(listed),
        answers: authority.outcomes(),
        logBaseline: Object.fromEntries(
          Object.entries(state.logBaseline).filter(([id]) => activeIds.has(id))
        ),
        eventsByRoom: Object.fromEntries(
          Object.entries(state.eventsByRoom).filter(([id]) => activeIds.has(id))
        ),
        liveTurnsByRoom,
        loading: false,
        loaded: true,
        rosterRevision: state.rosterRevision + 1
      }))

      await Promise.all(
        recentRooms(active).map(async room => {
          const currentRoom = roomRead(room.id)
          const ticket = authority.request()
          const valid = () => currentRead() && currentRoom() && Boolean(get().byId[room.id])

          try {
            const update = await fetchLog(
              room.id,
              get().eventsByRoom[room.id] ?? [],
              get().logBaseline[room.id]
            )

            if (!valid()) {
              return
            }

            set(state => ({
              logBaseline: {
                ...state.logBaseline,
                [room.id]: update.latest
                  ? (update.events[0]?.seq ?? 0)
                  : (state.logBaseline[room.id] ?? 0)
              },
              eventsByRoom: {
                ...state.eventsByRoom,
                [room.id]: applyLog(state.eventsByRoom[room.id] ?? [], update)
              }
            }))
          } catch (error) {
            // A failed optional log cannot suppress the roster or other logs.
            if (valid() && roomGone(error) && authority.commit(room.id, ticket, 'gone')) {
              set(state => dropRoom(state, room.id))
            }
          }
        })
      )
    } catch (error) {
      if (!currentRead()) {
        return
      }

      set({ error: error instanceof Error ? error.message : String(error), loading: false })
    }
  },

  refreshOne(id) {
    const connected = connectionRead()
    const ticket = authority.read(id)
    set({ answers: authority.outcomes() })
    let request: Promise<ReadOutcome>

    const superseded = (): ReadOutcome | Promise<ReadOutcome> => {
      if (!connected() || !authority.same(ticket)) {
        return 'discarded'
      }

      const newer = looking.get(id)

      return newer && newer !== request ? newer : authority.outcome(id)
    }

    const read = async (): Promise<ReadOutcome> => {
      try {
        const { room } = await roomsGet(id)

        if (!connected() || !authority.finish(id, ticket, 'present')) {
          return superseded()
        }

        set(state => mergeRoom(state, room))

        return 'present'
      } catch (error) {
        if (!connected() || !authority.current(id, ticket)) {
          return superseded()
        }

        if (roomGone(error)) {
          authority.finish(id, ticket, 'gone')
          set(state => dropRoom(state, id))

          return 'gone'
        }

        await get().refresh()

        return superseded()
      }
    }

    request = read().finally(() => {
      if (looking.get(id) === request) {
        looking.delete(id)
      }
    })
    looking.set(id, request)

    return request
  },

  open(id) {
    const pending = opening.get(id)

    if (pending?.current()) {
      return pending.request
    }

    const connected = connectionRead()

    const read = async (): Promise<ReadOutcome> => {
      const ticket = authority.read(id)
      set({ answers: authority.outcomes() })

      const superseded = async (): Promise<ReadOutcome> => {
        if (!connected() || !authority.same(ticket)) {
          return 'discarded'
        }

        const lookup = looking.get(id)

        if (lookup) {
          await lookup
        }

        if (!connected() || !authority.same(ticket)) {
          return 'discarded'
        }

        const outcome = authority.outcome(id)

        // Retry internally, not through the shared open promise itself.
        return outcome === 'present' ? read() : outcome
      }

      let loaded: [{ room: Room }, LogUpdate]

      try {
        loaded = await Promise.all([
          roomsGet(id),
          fetchLog(id, get().eventsByRoom[id] ?? [], get().logBaseline[id])
        ])
      } catch (error) {
        if (!connected() || !authority.current(id, ticket)) {
          return superseded()
        }

        if (!roomGone(error)) {
          throw error
        }

        authority.finish(id, ticket, 'gone')
        set(state => dropRoom(state, id))

        return 'gone'
      }

      if (!connected() || !authority.finish(id, ticket, 'present')) {
        return superseded()
      }

      const [{ room }, update] = loaded
      set(state => ({
        ...mergeRoom(state, room),
        logBaseline: {
          ...state.logBaseline,
          [id]: update.latest ? (update.events[0]?.seq ?? 0) : (state.logBaseline[id] ?? 0)
        },
        eventsByRoom: {
          ...state.eventsByRoom,
          [id]: applyLog(state.eventsByRoom[id] ?? [], update)
        }
      }))
      const seq = messageSeq(get().eventsByRoom[id] ?? [])

      if (seq) {
        void get().markRead(id, seq)
      }

      return 'present'
    }

    const request = read().finally(() => {
      if (opening.get(id)?.request === request) {
        opening.delete(id)
      }
    })

    opening.set(id, { request, current: connected })

    return request
  },

  async markRead(id, seq) {
    // Acknowledging displayed events must not supersede an existence/log read.
    const currentRead = roomRead(id)
    const ticket = authority.request()
    const roomAtRead = get().byId[id]

    try {
      const { room } = await roomsMarkRead(id, seq)

      if (!currentRead()) {
        return
      }

      set(state => {
        const current = state.byId[id]

        if (!current) {
          return state
        }

        let changed = false

        const members = current.members.map(member => {
          const marked = room.members.find(
            item => item.member_kind === member.member_kind && item.member_id === member.member_id
          )

          const read = Math.max(member.last_read_seq ?? 0, marked?.last_read_seq ?? 0)

          if (read === (member.last_read_seq ?? 0)) {
            return member
          }

          changed = true

          return { ...member, last_read_seq: read }
        })

        // The acknowledgment cannot overwrite membership, archive or turn metadata.
        return changed ? { byId: { ...state.byId, [id]: { ...current, members } } } : state
      })
    } catch (error) {
      if (!currentRead() || get().byId[id] !== roomAtRead) {
        return
      }

      // A newer room result supersedes even an earlier read mark's permission error.
      if (roomGone(error) && authority.commit(id, ticket, 'gone')) {
        set(state => dropRoom(state, id))
      }
    }
  },

  async create(input) {
    const connected = connectionRead()
    const ticket = authority.request()
    const { room } = await roomsCreate(input)

    if (!connected() || !authority.commit(room.id, ticket, 'present')) {
      return room
    }

    set(state => mergeRoom(state, room))

    return room
  },

  async addMember(id, bot) {
    const connected = connectionRead()
    const ticket = authority.request()
    const { room } = await roomsAddMember(id, bot)

    if (!connected() || !authority.commit(room.id, ticket, 'present')) {
      return
    }

    set(state => mergeRoom(state, room))
  },

  async removeMember(id, bot, keepRoom) {
    const connected = connectionRead()
    const ticket = authority.request()
    const { room } = await roomsRemoveMember(id, bot, keepRoom)

    const deleted = Boolean((room as Room & { deleted?: boolean }).deleted)

    if (!connected() || !authority.commit(id, ticket, deleted ? 'gone' : 'present')) {
      return false
    }

    if (deleted) {
      set(state => dropRoom(state, id))

      return true
    }

    set(state => mergeRoom(state, room))

    return false
  },

  drop(id) {
    authority.touch(id, 'gone')
    set(state => dropRoom(state, id))
  },

  restore(rooms, eventsByRoom, baseline) {
    // Cache is a provisional projection, never an invalidation of network reads.
    set({
      ...indexRooms(rooms),
      eventsByRoom,
      logBaseline:
        baseline ??
        Object.fromEntries(
          Object.entries(eventsByRoom)
            .filter(([, events]) => events.length)
            .map(([id, events]) => [id, events[0]!.seq])
        ),
      liveTurnsByRoom: rooms.length ? get().liveTurnsByRoom : {}
    })
  },

  async update(id, patch) {
    const connected = connectionRead()
    const ticket = authority.request()
    const { room } = await roomsUpdate(id, patch)

    if (!connected() || !authority.commit(room.id, ticket, 'present')) {
      return
    }

    set(state => mergeRoom(state, room))
  },

  async remove(id) {
    const connected = connectionRead()
    const ticket = authority.request()
    await roomsDelete(id)

    if (!connected() || !authority.commit(id, ticket, 'gone')) {
      return
    }

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
        bumpTurns(roomId)
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
    bumpTurns(turn.room_id)
    set(state => {
      const current = { ...(state.liveTurnsByRoom[turn.room_id] ?? {}) }

      if (turn.live_session_id && !['complete', 'failed', 'stopped'].includes(turn.status)) {
        current[turn.bot] = turn
        useTranscripts.getState().open(turn.live_session_id, `room:${turn.room_id}`, [])
      } else {
        const previous = current[turn.bot]

        // The turn is over; its live session may serve the next one, which
        // must not inherit cards nobody can answer any more.
        if (previous?.live_session_id) {
          useTranscripts.getState().drop(previous.live_session_id)
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
