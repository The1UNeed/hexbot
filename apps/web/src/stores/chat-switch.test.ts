import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'

import type * as api from '../lib/api'
import { sectionsHistory, sectionsOpen, sessionHistory } from '../lib/api'
import { authorizeCache, cachedHistory, resetDeviceCacheForTests } from '../lib/device-cache'
import type { DaemonInfo, Section } from '../lib/types'

import { useConnection } from './connection'
import { keepHistory, useSections } from './sections'
import { resetTranscriptEffects, setTranscriptEffects, useTranscripts } from './transcripts'

vi.mock('../lib/api', async original => ({
  ...(await original<typeof api>()),
  sectionsHistory: vi.fn(),
  sectionsOpen: vi.fn(),
  sessionHistory: vi.fn()
}))

const scope = 'remote:switch.test:9119'
const section = { id: 's', bot: 'writer', live_session_id: 'live' } as Section
const said = (text: string) => ({ role: 'assistant', row_id: text, text })
const texts = (messages?: { text: string }[]) => messages?.map(message => message.text)
const shown = () => useTranscripts.getState().bySession.live

const daemon = (info: Partial<DaemonInfo> = {}) =>
  ({ install_id: 'daemon', one_chat: true, section_history: true, transcript_identity: true, ...info }) as DaemonInfo

beforeEach(async () => {
  await resetDeviceCacheForTests()
  vi.stubGlobal('indexedDB', new IDBFactory())
  vi.stubGlobal('IDBKeyRange', IDBKeyRange)
  useConnection.setState({
    target: { kind: 'remote', host: 'switch.test', port: 9119, tls: false, deviceToken: 'test' },
    epoch: 'epoch',
    daemon: daemon()
  })
  useSections.getState().reset()
  useTranscripts.getState().dropAll()
  await authorizeCache(scope, 'daemon', () => true)
  setTranscriptEffects({ ackApproval: vi.fn(), notify: vi.fn(), touchSection: vi.fn() })
  vi.resetAllMocks()
})

afterEach(async () => {
  resetTranscriptEffects()
  await resetDeviceCacheForTests()
  vi.unstubAllGlobals()
})

describe('switching to a bot', () => {
  it('shows a chat read ahead without starting its bot, and reads only what is new', async () => {
    vi.mocked(sectionsHistory).mockResolvedValueOnce({
      history_cursor: 'c1',
      history_delta: false,
      messages: [said('One'), said('Two')]
    })
    await useSections.getState().prefetch('s')

    expect(sectionsHistory).toHaveBeenCalledWith('s', undefined)
    expect(sectionsOpen).not.toHaveBeenCalled()
    expect(texts(useSections.getState().cachedMessages.s)).toEqual(['One', 'Two'])

    vi.mocked(sectionsHistory).mockResolvedValueOnce({
      history_cursor: 'c2',
      history_delta: true,
      messages: [said('Three')]
    })
    await useSections.getState().prefetch('s')

    expect(sectionsHistory).toHaveBeenLastCalledWith('s', 'c1')
    expect(texts(useSections.getState().cachedMessages.s)).toEqual(['One', 'Two', 'Three'])
    // The disk keeps the cursor with the rows, for the next start.
    await vi.waitFor(async () =>
      expect(await cachedHistory(scope, 's')).toMatchObject({ complete: true, cursor: 'c2' })
    )
  })

  it('opens with the cursor of what it read ahead and adds only the new rows', async () => {
    vi.mocked(sectionsHistory).mockResolvedValueOnce({
      history_cursor: 'c1',
      history_delta: false,
      messages: [said('One')]
    })
    await useSections.getState().prefetch('s')
    vi.mocked(sectionsOpen).mockResolvedValueOnce({
      section,
      busy: false,
      history_cursor: 'c2',
      history_delta: true,
      messages: [said('Two')]
    })

    await useSections.getState().open('s')

    expect(sectionsOpen).toHaveBeenCalledWith('s', 'c1')
    expect(texts(shown()?.messages)).toEqual(['One', 'Two'])
    expect(useSections.getState().cachedMessages.s).toBeUndefined()
  })

  it('keeps the messages shown when an open finds nothing new, and still ends a finished turn', async () => {
    vi.mocked(sectionsOpen).mockResolvedValueOnce({
      section,
      busy: true,
      history_cursor: 'c1',
      history_delta: false,
      messages: [said('One')]
    })
    await useSections.getState().open('s')
    const messages = shown()!.messages
    useTranscripts.setState(state => ({
      bySession: { ...state.bySession, live: { ...state.bySession.live!, turnActive: true } }
    }))
    const before = shown()!.messages
    vi.mocked(sectionsOpen).mockResolvedValueOnce({
      section,
      busy: false,
      history_cursor: 'c1',
      history_delta: true,
      messages: []
    })

    await useSections.getState().open('s')

    expect(sectionsOpen).toHaveBeenLastCalledWith('s', 'c1')
    expect(before).toBe(messages)
    // Ending the turn settles its last message; every message stays the one drawn.
    expect(shown()!.messages[0]).toBe(messages[0])
    expect(shown()!.turnActive).toBe(false)
  })

  it('builds the transcript again when something happened to it since the last read', async () => {
    vi.mocked(sectionsOpen).mockResolvedValueOnce({
      section,
      history_cursor: 'c1',
      history_delta: false,
      messages: [said('One')]
    })
    await useSections.getState().open('s')
    useTranscripts.getState().appendUserMessage('live', 'Hello')
    vi.mocked(sectionsOpen).mockResolvedValueOnce({
      section,
      history_cursor: 'c1',
      history_delta: true,
      messages: []
    })

    await useSections.getState().open('s')

    expect(texts(shown()?.messages)).toEqual(['One', 'Hello'])
  })

  it('leaves a chat with a loaded transcript to its events', async () => {
    vi.mocked(sectionsOpen).mockResolvedValueOnce({
      section,
      history_cursor: 'c1',
      history_delta: false,
      messages: [said('One')]
    })
    await useSections.getState().open('s')
    vi.mocked(sectionsHistory).mockClear()

    await useSections.getState().prefetch('s')

    expect(sectionsHistory).not.toHaveBeenCalled()
  })

  it('never asks a daemon from before section_history, which opens chats as before', async () => {
    useConnection.setState({ daemon: daemon({ section_history: undefined }) })

    await useSections.getState().prefetch('s')

    expect(sectionsHistory).not.toHaveBeenCalled()
  })

  it('keeps only the newest part of a long chat drawn ahead, however much it holds', async () => {
    const rows = Array.from({ length: 900 }, (_, index) => said(`m${index}`))
    vi.mocked(sectionsHistory).mockResolvedValueOnce({
      history_cursor: 'c1',
      history_delta: false,
      messages: rows
    })

    await useSections.getState().prefetch('s')

    const preview = useSections.getState().cachedMessages.s!
    expect(preview.length).toBeLessThanOrEqual(500)
    expect(preview.at(-1)?.text).toBe('m899')
    // The whole history is still held, so the open asks only for what is new.
    vi.mocked(sectionsOpen).mockResolvedValueOnce({
      section,
      history_cursor: 'c1',
      history_delta: true,
      messages: []
    })
    await useSections.getState().open('s')
    expect(sectionsOpen).toHaveBeenCalledWith('s', 'c1')
    expect(shown()?.messages).toHaveLength(900)
  })

  it('keeps a finished turn with what it holds, so the chat shows it next time', async () => {
    vi.mocked(sectionsOpen).mockResolvedValueOnce({
      section: { ...section, bot: 'writer' },
      history_cursor: 'c1',
      history_delta: false,
      messages: [said('One')]
    })
    await useSections.getState().open('s')
    useSections.setState({ byId: { s: section } })
    vi.mocked(sessionHistory).mockResolvedValueOnce({
      history_cursor: 'c2',
      history_delta: true,
      messages: [said('Two')]
    })

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    keepHistory('s', 'live')
    await vi.advanceTimersByTimeAsync(2000)
    vi.useRealTimers()

    // Only the turn's rows come over, and the next open asks only for what follows them.
    await vi.waitFor(() => expect(sessionHistory).toHaveBeenCalledWith('live', 'c1'))
    await vi.waitFor(async () =>
      expect(await cachedHistory(scope, 's')).toMatchObject({ complete: true, cursor: 'c2' })
    )
    vi.mocked(sectionsOpen).mockResolvedValueOnce({
      section,
      history_cursor: 'c2',
      history_delta: true,
      messages: []
    })
    await useSections.getState().open('s')
    expect(sectionsOpen).toHaveBeenLastCalledWith('s', 'c2')
    expect(texts(shown()?.messages)).toEqual(['One', 'Two'])
  })

  it('reads the whole history again when it holds only the newest part', async () => {
    vi.mocked(sectionsOpen).mockResolvedValueOnce({ section, messages: [said('One')] })

    await useSections.getState().open('s')

    // No cursor from an older daemon: the next open reads everything.
    vi.mocked(sectionsOpen).mockResolvedValueOnce({ section, messages: [said('One')] })
    await useSections.getState().open('s')
    expect(sectionsOpen).toHaveBeenLastCalledWith('s', undefined)
  })
})
