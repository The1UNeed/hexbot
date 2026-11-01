/** The authorized daemon's roster and recent room logs. Never restored before auth. */
import { botCacheRead, selectBotList, useBots } from '../stores/bots'
import { useComputer } from '../stores/computer'
import { useMe } from '../stores/me'
import { usePasswords } from '../stores/passwords'
import { usePlugins } from '../stores/plugins'
import { applyLog, LOG_PAGE, recentRooms, roomCacheRead, useRooms } from '../stores/rooms'
import { sectionCacheRead, useSections } from '../stores/sections'
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
  useBots.getState().reset()
  useSections.getState().reset()
  useRooms.getState().reset()
  useMe.setState({ me: null })
  useTranscripts.getState().dropAll()
  useComputer.setState({ error: null, read: null, status: null })
  usePlugins.getState().reset()
  usePasswords.getState().reset()
}

export async function restoreRoster(scope: null | string): Promise<void> {
  const access = cacheAccess(scope)

  if (!cacheCurrent(access)) {
    return
  }

  const currentRoom = roomCacheRead()
  const currentSection = sectionCacheRead()
  const currentBot = botCacheRead()
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

  // Cache projects display rows, never network readiness or authoritative absence.
  const bots = useBots.getState()
  const restoredBots = snapshot.bots.filter(bot => currentBot(bot.name)).map(restingBot)

  if (restoredBots.length) {
    const byName = {
      ...Object.fromEntries(restoredBots.map(bot => [bot.name, bot])),
      ...bots.byName
    }

    useBots.setState({
      byName,
      order: [...new Set([...restoredBots.map(bot => bot.name), ...bots.order])]
    })
  }

  const sections = useSections.getState()

  const restoredSections = snapshot.sections
    .filter(section => currentSection(section.id))
    .map(restingSection)

  if (restoredSections.length) {
    sections.restore(restoredSections)
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

    const bots = useBots.getState()
    const sections = useSections.getState()

    const snapshotCurrent = () =>
      current() &&
      useBots.getState().byName === bots.byName &&
      useSections.getState().byId === sections.byId

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
      snapshotCurrent
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
