import type { GatewayEvent } from '@hermes/shared'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { routeEvent } from '../../lib/events'
import { setActiveRpc } from '../../lib/rpc'
import type { ClarifyRequest } from '../../lib/types'
import {
  emptyTranscript,
  resetTranscriptEffects,
  setTranscriptEffects,
  useTranscripts
} from '../../stores/transcripts'

import { ClarifyCard, encodeAnswer } from './clarify-card'

const clarify = (patch: Partial<ClarifyRequest> = {}): ClarifyRequest => ({
  answers: {},
  questions: [
    {
      choices: ['Deep research (Recommended)', 'Tech digging', 'Keeping up'],
      multiSelect: false,
      question: 'What do you mainly want me for?'
    }
  ],
  receivedAt: 0,
  requestId: 'req-1',
  sessionId: 'live-1',
  ...patch
})

describe('clarify events', () => {
  beforeEach(() => {
    useTranscripts.setState({ bySession: { 'live-1': emptyTranscript('live-1', 'section-1') } })
    setTranscriptEffects({ ackApproval: vi.fn(), notify: vi.fn(), touchSection: vi.fn() })
  })
  afterEach(resetTranscriptEffects)

  it('pushes a question card, notifies, and freezes it on expire', () => {
    const notify = vi.fn()
    setTranscriptEffects({ notify })
    routeEvent({
      payload: { choices: ['A', 'B'], question: 'Which?', request_id: 'req-1' },
      session_id: 'live-1',
      type: 'clarify.request'
    } as GatewayEvent)

    const card = useTranscripts.getState().bySession['live-1']!.clarifies[0]!
    expect(card.questions[0]).toEqual({ choices: ['A', 'B'], multiSelect: false, question: 'Which?' })
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: 'Needs you' }))

    routeEvent({
      payload: { request_id: 'req-1' },
      session_id: 'live-1',
      type: 'clarify.expire'
    } as GatewayEvent)
    expect(useTranscripts.getState().bySession['live-1']!.clarifies[0]!.expired).toBe(true)
  })

  it('keeps a batch as one card with one entry per question', () => {
    routeEvent({
      payload: {
        questions: [
          { choices: ['x'], multi_select: true, qid: 'q1', question: 'One?' },
          { choices: null, qid: 'q2', question: 'Two?' }
        ],
        request_id: 'req-2'
      },
      session_id: 'live-1',
      type: 'clarify.request'
    } as GatewayEvent)

    const card = useTranscripts.getState().bySession['live-1']!.clarifies[0]!
    expect(card.questions.map(item => item.questionId)).toEqual(['q1', 'q2'])
    expect(card.questions[0]?.multiSelect).toBe(true)
    expect(card.questions[1]?.choices).toEqual([])
  })
})

describe('clarify card', () => {
  beforeEach(() => {
    useTranscripts.setState({ bySession: { 'live-1': emptyTranscript('live-1') } })
  })

  it('answers a single-select question with one click and collapses to the answer', async () => {
    const call = vi.fn(() => Promise.resolve({ status: 'ok' }))
    setActiveRpc({ call } as never)
    useTranscripts.setState({
      bySession: { 'live-1': { ...emptyTranscript('live-1'), clarifies: [clarify()] } }
    })

    const { rerender } = render(<ClarifyCard clarify={clarify()} />)
    expect(screen.getByText('Recommended')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('option', { name: /Tech digging/ }))

    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('clarify.respond', {
        answer: 'Tech digging',
        request_id: 'req-1',
        session_id: 'live-1'
      })
    )

    const answered = useTranscripts.getState().bySession['live-1']!.clarifies[0]!
    expect(answered.answers).toEqual({ 'req-1': 'Tech digging' })
    rerender(<ClarifyCard clarify={answered} />)
    expect(screen.queryByRole('option')).not.toBeInTheDocument()
    expect(screen.getByText('Tech digging')).toBeInTheDocument()
  })

  it('sends a multi-select answer as a JSON list and a typed answer as is', () => {
    const question = { choices: ['A', 'B'], multiSelect: true, question: 'Pick' }
    expect(encodeAnswer(question, ['A', 'B'], '')).toBe('["A","B"]')
    expect(encodeAnswer(question, ['A'], 'mine')).toBe('["A","mine"]')
    expect(encodeAnswer({ ...question, multiSelect: false }, ['A'], 'mine')).toBe('mine')
    expect(encodeAnswer({ ...question, multiSelect: false }, ['A'], '')).toBe('A')
  })

  it('takes no input once the bot stopped waiting', () => {
    render(<ClarifyCard clarify={clarify({ expired: true })} />)
    expect(screen.getByRole('option', { name: /Tech digging/ })).toBeDisabled()
    expect(screen.getByText(/stopped waiting/)).toBeInTheDocument()
  })
})
