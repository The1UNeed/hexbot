/** The authorized daemon's roster and recent room logs. Never restored before auth. */
import { selectBotList, useBots } from '../stores/bots'
import { useMe } from '../stores/me'
import { applyLog, LOG_PAGE, recentRooms, roomCacheRead, useRooms } from '../stores/rooms'
import { useSections } from '../stores/sections'
import { useTranscripts } from '../stores/transcripts'

import {
  boundedHistory,
  cacheAccess,
  cacheCurrent,
  pruneRoomLogs,
  readCache,
  writeCache
} from './device-cache'
import type { Bot, CurrentUser, Room, RoomEvent, Section } from './types'

interface RosterSnapshot {
  bots: Bot[]
  daemon: string
  me: CurrentUser | null
  rooms: Room[]
  sections: Section[]
}
const SNAPSHOT_KEY = 'roster'
let stopWriting: (() => void) | null = null

/** Process-scoped IDs and activity never survive a restart. */
const restingSection = (section: Section): Section => ({ ...section, live_session_id: null })

const restingBot = (bot: Bot): Bot => ({
  ...bot,
  status: undefined,
  status_detail: undefined,
  sections_recent: bot.sections_recent?.map(restingSection)
})

const restingRoom = (room: Room): Room => ({ ...room, turns: [] })

export function clearPersonalState(): void {
  useBots.setState({ byName: {}, loaded: false, order: [], loading: false, error: null })
  useSections.getState().clearLive()
  useSections.setState({
    byId: {},
    cachedMessages: {},
    idsByBot: {},
    sendingTitles: {},
    loading: false,
    error: null
  })
  useRooms.getState().reset()
  useMe.setState({ me: null })
  useTranscripts.getState().dropAll()
}

export async function restoreRoster(scope: null | string): Promise<void> {
  const access = cacheAccess(scope)

  if (!cacheCurrent(access)) {
    return
  }

  const currentRoom = roomCacheRead()
  const snapshot = await readCache<RosterSnapshot>(scope, SNAPSHOT_KEY)

  if (!cacheCurrent(access) || !snapshot || snapshot.daemon !== access?.daemon) {
    return
  }

  const recent = recentRooms(snapshot.rooms)

  const logs = await Promise.all(
    recent.map(room => readCache<RoomEvent[]>(scope, `room:${room.id}`))
  )

  if (!cacheCurrent(access)) {
    return
  }

  // Only fill empty stores. A current live response always wins.
  if (!useBots.getState().loaded) {
    const bots = snapshot.bots.map(restingBot)
    useBots.setState({
      byName: Object.fromEntries(bots.map(bot => [bot.name, bot])),
      loaded: true,
      order: bots.map(bot => bot.name)
    })
  }

  if (!Object.keys(useSections.getState().byId).length) {
    useSections.getState().restore(snapshot.sections.map(restingSection))
  }

  if (!useMe.getState().me) {
    useMe.setState({ me: snapshot.me })
  }

  const rooms = useRooms.getState()
  const restored = snapshot.rooms.filter(room => currentRoom(room.id))
  const restoredIds = new Set(restored.map(room => room.id))

  if (restored.length) {
    rooms.restore(
      [
        ...new Map(
          [...restored.map(restingRoom), ...Object.values(rooms.byId)].map(room => [room.id, room])
        ).values()
      ],
      {
        ...rooms.eventsByRoom,
        ...Object.fromEntries(
          recent.flatMap((room, i) =>
            restoredIds.has(room.id)
              ? [
                  [
                    room.id,
                    applyLog(logs[i] ?? [], {
                      events: rooms.eventsByRoom[room.id] ?? [],
                      latest: false
                    })
                  ]
                ]
              : []
          )
        )
      },
      {
        ...Object.fromEntries(
          recent.flatMap((room, i) =>
            restoredIds.has(room.id) && logs[i]?.length ? [[room.id, logs[i]![0]!.seq]] : []
          )
        ),
        ...rooms.logBaseline
      }
    )
  }

  await useSections.getState().restoreHistory()
}

export function stopRosterWrites(): void {
  stopWriting?.()
  stopWriting = null
}

/** Subscribe after authorization. Persist rooms only once their network list is ready. */
export function keepRoster(scope: null | string): void {
  stopRosterWrites()
  const access = cacheAccess(scope)

  if (!access) {
    return
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  const written = new Map<string, RoomEvent[]>()

  const write = () => {
    timer = undefined

    if (!cacheCurrent(access)) {
      return
    }

    const rooms = useRooms.getState()

    if (!rooms.loaded) {
      return
    }

    const current = () =>
      cacheCurrent(access) && useRooms.getState().byId === rooms.byId && useRooms.getState().loaded

    void writeCache(
      scope,
      SNAPSHOT_KEY,
      {
        bots: selectBotList(useBots.getState()).map(restingBot),
        daemon: access.daemon,
        me: useMe.getState().me,
        rooms: rooms.order
          .map(id => rooms.byId[id])
          .filter((room): room is Room => Boolean(room))
          .map(restingRoom),
        sections: Object.values(useSections.getState().byId).map(restingSection)
      } satisfies RosterSnapshot,
      current
    )

    const kept = recentRooms(Object.values(rooms.byId)).map(room => room.id)

    for (const id of kept) {
      const events = rooms.eventsByRoom[id]

      if (events && written.get(id) !== events && rooms.logBaseline[id] !== undefined) {
        const currentLog = () => current() && useRooms.getState().eventsByRoom[id] === events
        // Persist only the verified contiguous tail, never a lone live event.
        const start = rooms.logBaseline[id]!
        const verified = start > 0 ? events.filter(event => event.seq >= start) : []

        const gap = verified.findIndex(
          (event, i) => i > 0 && event.seq !== verified[i - 1]!.seq + 1
        )

        void writeCache(
          scope,
          `room:${id}`,
          boundedHistory((gap < 0 ? verified : verified.slice(0, gap)).slice(-LOG_PAGE)),
          currentLog
        ).then(() => {
          if (currentLog()) {
            written.set(id, events)
          }
        })
      }
    }

    for (const id of written.keys()) {
      if (!kept.includes(id)) {
        written.delete(id)
      }
    }

    void pruneRoomLogs(scope, kept, current)
  }

  const schedule = () => {
    timer ??= setTimeout(write, 500)
  }

  const stops = [
    useBots.subscribe(schedule),
    useSections.subscribe(schedule),
    useRooms.subscribe(schedule),
    useMe.subscribe(schedule)
  ]

  schedule()

  stopWriting = () => {
    for (const stop of stops) {
      stop()
    }

    if (timer) {
      clearTimeout(timer)
    }
  }
}
