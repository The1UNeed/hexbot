import { asksOf } from '../lib/asks'
import type { DaemonInfo } from '../lib/types'

import { useConnection } from './connection'
import { resetTranscriptEffects, setTranscriptEffects, useTranscripts } from './transcripts'

describe('transcript reducer', () => {
  beforeEach(() => {
    useTranscripts.setState({ bySession: {} })
    setTranscriptEffects({ ackApproval: vi.fn(), notify: vi.fn(), touchSection: vi.fn() })
  })
  afterEach(resetTranscriptEffects)
  it('keeps a replayed room status through hydration and replaces it when work resumes', () => {
    const actions = useTranscripts.getState()
    actions.statusUpdate('s', { kind: 'waiting', text: 'Waiting for Alice' })
    actions.open('s', 'room:r', [])
    expect(useTranscripts.getState().bySession.s?.status).toEqual({
      kind: 'waiting',
      text: 'Waiting for Alice'
    })
    actions.statusUpdate('s', { kind: 'working', text: 'Working' })
    actions.open('s', 'room:r', [])
    expect(useTranscripts.getState().bySession.s?.status?.kind).toBe('working')
    actions.messageComplete('s')
    expect(useTranscripts.getState().bySession.s?.status).toBeNull()
  })
  it('marks the live message while Auto mode checks a step and clears it after', () => {
    const actions = useTranscripts.getState()
    const live = () => useTranscripts.getState().bySession.s?.messages.at(-1)
    actions.messageStart('s')
    actions.toolStart('s', { name: 'terminal', tool_id: 't' })
    actions.statusUpdate('s', { kind: 'checking', text: 'Checking this step' })
    expect(live()?.checking).toBe('Checking this step')
    // An unrelated status line leaves the label; another review may still run.
    actions.statusUpdate('s', { kind: 'status', text: '' })
    actions.statusUpdate('s', { kind: 'waiting', text: 'Retrying the model request' })
    expect(live()?.checking).toBe('Checking this step')
    actions.statusUpdate('s', { kind: 'checking', text: '' })
    expect(live()?.checking).toBeUndefined()
    // The clear does not blank a later, unrelated status line.
    expect(useTranscripts.getState().bySession.s?.status).toEqual({
      kind: 'waiting',
      text: 'Retrying the model request'
    })
  })
  it('keeps checking a step across an approval card until the last review ends', () => {
    const actions = useTranscripts.getState()
    const transcript = () => useTranscripts.getState().bySession.s
    actions.messageStart('s')
    actions.toolStart('s', { name: 'terminal', tool_id: 'a' })
    actions.toolStart('s', { name: 'terminal', tool_id: 'b' })
    actions.statusUpdate('s', { kind: 'checking', text: 'Checking this step' })
    // Review A asks; its card ends the bubble while review B still runs.
    actions.approvalRequest('s', { request_id: 'a' })
    expect(transcript()?.streamingMessageId).toBeNull()
    expect(transcript()?.checking).toBe('Checking this step')
    // The label lives on the transcript; no empty bubble opens to carry it.
    const count = transcript()?.messages.length
    actions.statusUpdate('s', { kind: 'checking', text: 'Checking this step' })
    expect(transcript()?.messages).toHaveLength(count ?? 0)
    expect(transcript()?.streamingMessageId).toBeNull()
    actions.toolComplete('s', { tool_id: 'b' })
    actions.toolStart('s', { name: 'terminal', tool_id: 'c' })
    const live = transcript()?.messages.at(-1)
    expect(live?.streaming).toBe(true)
    expect(live?.checking).toBe('Checking this step')
    actions.statusUpdate('s', { kind: 'checking', text: '' })
    expect(transcript()?.checking).toBeUndefined()
    expect(transcript()?.messages.some(message => message.checking)).toBe(false)
  })
  it('drops checking a step when the turn ends without the clear', () => {
    const actions = useTranscripts.getState()
    const transcript = () => useTranscripts.getState().bySession.s
    actions.messageStart('s')
    actions.statusUpdate('s', { kind: 'checking', text: 'Checking this step' })
    actions.messageComplete('s', { text: 'Done' })
    expect(transcript()?.checking).toBeUndefined()
    expect(transcript()?.messages.at(-1)?.checking).toBeUndefined()
    actions.messageStart('s')
    expect(transcript()?.messages.at(-1)?.checking).toBeUndefined()
  })
  it('leaves settled questions to the history it opens and keeps one still waiting', () => {
    const actions = useTranscripts.getState()
    actions.clarifyRequest('s', { question: 'Answered?', request_id: 'a' })
    actions.answerClarify('s', 'a', 'a', 'Yes')
    actions.clarifyRequest('s', { question: 'Expired?', request_id: 'b' })
    actions.clarifyExpire('s', 'b')
    actions.clarifyRequest('s', { question: 'Waiting?', request_id: 'c' })
    // Two questions sharing an id share one answer.
    actions.clarifyRequest('s', {
      questions: [
        { qid: 'q', question: 'Why?' },
        { qid: 'q', question: 'How?' }
      ],
      request_id: 'd'
    })
    actions.answerClarify('s', 'd', 'q', 'Because')
    actions.open('s', 'sec', [])
    expect(
      useTranscripts.getState().bySession.s?.clarifies.map(clarify => clarify.requestId)
    ).toEqual(['c'])
  })
  it('shows an answered card once when history brings it back', () => {
    const actions = useTranscripts.getState()

    const form = {
      bcc: [],
      body: 'Dear Admissions Team,',
      cc: [],
      from: 'alex@example.com',
      kind: 'email_draft' as const,
      service: 'microsoft' as const,
      service_name: 'Outlook',
      subject: 'Report cards',
      to: []
    }

    actions.approvalRequest('s', { form, message_id: 'a1', request_id: 'live', turn_id: 't' })
    actions.approvalRequest('s', { message_id: 'a3', request_id: 'waiting', turn_id: 't' })
    actions.resolveApproval('s', 'live', 'once', {
      draft: { ...form, to: ['admission@example.com'] },
      mail_action: 'send'
    })

    const restored = {
      choices: ['once' as const, 'deny' as const],
      decision: 'once' as const,
      form,
      messageId: 'a1',
      receivedAt: 0,
      requestId: 'm1',
      sessionId: ''
    }

    actions.open('s', 'sec', [
      {
        approvals: [restored],
        attachments: [],
        createdAt: 0,
        fragmentIds: ['a1'],
        id: 'a1',
        role: 'assistant',
        streaming: false,
        text: '',
        toolCalls: []
      }
    ])
    const transcript = useTranscripts.getState().bySession.s
    // The live copy goes; a card still waiting stays live.
    expect(transcript?.approvals.map(card => card.requestId)).toEqual(['waiting'])
    expect(transcript?.messages[0]?.approvals).toEqual([restored])
  })
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
  it('keeps nested steps on their parent when an approval splits the turn', () => {
    const actions = useTranscripts.getState()
    actions.messageStart('s')
    actions.toolStart('s', { name: 'codemode', tool_id: 'code' })
    actions.approvalRequest('s', { request_id: 'a' })
    actions.toolStart('s', {
      name: 'mcp__github__list',
      tool_id: 'code/1',
      parent_tool_call_id: 'code'
    })
    actions.toolComplete('s', { name: 'mcp__github__list', tool_id: 'code/1', result_text: 'ok' })
    const messages = useTranscripts.getState().bySession.s?.messages ?? []
    const parent = messages.find(message => message.toolCalls.some(call => call.toolId === 'code'))
    expect(parent?.toolCalls).toMatchObject([
      { toolId: 'code' },
      { toolId: 'code/1', parentToolCallId: 'code', status: 'ok' }
    ])
  })
  it('keeps each message of a turn as its own part', () => {
    const actions = useTranscripts.getState()
    actions.messageStart('s')
    actions.messageDelta('s', 'I will check.')
    actions.toolStart('s', { name: 'terminal', tool_id: 't1' })
    actions.messageDelta('s', 'Do')
    // Still being written: not a part yet.
    expect(useTranscripts.getState().bySession.s?.messages[0]).toMatchObject({
      parts: ['I will check.'],
      text: 'Do'
    })
    actions.messageComplete('s', { text: 'Done.' })
    expect(useTranscripts.getState().bySession.s?.messages[0]).toMatchObject({
      parts: ['I will check.'],
      streaming: false,
      text: 'Done.'
    })
  })

  it('does not repeat a part when the turn ends right after a tool', () => {
    const actions = useTranscripts.getState()
    actions.messageStart('s')
    actions.messageDelta('s', 'I will check.')
    actions.toolStart('s', { name: 'terminal', tool_id: 't1' })
    actions.messageComplete('s', { text: 'I will check.' })
    expect(useTranscripts.getState().bySession.s?.messages[0]).toMatchObject({
      parts: [],
      text: 'I will check.'
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

  it('shows a failure once when its incident lands before the failed reply', () => {
    const actions = useTranscripts.getState()
    actions.messageStart('s')
    actions.incidentEvent('s', 'The requested model is not supported.', {
      connector: null,
      incidentId: 'inc-2'
    })
    actions.messageComplete('s', {
      error: 'The requested model is not supported.',
      status: 'error'
    })
    const { messages } = useTranscripts.getState().bySession.s!
    expect(messages.filter(item => item.error)).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      role: 'assistant',
      error: 'The requested model is not supported.',
      errorDetail: { incidentId: 'inc-2' }
    })
    // A later update to the same incident still finds that one card.
    actions.incidentEvent('s', 'Still not supported.', { connector: null, incidentId: 'inc-2' })
    expect(useTranscripts.getState().bySession.s!.messages).toHaveLength(1)
  })

  it('keeps a send accepted when another try under its key answers late with nothing', () => {
    useConnection.setState({
      target: { kind: 'local' },
      epoch: 'first',
      daemon: { transcript_identity: true, install_id: 'home' } as DaemonInfo
    })
    const actions = useTranscripts.getState()
    const input = actions.appendUserMessage('s', 'hi')
    actions.inputSubmitting('s', input.id, [])
    actions.inputSettled('s', input.id, input.inputId, 'accepted', [])
    actions.inputSettled('s', input.id, input.inputId, 'unknown', [], 'connection closed')
    expect(useTranscripts.getState().bySession.s!.messages[0]!.submission?.status).toBe('accepted')
  })

  it('undoes an in-place resend without dropping what was sent since', () => {
    const actions = useTranscripts.getState()
    const input = actions.appendUserMessage('s', 'hi')
    actions.errorEvent('s', 'Provider stopped')
    const undo = actions.resendInPlace('s', input.id, 'second-key')
    const newer = actions.appendUserMessage('s', 'and this')
    undo()
    const { messages } = useTranscripts.getState().bySession.s!
    expect(messages.map(message => message.text || message.error)).toEqual([
      'hi',
      'Provider stopped',
      'and this'
    ])
    expect(messages[0]!.inputId).toBe(input.inputId)
    expect(messages[2]!.id).toBe(newer.id)
  })

  it('stops every running step when the turn ends', () => {
    const actions = useTranscripts.getState()

    const running = () =>
      useTranscripts
        .getState()
        .bySession.s!.messages.flatMap(message => message.toolCalls)
        .filter(call => call.status === 'running')

    // A card closes the message while its step still runs, then the turn fails.
    actions.messageStart('s')
    actions.toolStart('s', { name: 'terminal', tool_id: 'a' })
    actions.approvalRequest('s', { request_id: 'a' })
    actions.messageStart('s')
    actions.toolStart('s', { name: 'terminal', tool_id: 'b' })
    actions.errorEvent('s', 'Pi stopped')
    expect(running()).toEqual([])

    // A turn that ends right after a card settles the closed message too.
    actions.messageStart('s')
    actions.messageDelta('s', 'Run it?')
    actions.toolStart('s', { name: 'terminal', tool_id: 'c' })
    actions.approvalRequest('s', { request_id: 'c' })
    actions.messageComplete('s')
    expect(running()).toEqual([])
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

  it('completes the sole running call when a reused tool id omits message_id after an earlier call finished', () => {
    const actions = useTranscripts.getState()
    actions.messageStart('s')
    actions.toolStart('s', {
      args: { text: 'Ping bio', to: 'biology', wait: false },
      name: 'message_bot',
      tool_id: 'call_0'
    })
    actions.toolComplete('s', {
      name: 'message_bot',
      result: { details: { section_id: 'th-bio', status: 'sent' } },
      tool_id: 'call_0'
    })
    actions.toolStart('s', {
      args: { text: 'Ping chem', to: 'chemistry', wait: false },
      name: 'message_bot',
      tool_id: 'call_0'
    })
    actions.toolComplete('s', {
      name: 'message_bot',
      result: { details: { section_id: 'th-chem', status: 'sent' } },
      tool_id: 'call_0'
    })
    actions.messageComplete('s', { text: 'Sent both.' })
    const calls = useTranscripts.getState().bySession.s!.messages.flatMap(m => m.toolCalls)
    expect(calls).toMatchObject([
      {
        args: { to: 'biology', wait: false },
        result: { details: { section_id: 'th-bio', status: 'sent' } },
        status: 'ok',
        toolId: 'call_0'
      },
      {
        args: { to: 'chemistry', wait: false },
        result: { details: { section_id: 'th-chem', status: 'sent' } },
        status: 'ok',
        toolId: 'call_0'
      }
    ])
  })

  it('upgrades a hydrated running message_bot declaration on replayed toolStart and completes it cleanly', () => {
    const actions = useTranscripts.getState()
    actions.open(
      's',
      'sec-1',
      [
        {
          attachments: [],
          createdAt: 0,
          fragmentIds: ['a1'],
          id: 'a1',
          role: 'assistant',
          streaming: false,
          text: 'Checking.',
          textId: 'a1',
          toolCalls: [
            {
              args: { to: 'biology' },
              durationS: null,
              messageId: 'a1',
              name: 'message_bot',
              result: null,
              startedAt: 0,
              status: 'running',
              toolId: 'call_0'
            }
          ],
          turnId: 'T1'
        }
      ],
      { reports: [] },
      { busy: true, readAt: Date.now() }
    )
    actions.eventIdentity('s', { messageId: 'a1', turnId: 'T1' })
    actions.toolStart('s', {
      args: { to: 'biology' },
      context: 'biology',
      name: 'message_bot',
      tool_id: 'call_0'
    })
    actions.toolComplete('s', {
      context: 'biology',
      name: 'message_bot',
      result: { details: { section_id: 'th-bio', status: 'replied' } },
      tool_id: 'call_0'
    })
    const calls = useTranscripts.getState().bySession.s!.messages.flatMap(m => m.toolCalls)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      args: { to: 'biology' },
      messageId: 'a1',
      name: 'message_bot',
      result: { details: { section_id: 'th-bio', status: 'replied' } },
      status: 'ok',
      toolId: 'call_0'
    })
  })

  it('does not overwrite an earlier settled ask or web_search call when a reconnect completion reuses call_0 without message_id', () => {
    const actions = useTranscripts.getState()
    actions.eventIdentity('s', { messageId: 'a1', turnId: 'T1' })
    actions.messageStart('s')
    actions.toolStart('s', {
      args: { to: 'chemistry' },
      context: 'chemistry',
      name: 'message_bot',
      tool_id: 'call_0'
    })
    actions.toolComplete('s', {
      context: 'chemistry',
      name: 'message_bot',
      result: { details: { section_id: 'th-chem', status: 'replied' } },
      tool_id: 'call_0'
    })
    // Reconnect after missing Biology's tool.start; daemon omits message_id on reused call_0.
    actions.eventIdentity('s', { turnId: 'T1' })
    actions.toolComplete('s', {
      context: 'biology',
      name: 'message_bot',
      result: { details: { section_id: 'th-bio', status: 'replied' } },
      tool_id: 'call_0'
    })
    const calls = useTranscripts.getState().bySession.s!.messages.flatMap(m => m.toolCalls)
    expect(calls).toMatchObject([
      {
        args: { to: 'chemistry' },
        name: 'message_bot',
        result: { details: { section_id: 'th-chem', status: 'replied' } },
        status: 'ok',
        toolId: 'call_0'
      },
      {
        name: 'message_bot',
        result: { details: { section_id: 'th-bio', status: 'replied' } },
        status: 'ok',
        summary: 'biology',
        toolId: 'call_0'
      }
    ])

    // Same isolation when an earlier settled call was a different tool (web_search) using call_0.
    actions.eventIdentity('s2', { messageId: 'b1', turnId: 'T2' })
    actions.messageStart('s2')
    actions.toolStart('s2', { args: { query: 'biology' }, name: 'web_search', tool_id: 'call_0' })
    actions.toolComplete('s2', { name: 'web_search', result_text: 'results', tool_id: 'call_0' })
    actions.eventIdentity('s2', { turnId: 'T2' })
    actions.toolComplete('s2', {
      context: 'biology',
      name: 'message_bot',
      result: { details: { section_id: 'th-bio', status: 'replied' } },
      tool_id: 'call_0'
    })
    expect(
      useTranscripts.getState().bySession.s2!.messages.flatMap(m => m.toolCalls)
    ).toMatchObject([
      { name: 'web_search', result: 'results', status: 'ok', toolId: 'call_0' },
      {
        name: 'message_bot',
        result: { details: { section_id: 'th-bio', status: 'replied' } },
        status: 'ok',
        summary: 'biology',
        toolId: 'call_0'
      }
    ])

    // A still-running Chemistry ask on call_0 must NOT absorb an untagged Biology completion on call_0.
    actions.eventIdentity('s3', { messageId: 'c1', turnId: 'T3' })
    actions.messageStart('s3')
    actions.toolStart('s3', {
      args: { to: 'chemistry' },
      context: 'chemistry',
      name: 'message_bot',
      tool_id: 'call_0'
    })
    actions.eventIdentity('s3', { turnId: 'T3' })
    actions.toolComplete('s3', {
      context: 'biology',
      name: 'message_bot',
      result: { details: { section_id: 'th-bio', status: 'replied' } },
      tool_id: 'call_0'
    })
    expect(
      useTranscripts.getState().bySession.s3!.messages.flatMap(m => m.toolCalls)
    ).toMatchObject([
      { args: { to: 'chemistry' }, name: 'message_bot', result: null, status: 'running', toolId: 'call_0' },
      {
        name: 'message_bot',
        result: { details: { section_id: 'th-bio', status: 'replied' } },
        status: 'ok',
        summary: 'biology',
        toolId: 'call_0'
      }
    ])

    // A settled wait:true Biology reply must NOT be overwritten by a later missed-start
    // untagged wait:false send reusing call_0 on the same section; both calls survive.
    actions.eventIdentity('s4', { messageId: 'd1', turnId: 'T4' })
    actions.messageStart('s4')
    actions.toolStart('s4', {
      args: { to: 'biology', wait: true },
      context: 'biology',
      name: 'message_bot',
      tool_id: 'call_0'
    })
    actions.toolComplete('s4', {
      context: 'biology',
      name: 'message_bot',
      result: { details: { section_id: 'th-bio', status: 'replied' } },
      tool_id: 'call_0'
    })
    actions.eventIdentity('s4', { turnId: 'T4' })
    actions.toolComplete('s4', {
      context: 'biology',
      name: 'message_bot',
      result: { details: { section_id: 'th-bio', status: 'sent' } },
      tool_id: 'call_0'
    })
    const bioCalls = useTranscripts.getState().bySession.s4!.messages.flatMap(m => m.toolCalls)
    expect(bioCalls).toHaveLength(2)
    expect(asksOf(bioCalls)).toEqual([
      { sectionId: 'th-bio', sent: false, status: 'ok', target: 'biology' }
    ])

    // An untagged Biology tool.start must NOT rename a hydrated Chemistry call_0 placeholder.
    actions.open(
      's5',
      'sec-5',
      [
        {
          attachments: [],
          createdAt: 0,
          fragmentIds: ['a1'],
          id: 'a1',
          role: 'assistant',
          streaming: false,
          text: 'Asking Chem.',
          toolCalls: [
            {
              args: { to: 'chemistry' },
              durationS: null,
              messageId: 'a1',
              name: 'message_bot',
              result: null,
              startedAt: 0,
              status: 'running',
              toolId: 'call_0'
            }
          ],
          turnId: 'T5'
        }
      ],
      { reports: [] },
      { busy: true, readAt: Date.now() }
    )
    actions.eventIdentity('s5', { turnId: 'T5' })
    actions.toolStart('s5', {
      args: { to: 'biology' },
      context: 'biology',
      name: 'message_bot',
      tool_id: 'call_0'
    })
    expect(
      useTranscripts.getState().bySession.s5!.messages.flatMap(m => m.toolCalls)
    ).toMatchObject([
      { args: { to: 'chemistry' }, messageId: 'a1', status: 'running', toolId: 'call_0' },
      { args: { to: 'biology' }, status: 'running', summary: 'biology', toolId: 'call_0' }
    ])
  })
})
