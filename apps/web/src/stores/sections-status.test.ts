import type { Bot, Section } from '../lib/types'

import { botStatusWithLive, liveSectionsOf, sectionStatusOf } from './sections'
import { emptyTranscript } from './transcripts'

describe('live section status', () => {
  const bot = {
    name: 'a',
    status: 'working',
    status_detail: { section_id: 's1' }
  } as unknown as Bot

  const sections = [{ id: 's1' }, { id: 's2' }] as Section[]

  it('prefers the daemon status for its own section and live transcripts elsewhere', () => {
    expect(sectionStatusOf(bot, 's1')).toBe('working')
    expect(sectionStatusOf(bot, 's2', { s2: 'needs_you' })).toBe('needs_you')
    expect(sectionStatusOf(bot, 's2')).toBe('idle')
    expect(sectionStatusOf(undefined, null)).toBe('idle')
    expect(botStatusWithLive(bot, sections, { s2: 'needs_you' })).toBe('needs_you')
    expect(botStatusWithLive(bot, sections, {})).toBe('working')
    expect(botStatusWithLive({ name: 'b' } as Bot, sections, { s1: 'working' })).toBe('working')

    const stopped = { name: 'b', status: 'stopped' } as unknown as Bot
    expect(botStatusWithLive(stopped, sections, { s1: 'needs_you' })).toBe('stopped')
  })

  it('reads a waiting card or a streaming reply off the open transcripts', () => {
    const asking = {
      ...emptyTranscript('l1', 's1'),
      clarifies: [{ answers: {}, questions: [{}], requestId: 'r' }]
    }

    const streaming = { ...emptyTranscript('l2', 's2'), streamingMessageId: 'm1' }
    const quiet = { ...emptyTranscript('l3', 's3') }
    expect(liveSectionsOf({ l1: asking, l2: streaming, l3: quiet } as never)).toEqual({
      s1: 'needs_you',
      s2: 'working',
      s3: 'idle'
    })
  })

  it('overrides Waiting only after a successful local answer', () => {
    const waiting = {
      name: 'a',
      status: 'needs_you',
      status_detail: { section_id: 's1' }
    } as unknown as Bot

    expect(sectionStatusOf(waiting, 's1')).toBe('needs_you')
    expect(sectionStatusOf(waiting, 's1', { s1: 'needs_you' })).toBe('needs_you')
    expect(sectionStatusOf(waiting, 's1', { s1: 'idle' })).toBe('needs_you')
    expect(sectionStatusOf(waiting, 's1', { s1: 'working' })).toBe('needs_you')
    expect(sectionStatusOf(waiting, 's1', { s1: 'answered' })).toBe('working')
    expect(botStatusWithLive(waiting, sections, {})).toBe('needs_you')
    expect(botStatusWithLive(waiting, sections, { s1: 'idle' })).toBe('needs_you')
    expect(botStatusWithLive(waiting, sections, { s1: 'answered' })).toBe('working')
  })

  it('uses the same daemon precedence when another device answers a stale card', () => {
    expect(sectionStatusOf(bot, 's1', { s1: 'needs_you' })).toBe('working')
    expect(botStatusWithLive(bot, sections, { s1: 'needs_you' })).toBe('working')
  })

  it('uses fresh live transitions without treating old streams as fresh authority', () => {
    const waiting = { ...bot, status: 'needs_you' } as Bot

    for (const stale of [waiting, bot]) {
      expect(sectionStatusOf(stale, 's1', { s1: { status: 'idle' } })).toBe('idle')
      expect(botStatusWithLive(stale, sections, { s1: { status: 'idle' } })).toBe('idle')
    }

    expect(sectionStatusOf(waiting, 's1', { s1: { status: 'working' } })).toBe('working')
    expect(sectionStatusOf(waiting, 's1', { s1: 'working' })).toBe('needs_you')
    expect(
      botStatusWithLive(waiting, sections, { s1: { status: 'working' }, s2: 'needs_you' })
    ).toBe('needs_you')
    const stopped = { ...bot, status: 'stopped' } as Bot
    expect(sectionStatusOf(stopped, 's1', { s1: { status: 'idle' } })).toBe('stopped')
  })

  it('applies fresh transitions only to an exact named thread and preserves room fallback', () => {
    const thread = { ...bot, status: 'needs_you', status_detail: { section_id: 'thread' } } as Bot
    expect(botStatusWithLive(thread, sections, { thread: { status: 'working' } })).toBe('working')
    expect(botStatusWithLive(thread, sections, { thread: { status: 'idle' } })).toBe('idle')
    expect(botStatusWithLive(thread, sections, { s2: { status: 'working' } })).toBe('needs_you')
    const room = { ...bot, status: 'needs_you', status_detail: { room_id: 'r' } } as Bot
    expect(botStatusWithLive(room, sections, { 'room:r': { status: 'working' } })).toBe('needs_you')
    expect(
      botStatusWithLive({ ...room, status: 'working' }, sections, { 'room:r': { status: 'idle' } })
    ).toBe('working')
  })

  it('uses exact room-session authority without transferring another bot’s status', () => {
    const room = {
      ...bot,
      status: 'needs_you',
      status_detail: { room_id: 'r', section_id: null, session_id: 'owl-live' }
    } as Bot

    const sessions = {
      'owl-live': { sectionId: 'room:r', liveStatus: 'working' as const },
      'cat-live': { sectionId: 'room:r', liveStatus: 'needs_you' as const }
    }

    const shared = { 'room:r': { status: 'needs_you' as const } }
    expect(botStatusWithLive(room, sections, shared, sessions)).toBe('working')
    expect(
      botStatusWithLive({ ...room, status: 'working' }, sections, shared, {
        ...sessions,
        'owl-live': { sectionId: 'room:r', liveStatus: 'idle' }
      })
    ).toBe('idle')

    const cat = {
      ...room,
      status: 'working',
      status_detail: { ...room.status_detail, session_id: 'cat-live' }
    } as Bot

    expect(botStatusWithLive(cat, sections, shared, sessions)).toBe('needs_you')
    expect(
      botStatusWithLive(
        { ...room, status_detail: { ...room.status_detail, session_id: null } } as Bot,
        sections,
        shared,
        sessions
      )
    ).toBe('needs_you')
    expect(botStatusWithLive(room, sections, shared, { 'cat-live': sessions['cat-live'] })).toBe(
      'needs_you'
    )
    expect(
      botStatusWithLive(room, sections, shared, {
        'owl-live': { sectionId: 'room:other', liveStatus: 'working' }
      })
    ).toBe('needs_you')
    expect(botStatusWithLive({ ...room, status: 'stopped' }, sections, shared, sessions)).toBe(
      'stopped'
    )
  })

  it.each(['approval', 'clarify'] as const)(
    'uses existing %s answer proof only for the exact room session',
    kind => {
      const room = {
        ...bot,
        status: 'needs_you',
        status_detail: { room_id: 'r', section_id: 'r', session_id: 'own' }
      } as Bot

      const answered = {
        ...emptyTranscript('own', 'room:r'),
        answeredWaiting: { kind, requestId: 'answer' },
        approvals: kind === 'approval' ? [{ requestId: 'answer', decision: 'once' }] : [],
        clarifies:
          kind === 'clarify'
            ? [{ requestId: 'answer', answers: { answer: 'Yes' }, questions: [{}] }]
            : []
      }

      const live = liveSectionsOf({ own: answered } as never)

      expect(botStatusWithLive(room, sections, live, { own: answered })).toBe('working')
      expect(botStatusWithLive(room, sections, live, { other: answered })).toBe('needs_you')
      expect(
        botStatusWithLive(
          { ...room, status_detail: { ...room.status_detail, session_id: null } } as Bot,
          sections,
          live,
          { own: answered }
        )
      ).toBe('needs_you')
    }
  )

  it('keeps room and thread status when the daemon names no listed section', () => {
    const room = { ...bot, status: 'needs_you', status_detail: { room_id: 'r' } } as Bot
    const thread = { ...bot, status_detail: { section_id: 'thread' } } as Bot
    expect(botStatusWithLive(room, sections, {})).toBe('needs_you')
    expect(botStatusWithLive(thread, sections, {})).toBe('working')
  })

  it('leaves archived sections out of the bot status', () => {
    const waiting = {
      name: 'a',
      status: 'needs_you',
      status_detail: { section_id: 's1' }
    } as unknown as Bot

    const archived = [{ archived_at: 1, id: 's1' }, { id: 's2' }] as Section[]
    expect(botStatusWithLive(waiting, archived, {})).toBe('idle')
    expect(botStatusWithLive({ name: 'b' } as Bot, archived, { s1: 'needs_you' })).toBe('idle')
    expect(botStatusWithLive(waiting, sections, {})).toBe('needs_you')
  })

  it('ignores a delayed retry incident only for an archived private section', () => {
    const stopped = {
      ...bot,
      status: 'stopped',
      status_detail: { section_id: 's1', action: { kind: 'retry' } }
    } as Bot

    const archived = [{ archived_at: 1, id: 's1' }, { id: 's2' }] as Section[]
    expect(botStatusWithLive(stopped, archived, {})).toBe('idle')
    expect(botStatusWithLive(stopped, archived, { s2: 'working' })).toBe('working')
    expect(botStatusWithLive(stopped, archived, { s2: 'needs_you' })).toBe('needs_you')
    expect(botStatusWithLive(stopped, sections, {})).toBe('stopped')

    for (const detail of [
      { section_id: 's1', action: { kind: 'fix_connector', connector: 'mail' } },
      { section_id: 's1', action: null },
      { section_id: null, action: { kind: 'retry' } },
      { section_id: 's1', room_id: 'r', action: { kind: 'retry' } },
      { section_id: 'thread', action: { kind: 'retry' } }
    ]) {
      expect(botStatusWithLive({ ...stopped, status_detail: detail } as Bot, archived, {})).toBe(
        'stopped'
      )
    }
  })
})
