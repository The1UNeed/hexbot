import type { GatewayEvent } from '@hermes/shared'

import { resetTranscriptEffects, setTranscriptEffects, useTranscripts } from '../stores/transcripts'
import fixtures from '../test/fixtures/streaming-turn.json'

import { routeEvent } from './events'

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

    const transcript = useTranscripts.getState().bySession['live-1']!
    expect(transcript.messages[0]?.text).toBe('Checking done.')
    expect(transcript.messages[0]?.toolCalls.map(call => call.status)).toEqual(['ok', 'ok'])
    expect(transcript.approvals[0]?.requestId).toBe('approval-1')
    expect(transcript.usage?.total_tokens).toBe(12)
  })
})
