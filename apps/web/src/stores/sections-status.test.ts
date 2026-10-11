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

  it('stops waiting as soon as the open transcript has your answer', () => {
    const waiting = {
      name: 'a',
      status: 'needs_you',
      status_detail: { section_id: 's1' }
    } as unknown as Bot

    expect(sectionStatusOf(waiting, 's1')).toBe('needs_you')
    expect(sectionStatusOf(waiting, 's1', { s1: 'needs_you' })).toBe('needs_you')
    expect(sectionStatusOf(waiting, 's1', { s1: 'idle' })).toBe('working')
    expect(sectionStatusOf(waiting, 's1', { s1: 'working' })).toBe('working')
    expect(botStatusWithLive(waiting, sections, {})).toBe('needs_you')
    expect(botStatusWithLive(waiting, sections, { s1: 'idle' })).toBe('working')
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
  })
})
