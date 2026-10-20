import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'

import type * as api from '../lib/api'
import { sectionsOpen } from '../lib/api'
import {
  CACHED_SECTIONS,
  cachedHistory,
  clearCache,
  forgetHistory,
  readCache,
  rememberHistory,
  resetDeviceCacheForTests,
  writeCache
} from '../lib/device-cache'
import type { Section } from '../lib/types'

import { useConnection } from './connection'
import { useSections } from './sections'
import { emptyTranscript, useTranscripts } from './transcripts'

vi.mock('../lib/api', async importOriginal => ({
  ...(await importOriginal<typeof api>()),
  sectionsOpen: vi.fn()
}))

const section = { bot: 'writer', id: 's1', live_session_id: 'live-1', title: 'Plans' } as Section
const row = (text: string) => ({ role: 'user', row_id: text, text })
const texts = () => useTranscripts.getState().bySession['live-1']?.messages.map(item => item.text)

beforeEach(async () => {
  await resetDeviceCacheForTests()
  vi.stubGlobal('indexedDB', new IDBFactory())
  vi.stubGlobal('IDBKeyRange', IDBKeyRange)
  useConnection.setState({
    target: { deviceToken: 't', host: 'daemon.test', kind: 'remote', port: 9119, tls: false }
  })
  useSections.setState({ byId: {}, cachedMessages: {}, idsByBot: {}, liveSessionId: {} })
  useTranscripts.setState({ bySession: {} })
  vi.mocked(sectionsOpen).mockReset()
})

afterEach(() => vi.unstubAllGlobals())

describe('the device cache', () => {
  it('keeps the most recently opened sections and each scope apart', async () => {
    for (let index = 0; index <= CACHED_SECTIONS; index += 1) {
      await rememberHistory('a', `s${index}`, { cursor: '0:1', rows: [] })
    }

    // The first one opened is the one that goes.
    expect(await cachedHistory('a', 's0')).toBeUndefined()
    expect(await cachedHistory('a', `s${CACHED_SECTIONS}`)).toEqual({ cursor: '0:1', rows: [] })

    await writeCache('b', 'roster', 'kept')
    await clearCache('a')
    expect(await cachedHistory('a', 's1')).toBeUndefined()
    expect(await readCache('b', 'roster')).toBe('kept')
  })

  it('frees the place of a forgotten section', async () => {
    for (let index = 0; index < CACHED_SECTIONS; index += 1) {
      await rememberHistory('a', `s${index}`, { cursor: '0:1', rows: [] })
    }

    await forgetHistory('a', 's5')
    await rememberHistory('a', 'new', { cursor: '0:1', rows: [] })
    // The oldest one stays: the forgotten section no longer counts.
    expect(await cachedHistory('a', 's0')).toBeTruthy()
  })

  it('does nothing without IndexedDB', async () => {
    await resetDeviceCacheForTests()
    vi.stubGlobal('indexedDB', undefined)
    await rememberHistory('a', 's1', { cursor: '0:1', rows: [] })
    expect(await cachedHistory('a', 's1')).toBeUndefined()
  })
})

describe('opening a section with kept history', () => {
  it('shows what it kept, then asks only for what came after', async () => {
    vi.mocked(sectionsOpen).mockResolvedValueOnce({
      history_cursor: '0:2',
      history_delta: false,
      messages: [row('one'), row('two')],
      section
    })
    await useSections.getState().open('s1')
    expect(vi.mocked(sectionsOpen)).toHaveBeenLastCalledWith('s1', undefined)
    expect(texts()).toEqual(['one', 'two'])
    await vi.waitFor(async () =>
      expect(await cachedHistory('remote:daemon.test:9119', 's1')).toBeTruthy()
    )

    // A relaunch: no live session yet, and the daemon has one new row.
    useSections.setState({ liveSessionId: {} })
    useTranscripts.setState({ bySession: {} })
    let answer: (value: Awaited<ReturnType<typeof sectionsOpen>>) => void = () => undefined
    vi.mocked(sectionsOpen).mockReturnValueOnce(new Promise(resolve => (answer = resolve)))
    const opening = useSections.getState().open('s1')

    await vi.waitFor(() => expect(vi.mocked(sectionsOpen)).toHaveBeenLastCalledWith('s1', '0:2'))
    expect(useSections.getState().cachedMessages.s1?.map(item => item.text)).toEqual(['one', 'two'])

    answer({ history_cursor: '0:3', history_delta: true, messages: [row('three')], section })
    await opening
    expect(texts()).toEqual(['one', 'two', 'three'])
    expect(useSections.getState().cachedMessages.s1).toBeUndefined()
    await vi.waitFor(async () =>
      expect(await cachedHistory('remote:daemon.test:9119', 's1')).toEqual({
        cursor: '0:3',
        rows: [row('one'), row('two'), row('three')]
      })
    )
  })

  it('takes the whole history when the daemon rewrote it, and forgets a section that is gone', async () => {
    await rememberHistory('remote:daemon.test:9119', 's1', {
      cursor: '0:2',
      rows: [row('one'), row('two')]
    })
    vi.mocked(sectionsOpen).mockResolvedValueOnce({
      history_cursor: '1:2',
      history_delta: false,
      messages: [row('uno'), row('two')],
      section
    })
    await useSections.getState().open('s1')
    expect(texts()).toEqual(['uno', 'two'])

    vi.mocked(sectionsOpen).mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 4204 }))
    await expect(useSections.getState().open('s1')).rejects.toThrow('gone')
    expect(useSections.getState().cachedMessages.s1).toBeUndefined()
    await vi.waitFor(async () =>
      expect(await cachedHistory('remote:daemon.test:9119', 's1')).toBeUndefined()
    )
  })

  it('shows what it kept when the section list or live events came first', async () => {
    await rememberHistory('remote:daemon.test:9119', 's1', { cursor: '0:1', rows: [row('one')] })
    useSections.setState({ liveSessionId: { s1: 'live-1' } })
    // An event for the working session made a transcript before the section opened.
    useTranscripts.setState({ bySession: { 'live-1': emptyTranscript('live-1') } })
    vi.mocked(sectionsOpen).mockReturnValueOnce(new Promise(() => undefined))
    void useSections.getState().open('s1')

    await vi.waitFor(() =>
      expect(useSections.getState().cachedMessages.s1?.map(item => item.text)).toEqual(['one'])
    )
  })

  it('keeps what it showed when opening times out', async () => {
    await rememberHistory('remote:daemon.test:9119', 's1', { cursor: '0:1', rows: [row('one')] })
    vi.mocked(sectionsOpen).mockRejectedValueOnce(new Error('timed out after 15s'))
    await expect(useSections.getState().open('s1')).rejects.toThrow('timed out')

    expect(useSections.getState().cachedMessages.s1?.map(item => item.text)).toEqual(['one'])
    expect(await cachedHistory('remote:daemon.test:9119', 's1')).toBeTruthy()
  })

  it('keeps nothing from a daemon without cursors', async () => {
    vi.mocked(sectionsOpen).mockResolvedValueOnce({ messages: [row('one')], section })
    await useSections.getState().open('s1')
    expect(texts()).toEqual(['one'])
    expect(await cachedHistory('remote:daemon.test:9119', 's1')).toBeUndefined()
  })
})
