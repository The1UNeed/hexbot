import { resetTranscriptEffects, setTranscriptEffects, useTranscripts } from './transcripts'

describe('transcript reducer', () => {
  beforeEach(() => {
    useTranscripts.setState({ bySession: {} })
    setTranscriptEffects({ ackApproval: vi.fn(), notify: vi.fn(), touchSection: vi.fn() })
  })
  afterEach(resetTranscriptEffects)
  it('opens on a delta and does not duplicate streamed interim text', () => {
    const actions = useTranscripts.getState()
    actions.messageDelta('s', 'hello')
    actions.messageInterim('s', 'hello', true)
    actions.messageComplete('s')
    expect(useTranscripts.getState().bySession.s?.messages[0]).toMatchObject({
      streaming: false,
      text: 'hello'
    })
  })
  it('appends reasoning to the trace and times the work', () => {
    const actions = useTranscripts.getState()
    actions.messageStart('s')
    actions.reasoningDelta('s', 'Apples ')
    actions.reasoningDelta('s', 'are red.')
    const message = useTranscripts.getState().bySession.s!.messages[0]!
    expect(message.thinking).toBe('Apples are red.')
    expect(message.workUntil).toBeGreaterThanOrEqual(message.createdAt)
    actions.messageComplete('s')
    expect(useTranscripts.getState().bySession.s!.messages).toHaveLength(1)
  })

  it('treats the daemon status line as a wait notice, not reasoning', () => {
    const actions = useTranscripts.getState()
    // Fires before the turn's message exists: nothing to annotate, no bubble.
    actions.thinkingDelta('s', '(◔_◔) pondering...')
    expect(useTranscripts.getState().bySession.s?.messages ?? []).toHaveLength(0)
    actions.messageStart('s')
    actions.thinkingDelta('s', '( •_•)>⌐■-■ ruminating...')
    expect(useTranscripts.getState().bySession.s!.messages[0]?.activity).toBeUndefined()
    actions.thinkingDelta('s', '⏳ waiting on gpt-6 — 30s with no response yet')
    expect(useTranscripts.getState().bySession.s!.messages[0]?.activity).toBe(
      '⏳ waiting on gpt-6 — 30s with no response yet'
    )
    actions.thinkingDelta('s', '')
    const message = useTranscripts.getState().bySession.s!.messages[0]!
    expect(message.activity).toBeUndefined()
    expect(message.thinking).toBeUndefined()
  })

  it('keeps an approval after its decision', () => {
    const actions = useTranscripts.getState()
    actions.approvalRequest('s', { request_id: 'a' })
    actions.resolveApproval('s', 'a', 'deny')
    expect(useTranscripts.getState().bySession.s?.approvals[0]?.decision).toBe('deny')
  })

  it('places an incident before the streaming bubble and keeps streaming', () => {
    const actions = useTranscripts.getState()
    actions.messageDelta('s', 'Pulling ')
    actions.incidentEvent('s', 'Notion refused the request', {
      connector: 'notion',
      incidentId: 'inc-1'
    })
    actions.messageDelta('s', 'the pages')
    const { messages, streamingMessageId } = useTranscripts.getState().bySession.s!
    expect(messages.map(item => item.role)).toEqual(['system', 'assistant'])
    expect(messages[0]).toMatchObject({ errorDetail: { incidentId: 'inc-1' } })
    expect(messages[1]).toMatchObject({ streaming: true, text: 'Pulling the pages' })
    expect(streamingMessageId).toBe(messages[1]!.id)
    // The same incident again updates the card in place.
    actions.incidentEvent('s', 'Still refused', { connector: 'notion', incidentId: 'inc-1' })
    expect(useTranscripts.getState().bySession.s!.messages).toHaveLength(2)
    expect(useTranscripts.getState().bySession.s!.messages[0]?.error).toBe('Still refused')
  })

  it('keeps the connector on an error row', () => {
    const actions = useTranscripts.getState()
    actions.messageDelta('s', 'working')
    actions.errorEvent('s', 'Notion refused the request', { connector: 'notion' })
    const messages = useTranscripts.getState().bySession.s!.messages
    expect(messages[0]?.streaming).toBe(false)
    expect(messages[1]).toMatchObject({
      error: 'Notion refused the request',
      errorDetail: { connector: 'notion' },
      role: 'system'
    })
  })
})
