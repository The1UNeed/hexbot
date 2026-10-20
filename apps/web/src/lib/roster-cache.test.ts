import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'

import { useBots } from '../stores/bots'
import { useMe } from '../stores/me'
import { useRooms } from '../stores/rooms'
import { useSections } from '../stores/sections'

import { cachedHistory, readCache, rememberHistory, resetDeviceCacheForTests } from './device-cache'
import { adoptDaemon, restoreRoster, stopRosterWrites } from './roster-cache'
import type { Bot, Room, Section } from './types'

const SCOPE = 'remote:daemon.test:9119'
const bot = { name: 'writer', sections_recent: [], status: 'working' } as unknown as Bot
const room = { id: 'room-1', members: [], name: 'Plans' } as unknown as Room
const section = { bot: 'writer', id: 's1', title: 'Plans' } as Section

const empty = () => {
  useBots.setState({ byName: {}, loaded: false, order: [] })
  useSections.setState({ byId: {}, cachedMessages: {}, idsByBot: {} })
  useRooms.setState({ byId: {}, eventsByRoom: {}, order: [] })
  useMe.setState({ me: null })
}

beforeEach(async () => {
  await resetDeviceCacheForTests()
  vi.stubGlobal('indexedDB', new IDBFactory())
  vi.stubGlobal('IDBKeyRange', IDBKeyRange)
  empty()
})

afterEach(() => {
  stopRosterWrites()
  vi.unstubAllGlobals()
})

describe('the roster on this device', () => {
  it('is written once the daemon is known, and drawn on the next launch', async () => {
    useBots.setState({ byName: { writer: bot }, loaded: true, order: ['writer'] })
    useSections.setState({ byId: { s1: section }, idsByBot: { writer: ['s1'] } })
    useRooms.setState({
      byId: { 'room-1': room },
      eventsByRoom: { 'room-1': [] },
      order: ['room-1']
    })
    await adoptDaemon(SCOPE, 'install-1')
    await vi.waitFor(async () => expect(await readCache(SCOPE, 'roster')).toBeTruthy())

    stopRosterWrites()
    empty()
    await restoreRoster(SCOPE)

    expect(useBots.getState().loaded).toBe(true)
    // What a bot was doing is the daemon's to say again.
    expect(useBots.getState().byName.writer?.status).toBeUndefined()
    expect(useSections.getState().idsByBot.writer).toEqual(['s1'])
    expect(useRooms.getState().order).toEqual(['room-1'])
    expect(useRooms.getState().eventsByRoom['room-1']).toEqual([])
  })

  it('never draws over what the daemon already sent', async () => {
    useBots.setState({ byName: { writer: bot }, loaded: true, order: ['writer'] })
    await adoptDaemon(SCOPE, 'install-1')
    await vi.waitFor(async () => expect(await readCache(SCOPE, 'roster')).toBeTruthy())
    stopRosterWrites()

    useBots.setState({ byName: {}, loaded: true, order: [] })
    await restoreRoster(SCOPE)
    expect(useBots.getState().order).toEqual([])
  })

  it('is cleared when another daemon answers at the same address', async () => {
    useBots.setState({ byName: { writer: bot }, loaded: true, order: ['writer'] })
    await adoptDaemon(SCOPE, 'install-1')
    await vi.waitFor(async () => expect(await readCache(SCOPE, 'roster')).toBeTruthy())
    await rememberHistory(SCOPE, 's1', { cursor: '0:1', rows: [] })
    stopRosterWrites()

    useBots.setState({ byName: {}, loaded: true, order: [] })
    await adoptDaemon(SCOPE, 'install-2')
    expect(await cachedHistory(SCOPE, 's1')).toBeUndefined()
    await vi.waitFor(async () =>
      expect(await readCache(SCOPE, 'roster')).toMatchObject({ bots: [], daemon: 'install-2' })
    )
  })
})
