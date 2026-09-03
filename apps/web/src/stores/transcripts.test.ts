import { resetTranscriptEffects, setTranscriptEffects, useTranscripts } from './transcripts'

describe('transcript reducer', () => {
  beforeEach(() => { useTranscripts.setState({ bySession: {} }); setTranscriptEffects({ ackApproval: vi.fn(), notify: vi.fn(), touchSection: vi.fn() }) })
  afterEach(resetTranscriptEffects)
  it('opens on a delta and does not duplicate streamed interim text', () => {
    const actions = useTranscripts.getState()
    actions.messageDelta('s', 'hello')
    actions.messageInterim('s', 'hello', true)
    actions.messageComplete('s')
    expect(useTranscripts.getState().bySession.s?.messages[0]).toMatchObject({ streaming: false, text: 'hello' })
  })
  it('keeps an approval after its decision', () => {
    const actions = useTranscripts.getState()
    actions.approvalRequest('s', { request_id: 'a' })
    actions.resolveApproval('s', 'a', 'deny')
    expect(useTranscripts.getState().bySession.s?.approvals[0]?.decision).toBe('deny')
  })
})
