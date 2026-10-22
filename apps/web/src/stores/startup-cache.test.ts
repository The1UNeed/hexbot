import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'

import type * as api from '../lib/api'
import {
  messagesFromHistory,
  roomsGet,
  roomsLog,
  roomsMarkRead,
  sectionsOpen,
  sessionHistory
} from '../lib/api'
import {
  authorizeCache,
  boundedHistory,
  cacheAccess,
  CACHED_SECTIONS,
  cachedHistory,
  forgetHistory,
  HISTORY_BYTES,
  HISTORY_ROWS,
  readCache,
  rememberHistory,
  resetDeviceCacheForTests,
  revokeCache,
  suspendCache,
  writeCache
} from '../lib/device-cache'
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
import { resetTranscriptEffects, setTranscriptEffects, useTranscripts } from './transcripts'

vi.mock('../lib/api', async original => ({
  ...(await original<typeof api>()),
  roomsGet: vi.fn(),
  roomsLog: vi.fn(),
  roomsMarkRead: vi.fn(),
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

  const promise = new Promise<T>(yes => {
    resolve = yes
  })

  return { promise, resolve }
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
  vi.clearAllMocks()
})
afterEach(async () => {
  vi.useRealTimers()
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

it('an empty verified room cannot turn a later lone event into a restored baseline', async () => {
  vi.mocked(roomsGet).mockResolvedValue({ room })
  vi.mocked(roomsMarkRead).mockResolvedValue({ room })
  vi.mocked(roomsLog).mockResolvedValue({ events: [] })
  await useRooms.getState().open('r')
  useRooms.getState().handleEvent('r', event(200))
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
