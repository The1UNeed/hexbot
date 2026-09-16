import type { GatewayEvent } from '@hermes/shared'

import { useBots } from '../stores/bots'
import { useSections } from '../stores/sections'
import {
  emptyTranscript,
  resetTranscriptEffects,
  setTranscriptEffects,
  useTranscripts
} from '../stores/transcripts'
import fixtures from '../test/fixtures/streaming-turn.json'

import { routeEvent } from './events'
import type { Bot, Section } from './types'

const incident = (overrides: Record<string, unknown> = {}): GatewayEvent =>
  ({
    payload: {
      bot: 'scout',
      incident: { connector: 'notion', id: 'inc-1', kind: 'connector_error', text: 'Token expired' },
      section_id: 'section-1',
      session_id: 'section-1',
      ...overrides
    },
    type: 'hexbot.bots.incident'
  }) as unknown as GatewayEvent

describe('event routing', () => {
  beforeEach(() => {
    useTranscripts.setState({ bySession: {} })
    setTranscriptEffects({ ackApproval: vi.fn(), notify: vi.fn(), touchSection: vi.fn() })
  })
  afterEach(resetTranscriptEffects)
  it('routes a recorded streaming turn in order', () => {
    for (const event of fixtures) {
      routeEvent(event as GatewayEvent)
    }

    // The approval card closes the first bubble; the words after it start a new one.
    const transcript = useTranscripts.getState().bySession['live-1']!
    expect(transcript.messages.map(message => message.text)).toEqual(['Checking ', 'done.'])
    expect(transcript.messages[0]?.toolCalls.map(call => call.status)).toEqual(['ok', 'ok'])
    expect(transcript.messages[1]?.streaming).toBe(false)
    expect(transcript.approvals[0]?.requestId).toBe('approval-1')
    expect(transcript.usage?.total_tokens).toBe(12)
  })

  it('routes reasoning into the trace and the status line beside it', () => {
    const event = (type: string, text: string) =>
      ({ payload: { text }, session_id: 'live-2', type }) as unknown as GatewayEvent

    routeEvent(event('message.start', ''))
    routeEvent(event('reasoning.delta', 'Apples '))
    routeEvent(event('thinking.delta', '⏳ waiting on gpt-6'))
    routeEvent(event('reasoning.delta', 'are red.'))
    expect(useTranscripts.getState().bySession['live-2']!.messages[0]).toMatchObject({
      activity: '⏳ waiting on gpt-6',
      thinking: 'Apples are red.'
    })
  })

  it('places an incident in the section transcript and notifies when the bot allows it', () => {
    const notify = vi.fn()
    setTranscriptEffects({ notify })
    useBots.setState({ byName: { scout: { display_name: 'Scout', name: 'scout' } as Bot } })
    useSections.setState({
      byId: { 'section-1': { bot: 'scout', id: 'section-1' } as Section },
      liveSessionId: { 'section-1': 'live-9' }
    })
    useTranscripts.setState({ bySession: { 'live-9': emptyTranscript('live-9', 'section-1') } })
    routeEvent(incident())
    const row = useTranscripts.getState().bySession['live-9']!.messages.at(-1)!
    expect(row.error).toBe('Token expired')
    expect(row.errorDetail).toEqual({ connector: 'notion', incidentId: 'inc-1' })
    expect(notify).toHaveBeenCalledWith({
      body: 'Token expired',
      sectionId: 'section-1',
      title: 'Scout stopped'
    })
    // The same incident again updates the row instead of adding a second card.
    routeEvent(incident({ incident: { connector: 'notion', id: 'inc-1', text: 'Still expired' } }))
    const rows = useTranscripts.getState().bySession['live-9']!.messages
    expect(rows.filter(item => item.error)).toHaveLength(1)
    expect(rows.at(-1)!.error).toBe('Still expired')
  })
  it('stays quiet for a bot whose Notify me switch is off', () => {
    const notify = vi.fn()
    setTranscriptEffects({ notify })
    useBots.setState({
      byName: { scout: { display_name: 'Scout', name: 'scout', notify: false } as Bot }
    })
    useSections.setState({
      byId: { 'section-1': { bot: 'scout', id: 'section-1' } as Section },
      liveSessionId: { 'section-1': 'live-9' }
    })
    useTranscripts.setState({ bySession: { 'live-9': emptyTranscript('live-9', 'section-1') } })
    routeEvent(incident())
    expect(notify).not.toHaveBeenCalled()
    routeEvent({
      payload: { request_id: 'a', tool: 'terminal' },
      session_id: 'live-9',
      type: 'approval.request'
    } as unknown as GatewayEvent)
    expect(notify).not.toHaveBeenCalled()
  })
})
