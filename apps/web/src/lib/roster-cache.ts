/**
 * The roster on this device: bots, sections, rooms, room logs and you, kept
 * per daemon in the device cache. `restoreRoster` draws it before the daemon
 * answers; `adoptDaemon` checks that it belongs to the daemon that did, and
 * from then on every change is written back.
 */

import { selectBotList, useBots } from '../stores/bots'
import { useMe } from '../stores/me'
import { useRooms } from '../stores/rooms'
import { useSections } from '../stores/sections'

import { clearCache, deleteCache, readCache, writeCache } from './device-cache'
import type { Bot, CurrentUser, Room, RoomEvent, Section } from './types'

interface RosterSnapshot {
  bots: Bot[]
  /** install_id of the daemon this is from. */
  daemon: string
  me: CurrentUser | null
  rooms: Room[]
  sections: Section[]
}

const SNAPSHOT_KEY = 'roster'
const WRITE_DELAY_MS = 500

/** What a bot is doing now is the daemon's to say; a cached spinner would be a stale label. */
const resting = (bot: Bot): Bot => ({ ...bot, status: undefined, status_detail: undefined })

/** The daemon whose roster is in the stores, drawn from the cache or sent by it. */
let shown: null | string = null

/** Bumped by each restore and drop; a restore that is no longer the latest draws nothing. */
let generation = 0

/** Fill the stores from the cache, where the daemon has not already. */
export async function restoreRoster(scope: null | string): Promise<void> {
  const mine = ++generation
  const snapshot = await readCache<RosterSnapshot>(scope, SNAPSHOT_KEY)

  if (!snapshot || mine !== generation) {
    return
  }

  // A roster already in the stores belongs to the daemon it came from.
  shown ??= snapshot.daemon

  if (!useBots.getState().loaded) {
    useBots.setState({
      byName: Object.fromEntries(snapshot.bots.map(bot => [bot.name, resting(bot)])),
      loaded: true,
      order: snapshot.bots.map(bot => bot.name)
    })
  }

  if (!Object.keys(useSections.getState().byId).length) {
    useSections.getState().restore(snapshot.sections)
  }

  if (!useMe.getState().me) {
    useMe.setState({ me: snapshot.me })
  }

  if (!useRooms.getState().order.length) {
    const logs = await Promise.all(
      snapshot.rooms.map(room => readCache<RoomEvent[]>(scope, `room:${room.id}`))
    )

    if (mine === generation && !useRooms.getState().order.length) {
      useRooms
        .getState()
        .restore(
          snapshot.rooms,
          Object.fromEntries(snapshot.rooms.map((room, index) => [room.id, logs[index] ?? []]))
        )
    }
  }
}

/**
 * The daemon answering is `daemon`. If the roster on screen came from another
 * one, empty the stores, so what a failed refresh left of it is never shown
 * or written as this daemon's. Returns whether it did.
 */
export function dropForeignRoster(daemon: null | string | undefined): boolean {
  const foreign = Boolean(shown && daemon && shown !== daemon)
  shown = daemon ?? shown
  generation += 1

  if (foreign) {
    useBots.setState({ byName: {}, loaded: false, order: [] })
    useSections.setState({ byId: {}, cachedMessages: {}, idsByBot: {}, liveSessionId: {} })
    useRooms.getState().restore([], {})
    useMe.setState({ me: null })
  }

  return foreign
}

let stopWriting: (() => void) | null = null

/**
 * The daemon at `scope` is `daemon`: keep what is cached if it is the same one,
 * else clear it, and write every change from now on.
 */
export async function adoptDaemon(
  scope: null | string,
  daemon: null | string | undefined
): Promise<void> {
  stopWriting?.()
  stopWriting = null

  if (!scope || !daemon) {
    return
  }

  const snapshot = await readCache<RosterSnapshot>(scope, SNAPSHOT_KEY)

  const same = snapshot?.daemon === daemon

  if (snapshot && !same) {
    await clearCache(scope)
  }

  stopWriting = writeChanges(scope, daemon, same ? snapshot.rooms.map(room => room.id) : [])
}

/** Stop writing, as the page moves to another daemon. */
export function stopRosterWrites(): void {
  stopWriting?.()
  stopWriting = null
}

function writeChanges(scope: string, daemon: string, cachedRooms: string[]): () => void {
  let timer: null | ReturnType<typeof setTimeout> = null
  // The log last written per room; a cached room the daemon no longer lists is deleted.
  const written = new Map<string, null | RoomEvent[]>(cachedRooms.map(id => [id, null]))

  const write = () => {
    timer = null
    const rooms = useRooms.getState()

    void writeCache(scope, SNAPSHOT_KEY, {
      bots: selectBotList(useBots.getState()),
      daemon,
      me: useMe.getState().me,
      rooms: rooms.order.map(id => rooms.byId[id]).filter((room): room is Room => Boolean(room)),
      sections: Object.values(useSections.getState().byId)
    } satisfies RosterSnapshot)

    // Only the logs that changed; a room log can be long.
    for (const [id, events] of Object.entries(rooms.eventsByRoom)) {
      if (written.get(id) !== events) {
        written.set(id, events)
        void writeCache(scope, `room:${id}`, events)
      }
    }

    for (const id of written.keys()) {
      if (!(id in rooms.eventsByRoom)) {
        written.delete(id)
        void deleteCache(scope, `room:${id}`)
      }
    }
  }

  const schedule = () => {
    timer ??= setTimeout(write, WRITE_DELAY_MS)
  }

  const stops = [
    useBots.subscribe(schedule),
    useSections.subscribe(schedule),
    useRooms.subscribe(schedule),
    useMe.subscribe(schedule)
  ]

  schedule()

  return () => {
    for (const stop of stops) {
      stop()
    }

    if (timer) {
      clearTimeout(timer)
    }
  }
}
