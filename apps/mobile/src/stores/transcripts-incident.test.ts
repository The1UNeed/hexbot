import {
  emptyTranscript,
  resetTranscriptEffects,
  setTranscriptEffects,
  useTranscripts
} from './transcripts'

beforeEach(() => {
  setTranscriptEffects({ ackApproval: vi.fn(), notify: vi.fn(), touchSection: vi.fn() })
})
afterEach(resetTranscriptEffects)

describe('incident after an error event', () => {
  beforeEach(() => {
    useTranscripts.setState({ bySession: { 'live-1': emptyTranscript('live-1', 's1') } })
  })

  it('adds its detail to the fresh error card instead of drawing a second one', () => {
    const store = useTranscripts.getState()
    store.errorEvent('live-1', 'HTTP 400: bad request')
    store.incidentEvent('live-1', 'Error code: 400', { connector: null, incidentId: 'inc-1' })

    const errors = useTranscripts.getState().bySession['live-1']!.messages.filter(m => m.error)
    expect(errors).toHaveLength(1)
    expect(errors[0]?.error).toBe('Error code: 400')
    expect(errors[0]?.errorDetail?.incidentId).toBe('inc-1')
  })

  it('still draws its own card when no error row is recent', () => {
    const store = useTranscripts.getState()
    store.incidentEvent('live-1', 'Token expired', { connector: 'notion', incidentId: 'inc-2' })

    const errors = useTranscripts.getState().bySession['live-1']!.messages.filter(m => m.error)
    expect(errors).toHaveLength(1)
    expect(errors[0]?.error).toBe('Token expired')
  })
})

describe('a card in the middle of a turn', () => {
  beforeEach(() => {
    useTranscripts.setState({ bySession: { 'live-1': emptyTranscript('live-1', 's1') } })
  })

  it('closes the bubble so the next words land under the card, and strips the prefix at the end', () => {
    const store = useTranscripts.getState()
    store.messageStart('live-1')
    store.messageDelta('live-1', 'Hi there.')
    store.clarifyRequest('live-1', { choices: ['A'], question: 'Which?', request_id: 'r1' }, { notify: false })
    store.messageDelta('live-1', 'Got it.')
    store.messageComplete('live-1', { text: 'Hi there.Got it.' })

    const transcript = useTranscripts.getState().bySession['live-1']!
    const texts = transcript.messages.map(message => message.text)
    expect(texts).toEqual(['Hi there.', 'Got it.'])
    expect(transcript.messages[0]?.streaming).toBe(false)
    expect(transcript.clarifies[0]?.receivedAt).toBeGreaterThanOrEqual(transcript.messages[0]!.createdAt)
    expect(transcript.turnPrefix).toBeUndefined()
  })

  it('does not notify twice for a replayed question', () => {
    const store = useTranscripts.getState()
    store.clarifyRequest('live-1', { question: 'Which?', request_id: 'r1' })
    store.clarifyRequest('live-1', { question: 'Which?', request_id: 'r1' })
    expect(useTranscripts.getState().bySession['live-1']!.clarifies).toHaveLength(1)
  })
})
