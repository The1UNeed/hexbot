import { IDBDatabase, IDBFactory, IDBKeyRange } from 'fake-indexeddb'

import type * as api from '../lib/api'
import {
  messagesFromHistory,
  roomsGet,
  roomsList,
  roomsLog,
  roomsMarkRead,
  sectionsList,
  sectionsOpen,
  sessionHistory
} from '../lib/api'
import { KICKOFF_MARKER } from '../lib/bot-kickoff'
import { ConnectionSupervisor } from '../lib/connection'
import * as deviceCache from '../lib/device-cache'
import {
  authorizeCache,
  boundedHistory,
  cacheAccess,
  CACHED_SECTIONS,
  cachedHistory,
  forgetHistory,
  HISTORY_BYTES,
  HISTORY_ROWS,
  pruneRoomLogs,
  readCache,
  rememberHistory,
  resetDeviceCacheForTests,
  revokeCache,
  suspendCache,
  syncHistory,
  writeCache
} from '../lib/device-cache'
import { routeEvent } from '../lib/events'
import {
  clearPersonalState,
  keepRoster,
  restoreRoster,
  stopRosterWrites
} from '../lib/roster-cache'
import type { Bot, DaemonInfo, Room, RoomEvent, Section } from '../lib/types'

import { useBots } from './bots'
import { invalidateConnectionReads, useConnection } from './connection'
import { useMe } from './me'
import { applyLog, useRooms } from './rooms'
import { keepHistory, useSections } from './sections'
import { useSettings } from './settings'
import { resetTranscriptEffects, setTranscriptEffects, useTranscripts } from './transcripts'

vi.mock('../lib/api', async original => ({
  ...(await original<typeof api>()),
  roomsGet: vi.fn(),
  roomsList: vi.fn(),
  roomsLog: vi.fn(),
  roomsMarkRead: vi.fn(),
  sectionsList: vi.fn(),
  sectionsOpen: vi.fn(),
  sessionHistory: vi.fn()
}))
const scope = 'remote:cache.test:9119'
const row = (text: string) => ({ role: 'user', row_id: text, text })
const section = { id: 's', bot: 'writer', live_session_id: 'live' } as Section
const room = { id: 'r', members: [], name: 'Test' } as unknown as Room

const event = (seq: number): RoomEvent => ({
  room_id: 'r',
  seq,
  kind: 'message.bot',
  actor_id: 'writer',
  actor_kind: 'bot',
  payload: { text: `event ${seq}` },
  created_at: 1
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void

  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })

  return { promise, resolve, reject }
}

beforeEach(async () => {
  await resetDeviceCacheForTests()
  vi.stubGlobal('indexedDB', new IDBFactory())
  vi.stubGlobal('IDBKeyRange', IDBKeyRange)
  useConnection.setState({
    target: { kind: 'remote', host: 'cache.test', port: 9119, tls: false, deviceToken: 'test' },
    epoch: 'epoch',
    daemon: { install_id: 'daemon', transcript_identity: true } as DaemonInfo
  })
  clearPersonalState()
  await authorizeCache(scope, 'daemon', () => true)
  setTranscriptEffects({ ackApproval: vi.fn(), notify: vi.fn(), touchSection: vi.fn() })
  vi.resetAllMocks()
})
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  stopRosterWrites()
  resetTranscriptEffects()
  await resetDeviceCacheForTests()
  vi.unstubAllGlobals()
})

it.each([true, false])(
  'preserves a repeated prompt submitted during history loading (durable identity=%s)',
  async identified => {
    const held = deferred<Awaited<ReturnType<typeof sectionsOpen>>>()
    vi.mocked(sectionsOpen).mockReturnValueOnce(held.promise)
    const pending = useSections.getState().open('s')
    await vi.waitFor(() => expect(sectionsOpen).toHaveBeenCalledOnce())
    const actions = useTranscripts.getState()
    const input = actions.appendUserMessage('live', 'Continue')
    actions.eventIdentity('live', { turnId: 'new-turn', messageId: 'new-answer' })
    actions.messageDelta('live', 'Second reply')
    held.resolve({
      section,
      busy: true,
      messages: [
        { ...row('Continue'), ...(identified ? { input_id: 'old-input' } : {}) },
        { role: 'assistant', row_id: 'first-answer', text: 'First reply' }
      ]
    })
    await pending
    expect(useTranscripts.getState().bySession.live?.messages.map(message => message.text)).toEqual(
      ['Continue', 'First reply', 'Continue', 'Second reply']
    )
    // A subsequent durable row adopts that exact submission once.
    actions.open(
      'live',
      's',
      messagesFromHistory([
        { ...row('Continue'), input_id: 'old-input' },
        { role: 'assistant', row_id: 'first-answer', text: 'First reply' },
        { ...row('Continue'), row_id: 'second-input', input_id: input.inputId }
      ]),
      { reports: [] }
    )
    expect(
      useTranscripts.getState().bySession.live?.messages.filter(message => message.role === 'user')
    ).toHaveLength(2)
  }
)

it('fetches a latest room page after a first live event, then resumes only a verified baseline', async () => {
  useRooms.getState().handleEvent('r', event(200))
  vi.mocked(roomsGet).mockResolvedValue({ room })
  vi.mocked(roomsMarkRead).mockResolvedValue({ room })
  vi.mocked(roomsLog).mockResolvedValueOnce({ events: [event(198), event(199), event(200)] })
  await useRooms.getState().open('r')
  expect(roomsLog).toHaveBeenCalledWith('r', { before_seq: Number.MAX_SAFE_INTEGER, limit: 1000 })
  expect(useRooms.getState().eventsByRoom.r?.map(e => e.seq)).toEqual([198, 199, 200])
  useRooms.getState().handleEvent('r', event(202))
  vi.mocked(roomsLog).mockResolvedValueOnce({ events: [event(201), event(202)] })
  await useRooms.getState().open('r')
  expect(roomsLog).toHaveBeenLastCalledWith('r', { after_seq: 200, limit: 1000 })
  expect(useRooms.getState().eventsByRoom.r?.map(e => e.seq)).toEqual([198, 199, 200, 201, 202])
})

it('serializes a slow open and background sync across the entire fetch and commit', async () => {
  await rememberHistory(scope, 's', { rows: [row('one')] })
  const held = deferred<Awaited<ReturnType<typeof sectionsOpen>>>()
  vi.mocked(sectionsOpen).mockReturnValueOnce(held.promise)
  const pending = useSections.getState().open('s')
  await vi.waitFor(() => expect(sectionsOpen).toHaveBeenCalledOnce())
  vi.mocked(sessionHistory).mockResolvedValueOnce({
    messages: [row('one'), row('two'), row('three')]
  })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  keepHistory('s', 'live')
  await vi.advanceTimersByTimeAsync(2000)
  expect(sessionHistory).not.toHaveBeenCalled()
  held.resolve({ section, messages: [row('one'), row('two')] })
  await pending
  vi.useRealTimers()
  await vi.waitFor(async () =>
    expect((await cachedHistory(scope, 's'))?.rows).toEqual([row('one'), row('two'), row('three')])
  )
})

it('does not read or restore personal data before a new authorization', async () => {
  await writeCache(scope, 'roster', {
    daemon: 'daemon',
    bots: [{ name: 'private' }],
    me: { display_name: 'Private' },
    rooms: [],
    sections: [section]
  })
  await rememberHistory(scope, 's', { rows: [row('secret')] })
  suspendCache()
  clearPersonalState()
  await restoreRoster(scope)
  expect(useBots.getState().order).toEqual([])
  expect(useMe.getState().me).toBeNull()
  expect(await cachedHistory(scope, 's')).toBeUndefined()
  await authorizeCache(scope, 'daemon', () => true)
  await restoreRoster(scope)
  expect(useBots.getState().order).toEqual(['private'])
  expect(useSections.getState().byId.s?.live_session_id).toBeNull()
  expect(useSections.getState().liveSessionId).toEqual({})
})

it('fills an open started by canonical lookup before cache authorization finishes', async () => {
  await writeCache(scope, 'roster', {
    daemon: 'daemon',
    bots: [],
    me: null,
    rooms: [],
    sections: [section]
  })
  await rememberHistory(scope, 's', { rows: [row('kept before authorization')] })
  suspendCache()
  clearPersonalState()
  const held = deferred<Awaited<ReturnType<typeof sectionsOpen>>>()
  vi.mocked(sectionsOpen).mockReturnValueOnce(held.promise)
  const pending = useSections.getState().open('s')
  expect(sectionsOpen).toHaveBeenCalledOnce()
  expect(useSections.getState().cachedMessages.s).toBeUndefined()
  await authorizeCache(scope, 'daemon', () => true)
  await restoreRoster(scope)
  expect(useSections.getState().cachedMessages.s?.[0]?.text).toBe('kept before authorization')
  held.resolve({ section, messages: [row('fresh snapshot')] })
  await pending
  expect((await cachedHistory(scope, 's'))?.rows).toEqual([row('fresh snapshot')])
})

it('keeps a live event arriving while an empty latest-page read is in flight', () => {
  expect(applyLog([event(200)], { events: [], latest: true })).toEqual([event(200)])
})

it.each(['open', 'restoreHistory'] as const)(
  'hides an interrupted kickoff in %s while network history is pending',
  async source => {
    const rows = [row(`${KICKOFF_MARKER} Writer. Internal instructions.`), row('Visible prompt')]
    await rememberHistory(scope, 's', { rows })
    const held = deferred<Awaited<ReturnType<typeof sectionsOpen>>>()
    vi.mocked(sectionsOpen).mockReturnValueOnce(held.promise)

    if (source === 'restoreHistory') {
      suspendCache()
    }

    const pending = useSections.getState().open('s')
    await vi.waitFor(() => expect(sectionsOpen).toHaveBeenCalledOnce())

    if (source === 'restoreHistory') {
      await authorizeCache(scope, 'daemon', () => true)
      await useSections.getState().restoreHistory()
    }

    expect(useSections.getState().cachedMessages.s?.map(message => message.text)).toEqual([
      'Visible prompt'
    ])
    held.resolve({ section, messages: rows })
    await pending
    expect(useTranscripts.getState().bySession.live?.messages.map(message => message.text)).toEqual(
      ['Visible prompt']
    )
  }
)

it.each(['deleted', 'left', 'archived'] as const)(
  'prunes a %s room log from a prior run after the fresh roster replaces the restored one',
  async change => {
    await writeCache(scope, 'roster', {
      daemon: 'daemon',
      bots: [],
      me: null,
      rooms: [room],
      sections: []
    })
    await writeCache(scope, 'room:r', [event(1)])
    // Repair an orphan left by a previous version too, even without a roster row.
    await writeCache(scope, 'room:orphan', [event(2)])
    suspendCache()
    clearPersonalState()
    await authorizeCache(scope, 'daemon', () => true)
    await restoreRoster(scope)
    expect(useRooms.getState().eventsByRoom.r).toHaveLength(1)
    // This is the state after rooms.refresh, before keepRoster subscribes.
    useRooms.setState({ loaded: true })
    useRooms.getState().restore(change === 'archived' ? [{ ...room, archived_at: 1 }] : [], {})
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    keepRoster(scope)
    await vi.advanceTimersByTimeAsync(500)
    vi.useRealTimers()
    await vi.waitFor(async () => {
      expect(await readCache(scope, 'room:r')).toBeUndefined()
      expect(await readCache(scope, 'room:orphan')).toBeUndefined()
    })
  }
)

it('does not let an old connection prune room logs under the next authorization', async () => {
  await writeCache(scope, 'room:r', [event(1)])
  const pruning = pruneRoomLogs(scope, [])
  const authorizing = authorizeCache(scope, 'daemon', () => true)
  await Promise.all([pruning, authorizing])
  expect(await readCache(scope, 'room:r')).toEqual([event(1)])
  await writeCache(scope, 'room:other', [event(2)])
  await pruneRoomLogs(scope, ['r'])
  expect(await readCache(scope, 'room:r')).toEqual([event(1)])
  expect(await readCache(scope, 'room:other')).toBeUndefined()
})

it('an empty verified room cannot turn a later lone event into a restored baseline', async () => {
  vi.mocked(roomsGet).mockResolvedValue({ room })
  vi.mocked(roomsMarkRead).mockResolvedValue({ room })
  vi.mocked(roomsLog).mockResolvedValue({ events: [] })
  await useRooms.getState().open('r')
  useRooms.getState().handleEvent('r', event(200))
  useRooms.setState({ loaded: true })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  keepRoster(scope)
  await vi.advanceTimersByTimeAsync(500)
  vi.useRealTimers()
  await vi.waitFor(async () => expect(await readCache(scope, 'room:r')).toEqual([]))
  await useRooms.getState().open('r')
  expect(roomsLog).toHaveBeenLastCalledWith('r', {
    before_seq: Number.MAX_SAFE_INTEGER,
    limit: 1000
  })
})

it('revocation deletes data and rejects queued writes and a late history fetch', async () => {
  await rememberHistory(scope, 's', { rows: [row('secret')] })
  const held = deferred<Awaited<ReturnType<typeof sectionsOpen>>>()
  vi.mocked(sectionsOpen).mockReturnValueOnce(held.promise)
  const pending = useSections.getState().open('s')
  await vi.waitFor(() => expect(sectionsOpen).toHaveBeenCalledOnce())
  const queued = rememberHistory(scope, 'queued', { rows: [row('queued secret')] })
  invalidateConnectionReads()
  const revoked = revokeCache(scope)
  clearPersonalState()
  held.resolve({ section, messages: [row('late secret')] })
  await expect(pending).rejects.toThrow('selected daemon changed')
  await Promise.all([queued, revoked])
  await authorizeCache(scope, 'daemon', () => true)
  expect(await cachedHistory(scope, 's')).toBeUndefined()
  expect(await cachedHistory(scope, 'queued')).toBeUndefined()
  expect(useSections.getState().byId).toEqual({})
})

it('rejects an authorization finishing after teardown and a different installation', async () => {
  await rememberHistory(scope, 's', { rows: [row('secret')] })
  const pending = authorizeCache(scope, 'daemon', () => true)
  suspendCache()
  expect(await pending).toBe(false)
  expect(cacheAccess()).toBeNull()
  await authorizeCache(scope, 'replacement', () => true)
  expect(await cachedHistory(scope, 's')).toBeUndefined()
})

it('bounds forever-chat histories by rows and UTF-8 bytes and evicts forgotten IDs', async () => {
  const rows = Array.from({ length: HISTORY_ROWS + 10 }, (_, i) => row(String(i)))
  await rememberHistory(scope, 's', { rows })
  expect((await cachedHistory(scope, 's'))?.rows).toEqual(rows.slice(-HISTORY_ROWS))
  const huge = Array.from({ length: 30 }, (_, i) => row(`${i} ${'字'.repeat(30_000)}`))
  const bounded = boundedHistory(huge)
  expect(new TextEncoder().encode(JSON.stringify(bounded)).length).toBeLessThanOrEqual(
    HISTORY_BYTES
  )
  expect(bounded.at(-1)).toEqual(huge.at(-1))
  expect(boundedHistory([row('x'.repeat(HISTORY_BYTES + 1))])).toEqual([])

  for (let i = 0; i < CACHED_SECTIONS; i++) {
    await rememberHistory(scope, String(i), { rows: [row(String(i))] })
  }

  expect(await cachedHistory(scope, 's')).toBeUndefined()
  await forgetHistory(scope, '1')
  expect(await readCache(scope, 'sections:recent')).not.toContain('1')
})

it('persists only verified room history and strips process IDs from the whole roster', async () => {
  useBots.setState({
    order: ['writer'],
    byName: { writer: { name: 'writer', sections_recent: [section], status: 'working' } as Bot }
  })
  useSections.setState({ byId: { s: section } })
  useRooms.getState().restore([room], {})
  useRooms.getState().handleEvent('r', event(200))
  useRooms.setState({ loaded: true })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  keepRoster(scope)
  await vi.advanceTimersByTimeAsync(500)
  vi.useRealTimers()
  await vi.waitFor(async () => expect(await readCache(scope, 'roster')).toBeDefined())
  expect(await readCache(scope, 'room:r')).toBeUndefined()
  const snapshot = await readCache<{ sections: Section[]; bots: Bot[] }>(scope, 'roster')
  expect(snapshot?.sections[0]?.live_session_id).toBeNull()
  expect(snapshot?.bots[0]?.sections_recent?.[0]?.live_session_id).toBeNull()
  expect(snapshot?.bots[0]?.status).toBeUndefined()
})

it('bounds startup room log fetches, restores and persisted entries across a large roster', async () => {
  const rooms = Array.from({ length: 45 }, (_, i) => ({
    ...room,
    id: `r${i}`,
    last_activity_at: i,
    updated_at: i
  }))

  await writeCache(scope, 'roster', { daemon: 'daemon', bots: [], me: null, sections: [], rooms })

  for (const room of rooms) {
    await writeCache(scope, `room:${room.id}`, [{ ...event(1), room_id: room.id }])
  }

  await restoreRoster(scope)
  expect(Object.keys(useRooms.getState().eventsByRoom)).toHaveLength(20)
  expect(Object.keys(useRooms.getState().logBaseline)).toHaveLength(20)

  vi.mocked(roomsList).mockResolvedValue({ rooms })
  vi.mocked(roomsLog).mockImplementation(async id => ({ events: [{ ...event(1), room_id: id }] }))
  await useRooms.getState().refresh()
  expect(useRooms.getState().order).toHaveLength(45)
  expect(roomsLog).toHaveBeenCalledTimes(20)
  expect(vi.mocked(roomsLog).mock.calls.map(([id]) => id)).toEqual(
    rooms
      .slice(-20)
      .reverse()
      .map(room => room.id)
  )

  // Repair old, unbounded caches and skip logs outside the recent set.

  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  keepRoster(scope)
  await vi.advanceTimersByTimeAsync(500)
  vi.useRealTimers()
  await vi.waitFor(async () => expect(await readCache(scope, 'room:r0')).toBeUndefined())
  stopRosterWrites()
  clearPersonalState()
  await restoreRoster(scope)
  expect(useRooms.getState().order).toHaveLength(45)
  expect(
    Object.values(useRooms.getState().eventsByRoom).filter(events => events.length)
  ).toHaveLength(20)
  expect(Object.keys(useRooms.getState().logBaseline)).toHaveLength(20)
  // An older room remains navigable and obtains its own verified baseline on demand.
  vi.mocked(roomsGet).mockResolvedValueOnce({ room: rooms[0]! })
  vi.mocked(roomsMarkRead).mockResolvedValueOnce({ room: rooms[0]! })
  await useRooms.getState().open('r0')
  expect(roomsLog).toHaveBeenLastCalledWith('r0', {
    before_seq: Number.MAX_SAFE_INTEGER,
    limit: 1000
  })
  expect(useRooms.getState().eventsByRoom.r0).toHaveLength(1)
  expect(useRooms.getState().logBaseline.r0).toBe(1)
})

it.each([
  ['commit', 'terminal'],
  ['recency read', 'terminal'],
  ['queued write', 'terminal'],
  ['commit', 'reload'],
  ['recency read', 'reload'],
  ['queued write', 'reload']
] as const)('rereads a snapshot invalidated during its %s by a %s', async (phase, reason) => {
  useSections.setState({ byId: { s: section }, liveSessionId: { s: 'live' } })
  useTranscripts.getState().open('live', 's', [])

  const send = (type: string, text?: string) =>
    routeEvent({
      type,
      session_id: 'live',
      payload: { turn_id: 'turn', message_id: 'answer', text, status: 'complete' }
    } as never)

  send('message.start')
  send('message.delta', 'Partial')
  const transact = IDBDatabase.prototype.transaction
  let terminalSent = false
  let readonly = 0

  const spy = vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (
    this: IDBDatabase,
    ...args
  ) {
    const tx = transact.apply(this, args)

    if (args[1] === 'readonly') {
      readonly++
    }

    const trigger = phase === 'recency read' ? readonly === 2 : args[1] === 'readwrite'

    if (!terminalSent && trigger) {
      tx.addEventListener(
        'complete',
        () => {
          terminalSent = true

          if (reason === 'terminal') {
            send('message.complete', 'Final answer')
            expect(useTranscripts.getState().bySession.live?.messages.at(-1)?.text).toBe(
              'Final answer'
            )
          } else {
            useSections.getState().forgetLive('s')
          }
        },
        { once: true }
      )
    }

    return tx
  })

  if (phase === 'queued write') {
    const remember = deviceCache.rememberHistory
    vi.spyOn(deviceCache, 'rememberHistory').mockImplementationOnce((...args) => {
      // Put a real transaction ahead of the snapshot on the global write queue.
      void writeCache(scope, 'blocker', true)

      return remember(...args)
    })
  }

  vi.mocked(sectionsOpen).mockResolvedValueOnce({
    section,
    busy: true,
    messages: [row('question')]
  })
  vi.mocked(sectionsOpen).mockImplementationOnce(async () => {
    if (phase !== 'commit') {
      // Invalidation before the write transaction must skip the old snapshot entirely.
      expect(await cachedHistory(scope, 's')).toBeUndefined()
      expect(await readCache(scope, 'sections:recent')).toBeUndefined()
    }

    return {
      section,
      busy: false,
      messages: [
        row('question'),
        {
          role: 'assistant',
          row_id: 'answer',
          turn_id: 'turn',
          text: 'Final answer'
        }
      ]
    }
  })
  await useSections.getState().open('s')
  spy.mockRestore()
  expect(terminalSent).toBe(true)
  expect(sectionsOpen).toHaveBeenCalledTimes(2)
  expect(useTranscripts.getState().bySession.live?.messages.map(m => m.text)).toEqual([
    'question',
    'Final answer'
  ])
  expect((await cachedHistory<api.HistoryRow>(scope, 's'))?.rows.at(-1)?.text).toBe('Final answer')
})

it.each(['fetch', 'queued write', 'open'] as const)(
  'does not resurrect a removed section from a late %s, even if listed again',
  async phase => {
    await rememberHistory(scope, 's', { rows: [row('private deleted chat')] })
    useSections.setState({ byId: { s: section } })
    const held = deferred<Awaited<ReturnType<typeof sessionHistory>>>()
    const commit = deferred<void>()
    const reachedCommit = deferred<void>()
    const remember = deviceCache.rememberHistory

    if (phase === 'queued write') {
      vi.spyOn(deviceCache, 'rememberHistory').mockImplementationOnce(async (...args) => {
        reachedCommit.resolve()
        await commit.promise
        await remember(...args)
      })
    }

    let pending: Promise<unknown> | undefined

    if (phase === 'open') {
      vi.mocked(sectionsOpen).mockImplementationOnce(async () => {
        await held.promise

        return { section, messages: [row('private deleted chat')] }
      })
      pending = useSections.getState().open('s')
      void pending.catch(() => undefined)
      await vi.waitFor(() => expect(sectionsOpen).toHaveBeenCalledOnce())
    } else {
      vi.mocked(sessionHistory).mockReturnValueOnce(held.promise)
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      keepHistory('s', 'live')
      await vi.advanceTimersByTimeAsync(2000)
      vi.useRealTimers()
      await vi.waitFor(() => expect(sessionHistory).toHaveBeenCalledOnce())
    }

    if (phase === 'queued write') {
      held.resolve({ messages: [row('private deleted chat')] })
      await reachedCommit.promise
    }

    vi.mocked(sectionsList).mockResolvedValueOnce({ sections: [] })
    await useSections.getState().refresh()
    // Wait for the deletion, then make sure membership alone cannot revalidate old work.
    await forgetHistory(scope, 's')
    expect(await cachedHistory(scope, 's')).toBeUndefined()
    vi.mocked(sectionsList).mockResolvedValueOnce({ sections: [section] })
    await useSections.getState().refresh()
    held.resolve({ messages: [row('private deleted chat')] })
    commit.resolve()

    if (pending) {
      await expect(pending).rejects.toThrow()
    }

    // Join the complete serialized fetch/commit, including a skipped write.
    await syncHistory(cacheAccess(), 's', async () => {})
    expect(await cachedHistory(scope, 's')).toBeUndefined()
    expect(await readCache(scope, 'sections:recent')).not.toContain('s')
    expect(useSections.getState().liveSessionId.s).toBeUndefined()
    expect(useTranscripts.getState().bySession.live).toBeUndefined()
  }
)

it.each([4230, 4302, 5000])(
  'publishes the roster and other logs despite an optional log error %s',
  async code => {
    const removed = { ...room, id: 'removed-offline' }
    const failed = { ...room, id: 'failed' }
    const survivor = { ...room, id: 'survivor' }
    useRooms.getState().restore([removed, survivor], { 'removed-offline': [event(1)] })
    vi.mocked(roomsList).mockResolvedValue({ rooms: [survivor, failed] })
    vi.mocked(roomsLog).mockImplementation(async id => {
      if (id === 'failed') {
        throw Object.assign(new Error('Log unavailable'), { code })
      }

      return { events: [{ ...event(1), room_id: id }] }
    })
    await useRooms.getState().refresh()
    expect(useRooms.getState().order).not.toContain('removed-offline')
    expect(useRooms.getState().eventsByRoom['removed-offline']).toBeUndefined()
    expect(useRooms.getState().eventsByRoom.survivor).toHaveLength(1)
    expect(useRooms.getState().logBaseline.survivor).toBe(1)
    expect(useRooms.getState().error).toBeNull()
    expect(Boolean(useRooms.getState().byId.failed)).toBe(code === 5000)
  }
)

it('publishes newly discovered rooms and ready logs while another log is held', async () => {
  const slow = { ...room, id: 'slow', last_activity_at: 5 }
  const unseen = { ...room, id: 'unseen', last_activity_at: 1 }
  const held = deferred<{ events: RoomEvent[] }>()
  vi.mocked(roomsList).mockResolvedValue({ rooms: [slow, unseen] })
  vi.mocked(roomsLog).mockImplementation(id =>
    id === 'slow' ? held.promise : Promise.resolve({ events: [{ ...event(1), room_id: id }] })
  )
  const refreshing = useRooms.getState().refresh()
  await vi.waitFor(() => expect(useRooms.getState().eventsByRoom.unseen).toHaveLength(1))
  expect(useRooms.getState().order).toEqual(['slow', 'unseen'])
  expect(useRooms.getState().loading).toBe(false)
  expect(useRooms.getState().logBaseline.slow).toBeUndefined()
  held.resolve({ events: [] })
  await refreshing
})

it.each([
  ['list', 'deleted'],
  ['log', 'deleted'],
  ['list', 'left'],
  ['log', 'left'],
  ['list', 'archived'],
  ['log', 'archived'],
  ['list', 'members'],
  ['log', 'members']
] as const)(
  'keeps a live %s read from undoing a room that was %s meanwhile',
  async (phase, change) => {
    useRooms.getState().restore([room], {})
    await writeCache(scope, 'room:r', [event(1)])
    const list = deferred<Awaited<ReturnType<typeof roomsList>>>()
    const log = deferred<{ events: RoomEvent[] }>()
    vi.mocked(roomsList).mockReturnValueOnce(list.promise)
    vi.mocked(roomsLog).mockReturnValueOnce(log.promise)
    const refreshing = useRooms.getState().refresh()

    if (phase === 'log') {
      list.resolve({ rooms: [room] })
      await vi.waitFor(() => expect(roomsLog).toHaveBeenCalledOnce())
    }

    const updated = {
      ...room,
      name: 'Updated room',
      archived_at: change === 'archived' ? 1 : null,
      members: [{ member_id: 'new-bot', member_kind: 'bot', left_at: null }]
    } as Room

    if (change === 'left') {
      vi.mocked(roomsGet).mockRejectedValueOnce(
        Object.assign(new Error('No longer a member'), { code: 4302 })
      )
    } else if (change !== 'deleted') {
      vi.mocked(roomsGet).mockResolvedValueOnce({ room: updated })
    }

    routeEvent({
      type: 'hexbot.rooms.changed',
      payload: { id: 'r', deleted: change === 'deleted' }
    } as never)
    await vi.waitFor(() => {
      if (change === 'deleted' || change === 'left') {
        expect(useRooms.getState().byId.r).toBeUndefined()
      } else {
        expect(useRooms.getState().byId.r).toEqual(updated)
      }
    })
    list.resolve({ rooms: [room] })
    // A late success or gone reply must not change the newer room metadata.
    log.resolve({ events: [event(2)] })
    await refreshing

    if (change === 'deleted' || change === 'left') {
      expect(useRooms.getState().order).not.toContain('r')
      expect(useRooms.getState().eventsByRoom.r).toBeUndefined()
      expect(useRooms.getState().logBaseline.r).toBeUndefined()
    } else {
      expect(useRooms.getState().byId.r).toEqual(updated)

      if (phase === 'log') {
        expect(useRooms.getState().logBaseline.r).toBeUndefined()
      }
    }

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    keepRoster(scope)
    await vi.advanceTimersByTimeAsync(500)
    vi.useRealTimers()
    await writeCache(scope, 'barrier', true)
    const saved = await readCache<{ rooms: Room[] }>(scope, 'roster')
    expect(saved?.rooms).toEqual(
      change === 'deleted' || change === 'left' ? [] : [{ ...updated, turns: [] }]
    )

    if (change !== 'members') {
      expect(await readCache(scope, 'room:r')).toBeUndefined()
    } else if (phase === 'log') {
      expect(await readCache(scope, 'room:r')).toEqual([event(1)])
    }
  }
)

it('ignores an obsolete gone log after a newer room lookup succeeds', async () => {
  const held = deferred<{ events: RoomEvent[] }>()
  vi.mocked(roomsList).mockResolvedValueOnce({ rooms: [room] })
  vi.mocked(roomsLog).mockReturnValueOnce(held.promise)
  const refreshing = useRooms.getState().refresh()
  await vi.waitFor(() => expect(roomsLog).toHaveBeenCalledOnce())
  const updated = { ...room, name: 'New membership' }
  vi.mocked(roomsGet).mockResolvedValueOnce({ room: updated })
  await useRooms.getState().refreshOne('r')
  held.reject(Object.assign(new Error('Old permission failure'), { code: 4302 }))
  await refreshing
  expect(useRooms.getState().byId.r).toEqual(updated)
})

it('keeps the newer roster when overlapping list replies arrive in reverse order', async () => {
  const held = deferred<Awaited<ReturnType<typeof roomsList>>>()
  vi.mocked(roomsList)
    .mockReturnValueOnce(held.promise)
    .mockResolvedValueOnce({ rooms: [room] })
  vi.mocked(roomsLog).mockResolvedValue({ events: [] })
  const old = useRooms.getState().refresh()
  await useRooms.getState().refresh()
  held.resolve({ rooms: [{ ...room, id: 'obsolete-discovery' }] })
  await old
  expect(useRooms.getState().order).toEqual(['r'])
  expect(roomsLog).toHaveBeenCalledTimes(1)
})

it.each(['open', 'markRead'] as const)(
  'does not resurrect a deleted room from a late %s reply',
  async action => {
    useRooms.getState().restore([room], {})
    const held = deferred<{ room: Room }>()
    vi.mocked(roomsGet).mockReturnValueOnce(held.promise)
    vi.mocked(roomsMarkRead).mockReturnValueOnce(held.promise)
    vi.mocked(roomsLog).mockResolvedValueOnce({ events: [event(1)] })

    const pending =
      action === 'open' ? useRooms.getState().open('r') : useRooms.getState().markRead('r', 1)

    routeEvent({ type: 'hexbot.rooms.changed', payload: { id: 'r', deleted: true } } as never)
    held.resolve({ room })
    await pending
    expect(useRooms.getState().byId.r).toBeUndefined()
    expect(useRooms.getState().eventsByRoom.r).toBeUndefined()
    expect(useRooms.getState().logBaseline.r).toBeUndefined()
  }
)

it('a deletion arriving while cached logs restore cannot resurrect room metadata or its log', async () => {
  await writeCache(scope, 'roster', {
    daemon: 'daemon',
    bots: [],
    me: null,
    rooms: [room],
    sections: []
  })
  await writeCache(scope, 'room:r', [event(1)])
  const held = deferred<void>()
  const reached = deferred<void>()
  const read = deviceCache.readCache
  vi.spyOn(deviceCache, 'readCache').mockImplementation(async (...args) => {
    const result = await read(...args)

    if (args[1] === 'room:r') {
      reached.resolve()
      await held.promise
    }

    return result
  })
  const restoring = restoreRoster(scope)
  await reached.promise
  routeEvent({ type: 'hexbot.rooms.changed', payload: { id: 'r', deleted: true } } as never)
  held.resolve()
  await restoring
  expect(useRooms.getState().byId.r).toBeUndefined()
  expect(useRooms.getState().eventsByRoom.r).toBeUndefined()
})

it('successful empty network roster wins over a delayed cache restoration', async () => {
  await writeCache(scope, 'roster', {
    daemon: 'daemon',
    bots: [],
    me: null,
    rooms: [room],
    sections: []
  })
  await writeCache(scope, 'room:r', [event(1)])
  const held = deferred<void>()
  const reached = deferred<void>()
  const read = deviceCache.readCache
  vi.spyOn(deviceCache, 'readCache').mockImplementation(async (...args) => {
    const result = await read(...args)

    if (args[1] === 'room:r') {
      reached.resolve()
      await held.promise
    }

    return result
  })
  const restoring = restoreRoster(scope)
  await reached.promise
  vi.mocked(roomsList).mockResolvedValue({ rooms: [] })
  await useRooms.getState().refresh()
  held.resolve()
  await restoring
  expect(useRooms.getState().byId.r).toBeUndefined()
  expect(useRooms.getState().eventsByRoom.r).toBeUndefined()
})

it('startup cleans deleted cached rooms without waiting for unrelated optional logs', async () => {
  await writeCache(scope, 'roster', {
    daemon: 'daemon',
    bots: [],
    me: null,
    rooms: [room],
    sections: []
  })
  await writeCache(scope, 'room:r', [event(1)])
  suspendCache()
  clearPersonalState()
  const held = deferred<{ events: RoomEvent[] }>()
  vi.mocked(roomsList).mockResolvedValue({ rooms: [{ ...room, id: 'slow' }] })
  vi.mocked(roomsLog).mockReturnValue(held.promise)
  vi.spyOn(useBots.getState(), 'refresh').mockResolvedValue()
  vi.spyOn(useSections.getState(), 'refresh').mockResolvedValue()
  vi.spyOn(useMe.getState(), 'refresh').mockResolvedValue()
  vi.spyOn(useSettings.getState(), 'refresh').mockResolvedValue()
  const supervisor = new ConnectionSupervisor()
  const internal = supervisor as unknown as { client: unknown; hydrate: () => Promise<void> }
  internal.client = { call: async () => ({ install_id: 'daemon' }) }
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const hydrating = internal.hydrate()

  try {
    await vi.waitFor(() => expect(useRooms.getState().byId.slow).toBeDefined())
    expect(useRooms.getState().byId.r).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1000)
    vi.useRealTimers()
    await writeCache(scope, 'barrier', true)
    expect(await readCache(scope, 'room:r')).toBeUndefined()
  } finally {
    held.resolve({ events: [] })
    await hydrating
    internal.client = null
    supervisor.stop()
  }
})

it.each([
  ['roster', 'deleted'],
  ['room:r', 'deleted'],
  ['roster', 'left'],
  ['room:r', 'left'],
  ['roster', 'archived'],
  ['room:r', 'archived'],
  ['roster', 'members'],
  ['room:r', 'members'],
  ['roster', 'empty list'],
  ['room:r', 'empty list'],
  ['roster', 'relisted'],
  ['room:r', 'relisted']
] as const)('preserves room authority when cached %s is held across %s', async (key, change) => {
  const unaffected = { ...room, id: 'other' }
  await writeCache(scope, 'roster', {
    daemon: 'daemon',
    bots: [],
    me: null,
    sections: [],
    rooms: [room, unaffected]
  })
  await writeCache(scope, 'room:r', [event(1)])
  const held = deferred<void>()
  const reached = deferred<void>()
  const read = deviceCache.readCache
  vi.spyOn(deviceCache, 'readCache').mockImplementation(async (...args) => {
    const result = await read(...args)

    if (args[1] === key) {
      reached.resolve()
      await held.promise
    }

    return result
  })
  const restoring = restoreRoster(scope)
  await reached.promise

  const updated = {
    ...room,
    name: 'New membership',
    archived_at: change === 'archived' ? 1 : null,
    members: [{ member_id: 'new-bot' }]
  } as Room

  if (change === 'empty list') {
    vi.mocked(roomsList).mockResolvedValueOnce({ rooms: [] })
    await useRooms.getState().refresh()
  } else if (change === 'deleted') {
    useRooms.getState().drop('r')
  } else {
    if (change === 'relisted') {
      useRooms.getState().drop('r')
    }

    if (change === 'left') {
      vi.mocked(roomsGet).mockRejectedValueOnce(
        Object.assign(new Error('No access'), { code: 4302 })
      )
    } else {
      vi.mocked(roomsGet).mockResolvedValueOnce({ room: updated })
    }

    await useRooms.getState().refreshOne('r')
  }

  held.resolve()
  await restoring
  expect(useRooms.getState().byId.r).toEqual(
    change === 'archived' || change === 'members' || change === 'relisted' ? updated : undefined
  )
  expect(useRooms.getState().eventsByRoom.r).toBeUndefined()
  expect(useRooms.getState().logBaseline.r).toBeUndefined()
  expect(useRooms.getState().order).toEqual(
    change === 'empty list' ? [] : expect.arrayContaining(['other'])
  )
})

it.each(['deleted', 'empty list'] as const)(
  'does not restore cached membership after prior %s authority',
  async change => {
    await writeCache(scope, 'roster', {
      daemon: 'daemon',
      bots: [],
      me: null,
      sections: [],
      rooms: [room]
    })

    if (change === 'deleted') {
      useRooms.getState().drop('r')
    } else {
      vi.mocked(roomsList).mockResolvedValueOnce({ rooms: [] })
      await useRooms.getState().refresh()
    }

    await restoreRoster(scope)
    expect(useRooms.getState().byId.r).toBeUndefined()
    expect(useRooms.getState().order).toEqual([])
  }
)

it('repeated cache restoration preserves live events without duplicate rooms or invented baselines', async () => {
  await writeCache(scope, 'roster', {
    daemon: 'daemon',
    bots: [],
    me: null,
    sections: [],
    rooms: [room]
  })
  useRooms.getState().handleEvent('r', event(200))
  await Promise.all([restoreRoster(scope), restoreRoster(scope)])
  await restoreRoster(scope)
  expect(useRooms.getState().order).toEqual(['r'])
  expect(useRooms.getState().eventsByRoom.r).toEqual([event(200)])
  expect(useRooms.getState().logBaseline.r).toBeUndefined()
})

it('an identity reset invalidates a held cache restore and clears old room authority', async () => {
  await writeCache(scope, 'roster', {
    daemon: 'daemon',
    bots: [],
    me: null,
    sections: [],
    rooms: [room]
  })
  const held = deferred<void>()
  const reached = deferred<void>()
  const read = deviceCache.readCache

  const spy = vi.spyOn(deviceCache, 'readCache').mockImplementation(async (...args) => {
    const result = await read(...args)
    reached.resolve()
    await held.promise

    return result
  })

  const restoring = restoreRoster(scope)
  await reached.promise
  useRooms.getState().drop('r')
  useRooms.getState().reset()
  held.resolve()
  await restoring
  expect(useRooms.getState().byId.r).toBeUndefined()
  spy.mockRestore()
  await restoreRoster(scope)
  expect(useRooms.getState().byId.r).toBeDefined()
})

it.each(['roster', 'room:r'] as const)(
  'rejects a queued stale %s write after authoritative deletion and cleanup',
  async key => {
    useRooms.getState().restore([room], { r: [event(1)] })
    useRooms.setState({ loaded: true })
    const held = deferred<void>()
    const reached = deferred<void>()
    const completed = deferred<void>()
    const write = deviceCache.writeCache
    let blocked = false
    vi.spyOn(deviceCache, 'writeCache').mockImplementation(async (...args) => {
      if (args[1] === key && !blocked) {
        blocked = true
        reached.resolve()
        await held.promise
        await write(...args)
        completed.resolve()
      } else {
        await write(...args)
      }
    })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    keepRoster(scope)
    await vi.advanceTimersByTimeAsync(500)
    await reached.promise
    useRooms.getState().drop('r')
    await vi.advanceTimersByTimeAsync(500)
    held.resolve()
    await completed.promise
    vi.useRealTimers()
    await write(scope, 'barrier', true)
    expect(await readCache(scope, 'room:r')).toBeUndefined()
    expect((await readCache<{ rooms: Room[] }>(scope, 'roster'))?.rooms).toEqual([])
  }
)

it('a cached room can fill a pending lookup without superseding its missing-room answer', async () => {
  await writeCache(scope, 'roster', {
    daemon: 'daemon',
    bots: [],
    me: null,
    sections: [],
    rooms: [room]
  })
  const held = deferred<Awaited<ReturnType<typeof roomsGet>>>()
  vi.mocked(roomsGet).mockReturnValueOnce(held.promise)
  const pending = useRooms.getState().refreshOne('r')
  await restoreRoster(scope)
  expect(useRooms.getState().byId.r).toBeDefined()
  held.reject(Object.assign(new Error('Missing room'), { code: 4230 }))
  expect(await pending).toBe(true)
  expect(useRooms.getState().byId.r).toBeUndefined()
})

it('a superseded cold lookup joins the newer authority instead of claiming an empty store is gone', async () => {
  const first = deferred<Awaited<ReturnType<typeof roomsGet>>>()
  const second = deferred<Awaited<ReturnType<typeof roomsGet>>>()
  vi.mocked(roomsGet).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
  const old = useRooms.getState().refreshOne('r')
  const latest = useRooms.getState().refreshOne('r')
  let settled = false
  void old.then(() => {
    settled = true
  })
  first.reject(Object.assign(new Error('Obsolete missing room'), { code: 4230 }))
  await first.promise.catch(() => undefined)
  expect(settled).toBe(false)
  second.resolve({ room })
  expect(await latest).toBe(true)
  expect(await old).toBe(true)
  expect(useRooms.getState().byId.r).toEqual(room)
})
