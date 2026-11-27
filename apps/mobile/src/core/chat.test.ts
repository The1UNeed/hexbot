import { describe, it, expect } from 'vitest'
import { asksOf } from '../../../web/src/lib/asks'
import { mediaOf } from '../../../web/src/lib/media'
import { settledCard } from '../../../web/src/lib/settled-cards'
import {
  askItemId,
  bufferedRunEnded,
  heartbeatMessage,
  emptyChat,
  latestRunEvents,
  mergeTurnTools,
  pendingTurnTools,
  reduceChat,
  historyMessages,
  replayChat,
  sharedFiles,
  turnAskGroups,
  unconfirmedTurnTools
} from './chat'
import type { GatewayEvent } from '@hermes/shared'
import type { ChatState } from './types'
const event = (type: string, payload: Record<string, unknown> = {}): GatewayEvent => ({
  type,
  session_id: 's1',
  payload
})
describe('chat event projection', () => {
  it('keeps interim commentary separate and finalizes partial interrupted text', () => {
    let s = reduceChat(emptyChat(), event('message.start'))
    s = reduceChat(s, event('message.delta', { text: 'Checking files.' }))
    s = reduceChat(s, event('message.interim', { text: 'Checking files.', already_streamed: true }))
    s = reduceChat(s, event('message.delta', { text: 'Found ' }))
    s = reduceChat(s, event('message.delta', { text: 'two.' }))
    s = reduceChat(s, event('message.complete', { text: 'Found two.' }))
    expect(s.messages.map(m => m.text)).toEqual(['Checking files.', 'Found two.'])
    expect(s.busy).toBe(false)
    expect(s.streaming).toBe('')
  })
  it('keeps a reply cut off by your next message ahead of that message', () => {
    let s: ChatState = { ...emptyChat(), messages: [{ id: 'a', role: 'user', text: 'Write an essay' }] }
    s = reduceChat(s, event('message.start'))
    s = reduceChat(s, event('message.delta', { text: 'Bridges are' }))
    s = { ...s, messages: [...s.messages, { id: 'b', role: 'user', text: 'Stop that' }] }
    s = reduceChat(s, event('message.complete', { text: 'Bridges are' }))
    s = reduceChat(s, event('message.start'))
    s = reduceChat(s, event('message.complete', { text: 'A bridge spans a gap.' }))
    expect(s.messages.map(m => m.text)).toEqual([
      'Write an essay',
      'Bridges are',
      'Stop that',
      'A bridge spans a gap.'
    ])
  })
  it('shows Auto mode checking a step and keeps the turn busy after', () => {
    let s = reduceChat(emptyChat(), event('status.update', { kind: 'working', text: 'Working' }))
    s = reduceChat(s, event('tool.start', { tool_id: 't', name: 'terminal' }))
    s = reduceChat(s, event('status.update', { kind: 'checking', text: 'Checking this step' }))
    expect(s.activity).toBe('Checking this step')
    // An unrelated status line keeps the label; another review may still run.
    s = reduceChat(s, event('status.update', { kind: 'status', text: '' }))
    s = reduceChat(s, event('status.update', { kind: 'waiting', text: 'Retrying' }))
    expect(s.activity).toBe('Checking this step')
    s = reduceChat(s, event('status.update', { kind: 'checking', text: '' }))
    expect(s.activity).toBe('')
    expect(s.busy).toBe(true)
  })
  it('keeps checking a step through an approval card and drops it when the turn ends', () => {
    let s = reduceChat(
      emptyChat(),
      event('status.update', { kind: 'checking', text: 'Checking this step' })
    )
    s = reduceChat(s, event('approval.request', { request_id: 'a' }))
    s = reduceChat(s, event('tool.complete', { tool_id: 'b' }))
    expect(s.activity).toBe('Checking this step')
    s = reduceChat(s, event('message.complete', { text: 'Done' }))
    expect(s.checking).toBe('')
    s = reduceChat(s, event('tool.start', { tool_id: 'c', name: 'terminal' }))
    expect(s.activity).toBe('Using terminal')
  })
  it('deduplicates re-sent approval cards and keeps the originating session', () => {
    let s = reduceChat(
      emptyChat(),
      event('approval.request', {
        request_id: 'r1',
        command: 'touch report',
        choices: ['once', 'deny']
      })
    )
    s = reduceChat(
      s,
      event('approval.request', {
        request_id: 'r1',
        command: 'touch report',
        choices: ['once', 'deny']
      })
    )
    expect(s.approvals).toHaveLength(1)
    expect(s.approvals[0].sessionId).toBe('s1')
    expect(reduceChat(s, event('message.complete')).approvals).toEqual([])
  })
  it("keeps a sign-in card's fields and drops a malformed form", () => {
    const form = {
      kind: 'sign_in',
      site: 'app.schoology.com',
      title: 'Schoology',
      username: 'alex'
    }
    let s = reduceChat(
      emptyChat(),
      event('approval.request', { request_id: 'r1', command: 'Sign in to Schoology', form })
    )
    expect(s.approvals[0].form).toEqual(form)
    s = reduceChat(
      emptyChat(),
      event('approval.request', { request_id: 'r2', form: { kind: 'other', site: 1 } })
    )
    expect(s.approvals[0].form).toBeUndefined()
  })
  it("keeps a draft card's email so the phone can edit it", () => {
    const form = {
      kind: 'email_draft',
      service: 'microsoft',
      service_name: 'Outlook',
      from: 'sam@contoso.com',
      to: ['ana@example.com'],
      cc: [],
      bcc: [],
      subject: 'Budget',
      body: 'Numbers attached.',
      reply_to: null
    }
    const s = reduceChat(
      emptyChat(),
      event('approval.request', { request_id: 'r1', command: 'Email to ana@example.com', form })
    )
    expect(s.approvals[0].form).toEqual(form)
    const bad = reduceChat(
      emptyChat(),
      event('approval.request', { request_id: 'r2', form: { kind: 'email_draft', to: 'x' } })
    )
    expect(bad.approvals[0].form).toBeUndefined()
  })
  it('moves a question card forward on a re-send with newer answers, never back', () => {
    const questions = [
      { qid: 'q1', question: 'Colour?' },
      { qid: 'q2', question: 'Shape?' }
    ]
    const shown = (s: ReturnType<typeof emptyChat>) =>
      s.questions.map(q => q.questions.map(question => question.id))
    let s = reduceChat(emptyChat(), event('clarify.request', { request_id: 'batch', questions }))
    expect(shown(s)).toEqual([['q1', 'q2']])
    // Another app answered q1, then opened the room: the daemon re-sends the card.
    s = reduceChat(
      s,
      event('clarify.request', { request_id: 'batch', questions, answers: { q1: 'red' } })
    )
    expect(shown(s)).toEqual([['q2']])
    s = reduceChat(s, event('clarify.request', { request_id: 'batch', questions }))
    expect(shown(s)).toEqual([['q2']])
  })
  it('keeps a card answered on another app with its answer, and drops one no longer waited on', () => {
    let s = emptyChat()
    for (const id of ['a1', 'a2']) s = reduceChat(s, event('approval.request', { request_id: id }))
    for (const id of ['q1', 'q2'])
      s = reduceChat(s, event('clarify.request', { request_id: id, question: 'Colour?' }))
    s = reduceChat(s, event('approval.resolved', { request_id: 'a1', choice: 'once' }))
    s = reduceChat(s, event('clarify.resolved', { request_id: 'q1', answers: { q1: 'red' } }))
    expect(s.approvals.map(a => [a.requestId, a.decision])).toEqual([
      ['a1', 'once'],
      ['a2', undefined]
    ])
    expect(s.questions.map(q => q.requestId)).toEqual(['q2'])
    s = reduceChat(s, event('approval.expire', { request_id: 'a2' }))
    // A late expire never takes an answered card.
    s = reduceChat(s, event('approval.expire', { request_id: 'a1' }))
    expect(s.approvals.map(a => a.requestId)).toEqual(['a1'])
    expect(s.questions.map(q => q.requestId)).toEqual(['q2'])
    expect(s.busy).toBe(true)
  })
  it('keeps a sent draft card with the email as it went until the turn ends', () => {
    const form = {
      kind: 'email_draft',
      to: [],
      cc: [],
      bcc: [],
      subject: 'Report cards',
      body: 'Dear Admissions Team,',
      from: 'alex@example.com',
      service: 'microsoft',
      service_name: 'Outlook'
    }
    let s = reduceChat(emptyChat(), event('message.start', {}))
    s = reduceChat(s, event('approval.request', { request_id: 'd1', form }))
    const draft = { ...form, to: ['admission@example.com'] }
    s = reduceChat(
      s,
      event('approval.resolved', { request_id: 'd1', choice: 'once', mail_action: 'send', draft })
    )
    expect(s.approvals).toMatchObject([
      { requestId: 'd1', decision: 'once', outcome: { draft, mail_action: 'send' } }
    ])
    // Its tool, now on the reply, shows the card from here on.
    s = reduceChat(s, event('message.complete', { text: 'Sent.' }))
    expect(s.approvals).toEqual([])
  })
  it('shows a sent draft card again from history and after a live turn', () => {
    const args = { action: 'draft', subject: 'Report cards', body: 'Dear Admissions Team,' }
    const sent = {
      account: 'microsoft',
      to: ['admission@example.com'],
      cc: [],
      subject: 'Report cards',
      body: 'Dear Admissions Team,',
      sent: true,
      note: 'The user sent this, as shown, after any changes they made.'
    }
    const cards = (
      state: {
        tools?: { args: unknown; detail: string; name: string; status: 'error' | 'ok' | 'running' | 'unresolved' }[]
      }[]
    ) => state.flatMap(m => m.tools ?? []).map(t => settledCard({ ...t, result: t.detail }))
    const expected = {
      decision: 'once',
      form: { kind: 'email_draft', service: 'microsoft', subject: 'Report cards' },
      outcome: { mail_action: 'send', draft: { to: ['admission@example.com'] } }
    }
    const history = historyMessages([
      { role: 'user', content: 'Write to admissions' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 't1', function: { name: 'hexbot_mail', arguments: JSON.stringify(args) } }]
      },
      { role: 'tool', tool_call_id: 't1', name: 'hexbot_mail', text: JSON.stringify(sent) },
      { role: 'assistant', content: 'Sent to the admissions team.' }
    ])
    expect(cards(history)).toMatchObject([expected])
    // Live, Pi's result carries the tool's JSON as details.
    let s = reduceChat(emptyChat(), event('message.start'))
    s = reduceChat(s, event('tool.start', { tool_id: 't1', name: 'hexbot_mail', args }))
    s = reduceChat(
      s,
      event('tool.complete', {
        tool_id: 't1',
        result: { content: [{ type: 'text', text: JSON.stringify(sent) }], details: sent }
      })
    )
    s = reduceChat(s, event('message.complete', { text: 'Sent to the admissions team.' }))
    expect(cards(s.messages)).toMatchObject([expected])
    // A draft the user closed shows as not sent; one that failed before a card showed, nothing.
    s = reduceChat(emptyChat(), event('message.start'))
    for (const [id, error] of [
      ['t2', 'The user closed the draft without sending it. Ask what they would like to change, or leave it.'],
      ['t3', 'Outlook is not connected.']
    ]) {
      s = reduceChat(s, event('tool.start', { tool_id: id, name: 'hexbot_mail', args }))
      s = reduceChat(
        s,
        event('tool.complete', { tool_id: id, result: { content: [{ type: 'text', text: error }], error } })
      )
    }
    s = reduceChat(s, event('message.complete', { text: 'Left it.' }))
    expect(cards(s.messages)).toMatchObject([{ decision: 'deny', form: { subject: 'Report cards' } }, null])
  })
  it('shows a live card that the user agreed to as failed when its work does', () => {
    const form = { kind: 'plugin', action: 'install', id: 'package:echo', name: 'echo', bot: 'owl', fields: [] }
    let s = reduceChat(emptyChat(), event('message.start'))
    s = reduceChat(s, event('approval.request', { request_id: 'r1', tool_id: 'p1', form }))
    s = reduceChat(s, event('approval.resolved', { request_id: 'r1', choice: 'once' }))
    const error = "The user agreed on the card, but it didn't work: echo is already installed."
    s = reduceChat(s, event('tool.complete', { tool_id: 'p1', result: { content: [{ type: 'text', text: error }], error } }))
    expect(s.approvals).toMatchObject([{ requestId: 'r1', decision: 'once', failed: true }])
  })
  it('keeps each tool under the words it came with, as history does', () => {
    const shown = (state: ChatState) =>
      state.messages.map(m => [m.text, (m.tools ?? []).map(t => t.id)])
    // Words, then the draft from that message, then the reply.
    let s = reduceChat(emptyChat(), event('message.start'))
    s = reduceChat(s, event('message.interim', { text: 'I will draft it.', message_id: 'r1' }))
    s = reduceChat(s, event('tool.start', { tool_id: 'd1', name: 'hexbot_mail', message_id: 'r1' }))
    s = reduceChat(s, event('tool.complete', { tool_id: 'd1', result_text: '{}' }))
    s = reduceChat(s, event('message.complete', { text: 'Sent.', message_id: 'r2' }))
    expect(shown(s)).toEqual([
      ['I will draft it.', ['d1']],
      ['Sent.', []]
    ])
    // A tool called without words gets its own place before the reply, and
    // a later step's tool never joins earlier words from another message.
    s = reduceChat(emptyChat(), event('message.start'))
    s = reduceChat(s, event('tool.start', { tool_id: 'd1', name: 'hexbot_mail', message_id: 'r1' }))
    s = reduceChat(s, event('message.interim', { text: 'Looking.', message_id: 'r2' }))
    s = reduceChat(s, event('tool.start', { tool_id: 's1', name: 'search', message_id: 'r2' }))
    s = reduceChat(s, event('tool.start', { tool_id: 'd2', name: 'hexbot_mail', message_id: 'r3' }))
    s = reduceChat(s, event('message.complete', { text: 'Done.', message_id: 'r4' }))
    expect(shown(s)).toEqual([
      ['', ['d1']],
      ['Looking.', ['s1']],
      ['', ['d2']],
      ['Done.', []]
    ])
    expect(s.messages.map(m => m.rowId)).toEqual(['r1', 'r2', 'r3', 'r4'])
  })
  it('restores text content without exposing hidden system prompts or tool rows', () => {
    expect(
      historyMessages([
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] },
        { role: 'user', content: 'Secret', hidden: true },
        { role: 'tool', content: 'bytes' }
      ]).map(m => m.text)
    ).toEqual(['Hi', 'Hello'])
  })
  it("shows the asking bot's questions in a thread between bots", () => {
    const rows = [
      { role: 'user', content: '@owl: When are the dates?', hidden: true, row_id: 'q1' },
      { role: 'assistant', content: '12 and 14 March.' },
      { role: 'user', content: 'A prompt the daemon added', hidden: true }
    ]
    expect(historyMessages(rows, 'owl').map(m => [m.sender, m.role, m.text])).toEqual([
      ['owl', 'assistant', 'When are the dates?'],
      [undefined, 'assistant', '12 and 14 March.']
    ])
    // In a bot's own chat the same rows stay hidden.
    expect(historyMessages(rows).map(m => m.text)).toEqual(['12 and 14 March.'])
  })
  it('groups asks per turn in 1:1 chats while keeping peer exchanges and room turns separate', () => {
    const askTool = (id: string, to: string, sent = false) => ({
      args: { to },
      detail: JSON.stringify(
        sent ? { section_id: 'th-g', status: 'sent' } : { section_id: 'th-g' }
      ),
      id,
      name: 'message_bot',
      status: 'ok' as const
    })

    // 1. Peer thread: two separate exchanges by the asking bot keep two distinct ask groups.
    const peerMsgs = [
      { id: 'q1', role: 'assistant' as const, sender: 'owl', text: 'First question' },
      { id: 'a1', role: 'assistant' as const, text: 'Reply 1', tools: [askTool('t1', 'gamma', false)] },
      { id: 'q2', role: 'assistant' as const, sender: 'owl', text: 'Second question' },
      { id: 'a2', role: 'assistant' as const, text: 'Reply 2', tools: [askTool('t2', 'gamma', true)] }
    ]
    const peerGroups = turnAskGroups(peerMsgs, { chatBot: 'beta', isRoom: false }).groups
    expect([...peerGroups.keys()]).toEqual([1, 3])
    expect(peerGroups.get(1)?.tools.map(t => t.id)).toEqual(['t1'])
    expect(peerGroups.get(3)?.tools.map(t => t.id)).toEqual(['t2'])

    // 2. Room: consecutive message.bot replies from the same bot stay separate turns.
    const roomMsgs = [
      { id: 'r1', role: 'assistant' as const, sender: 'alpha', text: 'First', tools: [askTool('t1', 'gamma', false)] },
      { id: 'r2', role: 'assistant' as const, sender: 'alpha', text: 'Second', tools: [askTool('t2', 'gamma', true)] }
    ]
    const roomGroups = turnAskGroups(roomMsgs, { isRoom: true }).groups
    expect([...roomGroups.keys()]).toEqual([0, 1])
    expect(roomGroups.get(0)?.tools.map(t => t.id)).toEqual(['t1'])
    expect(roomGroups.get(1)?.tools.map(t => t.id)).toEqual(['t2'])

    // 3. 1:1 chat: multi-fragment assistant turn merges into one group on the final fragment.
    const chatMsgs = [
      { id: 'f1', role: 'assistant' as const, text: 'Checking', tools: [askTool('t1', 'beta', true)], turnId: 'turn-1' },
      { id: 'f2', role: 'assistant' as const, text: 'Done', tools: [askTool('t2', 'beta', false)], turnId: 'turn-1' }
    ]
    const chatGroups = turnAskGroups(chatMsgs, { chatBot: 'alpha', isRoom: false }).groups
    expect([...chatGroups.keys()]).toEqual([1])
    expect(chatGroups.get(1)?.tools.map(t => t.id)).toEqual(['t1', 't2'])

    // 4. Separate assistant turns with a hidden background row dropped between them never merge.
    const separated = historyMessages([
      {
        role: 'assistant',
        row_id: 'a1',
        text: 'First turn',
        turn_id: 'turn-1',
        tool_calls: [{ id: 'call_0', function: { arguments: '{"to":"beta"}' } }]
      },
      { role: 'tool', name: 'message_bot', tool_call_id: 'call_0', text: '{"section_id":"th-1"}', turn_id: 'turn-1' },
      { role: 'user', content: 'Background job finished', hidden: true, turn_id: 'turn-2' },
      {
        role: 'assistant',
        row_id: 'a2',
        text: 'Second turn',
        turn_id: 'turn-2',
        tool_calls: [{ id: 'call_0', function: { arguments: '{"to":"gamma"}' } }]
      },
      { role: 'tool', name: 'message_bot', tool_call_id: 'call_0', text: '{"section_id":"th-2"}', turn_id: 'turn-2' }
    ])
    const separatedGroups = turnAskGroups(separated, { chatBot: 'scout', isRoom: false }).groups
    expect([...separatedGroups.keys()]).toEqual([0, 1])
    expect(separatedGroups.get(0)?.turnId).toBe('turn-1')
    expect(separatedGroups.get(1)?.turnId).toBe('turn-2')
    expect([
      askItemId({
        isRoom: false,
        speaker: 'scout',
        target: 'beta',
        toolId: 'call_0',
        turnId: separatedGroups.get(0)?.turnId,
        turnIndex: separatedGroups.get(0)!.turnIndex
      }),
      askItemId({
        isRoom: false,
        speaker: 'scout',
        target: 'gamma',
        toolId: 'call_0',
        turnId: separatedGroups.get(1)?.turnId,
        turnIndex: separatedGroups.get(1)!.turnIndex
      })
    ]).toEqual(['ask-scout-t-turn-1-call_0-beta', 'ask-scout-t-turn-2-call_0-gamma'])
    // Even without turn_id (older daemon), distinct turn indexes prevent collisions on reused call_0.
    expect([
      askItemId({ isRoom: false, speaker: 'scout', target: 'beta', toolId: 'call_0', turnIndex: 0 }),
      askItemId({ isRoom: false, speaker: 'scout', target: 'gamma', toolId: 'call_0', turnIndex: 1 })
    ]).toEqual(['ask-scout-n-0-call_0-beta', 'ask-scout-n-1-call_0-gamma'])
    // Two fragments in the same turn reusing call_0 for different targets get distinct list keys.
    expect([
      askItemId({ isRoom: false, speaker: 'scout', target: 'bio', toolId: 'call_0', turnId: 'T', turnIndex: 0 }),
      askItemId({ isRoom: false, speaker: 'scout', target: 'chem', toolId: 'call_0', turnId: 'T', turnIndex: 0 })
    ]).toEqual(['ask-scout-t-T-call_0-bio', 'ask-scout-t-T-call_0-chem'])
  })
})

describe('restored tools and questions', () => {
  it('keeps a visual call and its arguments when reopening a section', () => {
    const messages = historyMessages([
      {
        role: 'assistant',
        text: '',
        tool_calls: [
          {
            id: 'chart',
            function: { arguments: JSON.stringify({ title: 'Revenue', html: '<p>42</p>' }) }
          }
        ]
      },
      { role: 'tool', name: 'hexbot_show_html', tool_call_id: 'chart', text: '{"shown":true}' },
      { role: 'assistant', text: 'Revenue rose.' }
    ])
    expect(messages[0].tools?.[0]).toMatchObject({
      name: 'hexbot_show_html',
      args: { html: '<p>42</p>' },
      status: 'ok'
    })
  })
  it('brings back the files you sent and the media a bot made', () => {
    const kept = '/h/runtime/sessions/s/attachments/0123456789abcdef0123456789abcdef-clip.mp4'
    const messages = historyMessages([
      { role: 'user', content: `Watch this\n\nAttached files:\n${kept}` },
      { role: 'assistant', text: '', tool_calls: [{ id: 'tts', function: { arguments: '{}' } }] },
      {
        role: 'tool',
        name: 'text_to_speech',
        tool_call_id: 'tts',
        text: '{"media":"MEDIA:/h/profiles/owl/artifacts/audio/a1.mp3","success":true}'
      },
      { role: 'assistant', text: 'Here it is.' }
    ])
    expect(messages[0]).toMatchObject({
      text: 'Watch this',
      attachments: [{ kind: 'video', name: 'clip.mp4', path: kept }]
    })
    expect(
      mediaOf(
        (messages[1].tools ?? []).map(t => ({ name: t.name, result: t.detail, status: t.status }))
      )
    ).toEqual([
      {
        kind: 'audio',
        mime: 'audio/mpeg',
        name: 'a1.mp3',
        path: '/h/profiles/owl/artifacts/audio/a1.mp3'
      }
    ])
  })
  it('restores only unanswered questions and preserves multiple-choice selection', () => {
    const state = reduceChat(
      emptyChat(),
      event('clarify.request', {
        request_id: 'batch',
        answers: { first: '' },
        questions: [
          { qid: 'first', question: 'When?' },
          { qid: 'second', question: 'Which?', choices: ['One', 'Two'], multi_select: true }
        ]
      })
    )
    expect(state.questions[0].questions).toEqual([
      { id: 'second', text: 'Which?', choices: ['One', 'Two'], multiSelect: true }
    ])
  })
  it('reads the history again when a turn finished while it loaded', () => {
    // The history already has the interim reply and its tool; the buffer holds the same turn.
    const restored = {
      ...emptyChat(),
      messages: historyMessages([
        { id: 'u', role: 'user', content: 'Look' },
        { id: 'a1', role: 'assistant', content: 'Checking.', tool_calls: [{ id: 't1' }] },
        { role: 'tool', name: 'read_file', tool_call_id: 't1', text: 'ok' }
      ])
    }
    const loaded = replayChat(restored, [
      event('message.delta', { text: 'Checking.' }),
      event('message.interim', { text: 'Checking.', already_streamed: true }),
      event('tool.start', { tool_id: 't1', name: 'read_file' }),
      event('tool.complete', { tool_id: 't1', result: 'ok' }),
      event('message.complete', { text: 'Done.' })
    ])
    expect(loaded.reread).toBe(true)
    expect(loaded.state.messages.map(m => m.text)).toEqual(['Look', 'Checking.'])
    expect(loaded.state.busy).toBe(false)
  })
  it('never drops a new reply that repeats the last one', () => {
    const restored = {
      ...emptyChat(),
      messages: historyMessages([
        { id: 'u', role: 'user', content: 'Again?' },
        { id: 'a', role: 'assistant', content: 'Yes.' }
      ])
    }
    // Finished during loading: the history is read again rather than guessing from text.
    expect(replayChat(restored, [event('message.complete', { text: 'Yes.' })]).reread).toBe(true)
    // Multiple completions buffered in one load resolve to the final turn's error state.
    const recovered = replayChat(restored, [
      event('message.complete', { error: 'provider failed', text: '' }),
      event('message.start'),
      event('message.complete', { text: 'Recovered' })
    ])
    expect(recovered.reread).toBe(true)
    expect(recovered.state.error).toBeNull()
    const failedLater = replayChat(restored, [
      event('message.complete', { text: 'First ok' }),
      event('message.start'),
      event('message.complete', { error: 'second failed', text: '' })
    ])
    expect(failedLater.reread).toBe(true)
    expect(failedLater.state.error).toBe('second failed')
    // Finished after loading: the same words are a new reply.
    const loaded = replayChat(restored, [])
    expect(loaded.reread).toBe(false)
    const next = reduceChat(
      reduceChat(loaded.state, event('message.start')),
      event('message.complete', { text: 'Yes.' })
    )
    expect(next.messages.map(m => m.text)).toEqual(['Again?', 'Yes.', 'Yes.'])
  })
  it('keeps a running turn live without repeating what the history shows', () => {
    const restored = {
      ...emptyChat(),
      busy: true,
      messages: historyMessages([
        { id: 'u', role: 'user', content: 'Look' },
        { id: 'a1', role: 'assistant', content: 'Checking.', tool_calls: [{ id: 't1' }] },
        { role: 'tool', name: 'read_file', tool_call_id: 't1', text: 'ok' }
      ])
    }
    const loaded = replayChat(restored, [
      event('message.delta', { text: 'Checking.' }),
      event('message.interim', { text: 'Checking.', already_streamed: true }),
      event('tool.start', { tool_id: 't1', name: 'read_file' }),
      event('tool.complete', { tool_id: 't1', result: 'ok' }),
      event('tool.start', { tool_id: 't2', name: 'terminal' }),
      event('message.delta', { text: 'Nearly' })
    ])
    expect(loaded.reread).toBe(false)
    expect(loaded.state.messages.map(m => m.text)).toEqual(['Look', 'Checking.'])
    expect(loaded.state.interim).toEqual([])
    expect(loaded.state.streaming).toBe('Nearly')
    expect(loaded.state.tools.map(t => t.id)).toEqual(['t2'])
    expect(loaded.state.busy).toBe(true)
  })
  it('keeps a new turn’s live tool call during replay even when an earlier turn reused the same provider tool ID', () => {
    const restored = {
      ...emptyChat(),
      messages: historyMessages([
        { id: 'u1', role: 'user', content: 'First', turn_id: 'turn-1' },
        {
          id: 'a1',
          role: 'assistant',
          content: 'Asked bio.',
          turn_id: 'turn-1',
          tool_calls: [{ id: 'call_0', function: { arguments: '{"to":"bio"}' } }]
        },
        { role: 'tool', name: 'message_bot', tool_call_id: 'call_0', text: '{"section_id":"th-bio"}', turn_id: 'turn-1' },
        { id: 'u2', role: 'user', content: 'Second', turn_id: 'turn-2' }
      ])
    }
    const loaded = replayChat(restored, [
      event('message.start', { turn_id: 'turn-2' }),
      event('tool.start', { turn_id: 'turn-2', tool_id: 'call_0', name: 'message_bot', args: { to: 'chem' } })
    ])
    expect(loaded.reread).toBe(false)
    expect(loaded.state.turnId).toBe('turn-2')
    expect(loaded.state.tools).toMatchObject([{ id: 'call_0', name: 'message_bot', status: 'running', turnId: 'turn-2' }])
  })
  it('treats a peer question as an exchange boundary during untagged replay on older daemons', () => {
    const restored = {
      ...emptyChat(),
      messages: historyMessages(
        [
          { role: 'user', content: '@scout: First peer question', hidden: true, row_id: 'q1' },
          {
            role: 'assistant',
            row_id: 'a1',
            content: 'Checked bio.',
            tool_calls: [{ id: 'call_0', function: { arguments: '{"to":"bio"}' } }]
          },
          { role: 'tool', name: 'message_bot', tool_call_id: 'call_0', text: '{"section_id":"th-bio"}' },
          { role: 'user', content: '@scout: Second peer question', hidden: true, row_id: 'q2' }
        ],
        'scout'
      )
    }
    const loaded = replayChat(restored, [
      event('message.start'),
      event('tool.start', { tool_id: 'call_0', name: 'message_bot', args: { to: 'chem' } })
    ])
    expect(loaded.reread).toBe(false)
    expect(loaded.state.tools).toMatchObject([{ id: 'call_0', name: 'message_bot', status: 'running' }])
  })
  it('marks unfinished asks as failed on error completions while preserving already-completed asks', () => {
    // Ordinary reduceChat: Pi emits error followed by message.complete while call_2 is still running.
    let s = reduceChat(emptyChat(), event('message.start', { turn_id: 'turn-err' }))
    s = reduceChat(s, event('tool.start', { turn_id: 'turn-err', tool_id: 'call_1', name: 'message_bot', args: { to: 'bio' } }))
    s = reduceChat(s, event('tool.complete', { turn_id: 'turn-err', tool_id: 'call_1', result: { section_id: 'th-bio' } }))
    s = reduceChat(s, event('tool.start', { turn_id: 'turn-err', tool_id: 'call_2', name: 'message_bot', args: { to: 'chem' } }))
    s = reduceChat(s, event('error', { message: 'Pi exited' }))
    s = reduceChat(s, event('message.complete', { turn_id: 'turn-err', error: 'Pi exited', text: '' }))
    expect(s.messages[0]?.tools).toMatchObject([
      { id: 'call_1', status: 'ok', turnId: 'turn-err' },
      { id: 'call_2', status: 'error', turnId: 'turn-err' }
    ])

    // Replay path: unfinished ask settles to error (never ok), completed ask stays ok.
    const replayed = replayChat(emptyChat(), [
      event('message.start', { turn_id: 'turn-err-2' }),
      event('tool.start', { turn_id: 'turn-err-2', tool_id: 'call_1', name: 'message_bot', args: { to: 'bio' } }),
      event('tool.complete', { turn_id: 'turn-err-2', tool_id: 'call_1', result: { section_id: 'th-bio' } }),
      event('tool.start', { turn_id: 'turn-err-2', tool_id: 'call_2', name: 'message_bot', args: { to: 'chem' } }),
      event('error', { message: 'Pi exited' }),
      event('message.complete', { turn_id: 'turn-err-2', error: 'Pi exited', text: '' })
    ])
    expect(replayed.reread).toBe(true)
    expect(replayed.state.completingAsks?.['']).toMatchObject([
      { id: 'call_1', status: 'ok', turnId: 'turn-err-2' },
      { id: 'call_2', status: 'error', turnId: 'turn-err-2' }
    ])
  })
  it('treats an untagged message.start as a new exchange during replay when the second peer question is not in history yet', () => {
    const restored = {
      ...emptyChat(),
      messages: historyMessages(
        [
          { role: 'user', content: '@scout: First peer question', hidden: true, row_id: 'q1' },
          {
            role: 'assistant',
            row_id: 'a1',
            content: 'Checked bio.',
            tool_calls: [{ id: 'call_0', function: { arguments: '{"to":"bio"}' } }]
          },
          { role: 'tool', name: 'message_bot', tool_call_id: 'call_0', text: '{"section_id":"th-bio"}' }
        ],
        'scout'
      )
    }
    const loaded = replayChat(restored, [
      event('message.start'),
      event('tool.start', { tool_id: 'call_0', name: 'message_bot', args: { to: 'chem' } })
    ])
    expect(loaded.reread).toBe(false)
    expect(loaded.state.startedFresh).toBe(true)
    expect(loaded.state.tools).toMatchObject([{ id: 'call_0', name: 'message_bot', status: 'running' }])
  })
  it('keeps distinct same-turn asks across fragments reusing call_0 through reduceChat, replayChat, mergeTurnTools, and unconfirmedTurnTools', () => {
    let s = reduceChat(emptyChat(), event('message.start', { turn_id: 'T' }))
    s = reduceChat(
      s,
      event('tool.start', { turn_id: 'T', message_id: 'frag-a', tool_id: 'call_0', name: 'message_bot', args: { to: 'bio' } })
    )
    s = reduceChat(
      s,
      event('tool.complete', { turn_id: 'T', message_id: 'frag-a', tool_id: 'call_0', result: { section_id: 'th-bio' } })
    )
    s = reduceChat(
      s,
      event('tool.start', { turn_id: 'T', message_id: 'frag-b', tool_id: 'call_0', name: 'message_bot', args: { to: 'chem' } })
    )
    expect(s.tools).toMatchObject([
      { id: 'call_0', row: 'frag-a', status: 'ok', args: { to: 'bio' } },
      { id: 'call_0', row: 'frag-b', status: 'running', args: { to: 'chem' } }
    ])

    // Biology-only history does not suppress Chemistry during replay or clear Chemistry from held asks.
    const bioOnlyHistory = historyMessages([
      {
        role: 'assistant',
        row_id: 'frag-a',
        text: 'Checked bio.',
        turn_id: 'T',
        tool_calls: [{ id: 'call_0', function: { arguments: '{"to":"bio"}' } }]
      },
      { role: 'tool', name: 'message_bot', tool_call_id: 'call_0', text: '{"section_id":"th-bio"}', turn_id: 'T' }
    ])
    const replayed = replayChat({ ...emptyChat(), messages: bioOnlyHistory }, [
      event('tool.start', { turn_id: 'T', message_id: 'frag-a', tool_id: 'call_0', name: 'message_bot', args: { to: 'bio' } }),
      event('tool.complete', { turn_id: 'T', message_id: 'frag-a', tool_id: 'call_0', result: { section_id: 'th-bio' } }),
      event('tool.start', { turn_id: 'T', message_id: 'frag-b', tool_id: 'call_0', name: 'message_bot', args: { to: 'chem' } }),
      event('tool.complete', { turn_id: 'T', message_id: 'frag-b', tool_id: 'call_0', result: { section_id: 'th-chem' } })
    ])
    expect(replayed.state.tools).toMatchObject([
      { id: 'call_0', row: 'frag-b', status: 'ok', args: { to: 'chem' } }
    ])

    const merged = mergeTurnTools(bioOnlyHistory[0]!.tools!, replayed.state.tools)
    expect(merged).toHaveLength(2)
    expect(unconfirmedTurnTools(merged, bioOnlyHistory)).toMatchObject([
      { id: 'call_0', row: 'frag-b', args: { to: 'chem' } }
    ])
  })
  it('retains both untagged completions buffered during one stale read when they reuse call_0', () => {
    const staleHistory = historyMessages(
      [
        { role: 'user', content: '@scout: Prior', hidden: true, row_id: 'q0' },
        { role: 'assistant', row_id: 'a0', content: 'Prior reply.' }
      ],
      'scout'
    )
    const replayed = replayChat({ ...emptyChat(), messages: staleHistory }, [
      event('message.start'),
      event('tool.start', { tool_id: 'call_0', name: 'message_bot', args: { to: 'bio' } }),
      event('tool.complete', { tool_id: 'call_0', result: { section_id: 'th-bio' } }),
      event('message.complete', { text: 'Bio done.' }),
      event('message.start'),
      event('tool.start', { tool_id: 'call_0', name: 'message_bot', args: { to: 'chem' } }),
      event('tool.complete', { tool_id: 'call_0', result: { section_id: 'th-chem' } }),
      event('message.complete', { text: 'Chem done.' })
    ])
    expect(replayed.reread).toBe(true)
    const held = replayed.state.completingAsks?.[''] ?? []
    expect(held).toMatchObject([
      { id: 'call_0', args: { to: 'bio' }, afterHistoryCount: 2 },
      { id: 'call_0', args: { to: 'chem' }, afterHistoryCount: 2 }
    ])
    expect(held[0]!.freshExchange).not.toBe(held[1]!.freshExchange)

    // Stale read retains both; partial read confirming only Bio retains Chem.
    expect(unconfirmedTurnTools(held, staleHistory)).toHaveLength(2)
    const bioPersisted = historyMessages(
      [
        { role: 'user', content: '@scout: Prior', hidden: true, row_id: 'q0' },
        { role: 'assistant', row_id: 'a0', content: 'Prior reply.' },
        { role: 'user', content: '@scout: Bio q', hidden: true, row_id: 'q1' },
        {
          role: 'assistant',
          row_id: 'a1',
          content: 'Bio done.',
          tool_calls: [{ id: 'call_0', function: { arguments: '{"to":"bio"}' } }]
        },
        { role: 'tool', name: 'message_bot', tool_call_id: 'call_0', text: '{"section_id":"th-bio"}' }
      ],
      'scout'
    )
    expect(unconfirmedTurnTools(held, bioPersisted)).toMatchObject([
      { id: 'call_0', args: { to: 'chem' } }
    ])
    // Once a single read contains BOTH Biology and Chemistry, both clear with zero duplicate left held.
    const bothPersisted = historyMessages(
      [
        { role: 'user', content: '@scout: Prior', hidden: true, row_id: 'q0' },
        { role: 'assistant', row_id: 'a0', content: 'Prior reply.' },
        { role: 'user', content: '@scout: Bio q', hidden: true, row_id: 'q1' },
        {
          role: 'assistant',
          row_id: 'a1',
          content: 'Bio done.',
          tool_calls: [{ id: 'call_0', function: { arguments: '{"to":"bio"}' } }]
        },
        { role: 'tool', name: 'message_bot', tool_call_id: 'call_0', text: '{"section_id":"th-bio"}' },
        { role: 'user', content: '@scout: Chem q', hidden: true, row_id: 'q2' },
        {
          role: 'assistant',
          row_id: 'a2',
          content: 'Chem done.',
          tool_calls: [{ id: 'call_0', function: { arguments: '{"to":"chem"}' } }]
        },
        { role: 'tool', name: 'message_bot', tool_call_id: 'call_0', text: '{"section_id":"th-chem"}' }
      ],
      'scout'
    )
    expect(unconfirmedTurnTools(held, bothPersisted)).toEqual([])
  })
  it('never confirms two identical untagged Biology asks with one stored result across repeated stale reads', () => {
    const stale = historyMessages(
      [
        { role: 'user', content: '@scout: Prior', hidden: true, row_id: 'q0' },
        { role: 'assistant', row_id: 'a0', content: 'Prior reply.' }
      ],
      'scout'
    )
    const replayed = replayChat({ ...emptyChat(), messages: stale }, [
      event('message.start'),
      event('tool.start', { tool_id: 'call_0', name: 'message_bot', args: { to: 'bio' } }),
      event('tool.complete', { tool_id: 'call_0', result: { section_id: 'th-bio' } }),
      event('message.complete', { text: 'First bio.' }),
      event('message.start'),
      event('tool.start', { tool_id: 'call_0', name: 'message_bot', args: { to: 'bio' } }),
      event('tool.complete', { tool_id: 'call_0', result: { section_id: 'th-bio' } }),
      event('message.complete', { text: 'Second bio.' })
    ])
    const held = replayed.state.completingAsks?.[''] ?? []
    expect(held).toHaveLength(2)

    const onlyFirstPersisted = historyMessages(
      [
        { role: 'user', content: '@scout: Prior', hidden: true, row_id: 'q0' },
        { role: 'assistant', row_id: 'a0', content: 'Prior reply.' },
        { role: 'user', content: '@scout: First', hidden: true, row_id: 'q1' },
        {
          role: 'assistant',
          row_id: 'a1',
          content: 'First bio.',
          tool_calls: [{ id: 'call_0', function: { arguments: '{"to":"bio"}' } }]
        },
        { role: 'tool', name: 'message_bot', tool_call_id: 'call_0', text: '{"section_id":"th-bio"}' }
      ],
      'scout'
    )
    const afterFirstRead = unconfirmedTurnTools(held, onlyFirstPersisted)
    expect(afterFirstRead).toHaveLength(1)
    // Re-reading the exact same partial snapshot MUST keep the second ask held (1 -> 1, not 1 -> 0).
    const afterRepeatedRead = unconfirmedTurnTools(afterFirstRead, onlyFirstPersisted)
    expect(afterRepeatedRead).toHaveLength(1)

    const bothPersisted = historyMessages(
      [
        { role: 'user', content: '@scout: Prior', hidden: true, row_id: 'q0' },
        { role: 'assistant', row_id: 'a0', content: 'Prior reply.' },
        { role: 'user', content: '@scout: First', hidden: true, row_id: 'q1' },
        {
          role: 'assistant',
          row_id: 'a1',
          content: 'First bio.',
          tool_calls: [{ id: 'call_0', function: { arguments: '{"to":"bio"}' } }]
        },
        { role: 'tool', name: 'message_bot', tool_call_id: 'call_0', text: '{"section_id":"th-bio"}' },
        { role: 'user', content: '@scout: Second', hidden: true, row_id: 'q2' },
        {
          role: 'assistant',
          row_id: 'a2',
          content: 'Second bio.',
          tool_calls: [{ id: 'call_0', function: { arguments: '{"to":"bio"}' } }]
        },
        { role: 'tool', name: 'message_bot', tool_call_id: 'call_0', text: '{"section_id":"th-bio"}' }
      ],
      'scout'
    )
    expect(unconfirmedTurnTools(afterRepeatedRead, bothPersisted)).toEqual([])
  })
  it('does not attach an ambiguous same-turn tool result to the wrong fragment or suppress Chemistry during replay', () => {
    const ambiguousHistory = historyMessages([
      {
        role: 'assistant',
        row_id: 'frag-a',
        text: 'Asked bio.',
        turn_id: 'T',
        tool_calls: [{ id: 'call_0', function: { arguments: '{"to":"bio"}' } }]
      },
      {
        role: 'assistant',
        row_id: 'frag-b',
        text: 'Asking chem.',
        turn_id: 'T',
        tool_calls: [{ id: 'call_0', function: { arguments: '{"to":"chem"}' } }]
      },
      {
        role: 'tool',
        name: 'message_bot',
        tool_call_id: 'call_0',
        context: 'bio',
        text: '{"section_id":"th-bio"}',
        turn_id: 'T'
      }
    ])
    // Biology's ambiguous result must NOT inherit frag-b's row or Chemistry's args.
    const storedTools = ambiguousHistory.flatMap(m => m.tools ?? [])
    expect(storedTools).toHaveLength(1)
    expect(storedTools[0]!.row).toBeUndefined()
    expect(storedTools[0]!.args).toBeUndefined()
    expect(storedTools[0]!.action).toBe('bio')

    // Replaying Chemistry's live call in frag-b keeps Chemistry instead of dropping it.
    const replayed = replayChat({ ...emptyChat(), messages: ambiguousHistory }, [
      event('tool.start', { turn_id: 'T', message_id: 'frag-b', tool_id: 'call_0', name: 'message_bot', args: { to: 'chem' } })
    ])
    expect(replayed.state.tools).toMatchObject([
      { id: 'call_0', row: 'frag-b', status: 'running', args: { to: 'chem' } }
    ])
  })
  it('preserves both untagged asks reusing call_0 within one turn across replay completion', () => {
    const replayed = replayChat(emptyChat(), [
      event('message.start'),
      event('tool.start', { tool_id: 'call_0', name: 'message_bot', args: { to: 'biology' } }),
      event('tool.complete', { tool_id: 'call_0', name: 'message_bot', result: { section_id: 'th-bio' } }),
      event('tool.start', { tool_id: 'call_0', name: 'message_bot', args: { to: 'chemistry' } }),
      event('tool.complete', { tool_id: 'call_0', name: 'message_bot', result: { section_id: 'th-chem' } }),
      event('message.complete', { text: 'Checked both.' })
    ])
    expect(
      (replayed.state.completingAsks?.[''] ?? []).map(t => (t.args as { to?: string })?.to)
    ).toEqual(['biology', 'chemistry'])
  })
  it('does not hold a duplicate legacy ask when replay events match an exchange already in the snapshot', () => {
    const stored = historyMessages(
      [
        { role: 'user', content: '@scout: Check bio', hidden: true, row_id: 'q1' },
        {
          role: 'assistant',
          row_id: 'a1',
          content: 'Done.',
          tool_calls: [{ id: 'call_0', function: { arguments: '{"to":"bio"}' } }]
        },
        { role: 'tool', name: 'message_bot', tool_call_id: 'call_0', text: '{"section_id":"th-bio"}' }
      ],
      'scout'
    )
    const replayed = replayChat({ ...emptyChat(), messages: stored }, [
      event('message.start'),
      event('tool.start', { tool_id: 'call_0', name: 'message_bot', args: { to: 'bio' } }),
      event('tool.complete', { tool_id: 'call_0', name: 'message_bot', result: { section_id: 'th-bio' } }),
      event('message.complete', { text: 'Done.' })
    ])
    const held = replayed.state.completingAsks?.[''] ?? []
    expect(held).toEqual([])
    expect(unconfirmedTurnTools(held, stored)).toEqual([])
  })
  it('records a completed ask when tool.complete arrives without an earlier tool.start', () => {
    const next = reduceChat(
      emptyChat(),
      event('tool.complete', {
        tool_id: 'call_0',
        name: 'message_bot',
        context: 'biology',
        result: { details: { section_id: 'th-bio', status: 'replied' } }
      })
    )
    expect(next.tools).toMatchObject([
      { id: 'call_0', name: 'message_bot', action: 'biology', status: 'ok' }
    ])
  })
  it('keeps concurrent untagged running calls reusing call_0 ambiguous instead of swapping thread ids', () => {
    let s = reduceChat(emptyChat(), event('message.start'))
    s = reduceChat(
      s,
      event('tool.start', { tool_id: 'call_0', name: 'message_bot', args: { to: 'biology' } })
    )
    s = reduceChat(
      s,
      event('tool.start', { tool_id: 'call_0', name: 'message_bot', args: { to: 'chemistry' } })
    )
    s = reduceChat(
      s,
      event('tool.complete', {
        tool_id: 'call_0',
        name: 'message_bot',
        result: { details: { section_id: 'th-biology' } }
      })
    )
    // Neither running call may steal the other's section id while two matching calls are running.
    expect(s.tools).toHaveLength(2)
    expect(s.tools.map(t => ({ detail: t.detail, status: t.status, to: (t.args as { to?: string })?.to }))).toEqual([
      { detail: '', status: 'running', to: 'biology' },
      { detail: '', status: 'running', to: 'chemistry' }
    ])
  })
  it('restores unmatched message_bot declarations for the active turn when opening a busy chat mid-call', () => {
    const raw = [
      { role: 'user', text: 'Earlier' },
      {
        role: 'assistant',
        row_id: 'old-a',
        text: 'Old.',
        turn_id: 'T0',
        tool_calls: [{ id: 'call_0', function: { name: 'message_bot', arguments: '{"to":"old"}' } }]
      },
      { role: 'user', text: 'Ask Biology' },
      {
        role: 'assistant',
        row_id: 'a1',
        text: 'Checking.',
        turn_id: 'T1',
        tool_calls: [
          { id: 'call_0', function: { name: 'message_bot', arguments: '{"to":"chem"}' } },
          { id: 'call_1', function: { name: 'message_bot', arguments: '{"to":"bio"}' } }
        ]
      },
      {
        role: 'tool',
        name: 'message_bot',
        tool_call_id: 'call_0',
        turn_id: 'T1',
        text: '{"section_id":"th-chem"}'
      }
    ]
    const pending = pendingTurnTools(raw)
    expect(pending).toMatchObject([
      { id: 'call_1', name: 'message_bot', row: 'a1', turnId: 'T1', status: 'running', args: { to: 'bio' } }
    ])
    // Reconciles cleanly when tool.complete arrives without args.
    const next = reduceChat(
      { ...emptyChat(), busy: true, messages: historyMessages(raw), tools: pending, turnId: 'T1' },
      event('tool.complete', {
        turn_id: 'T1',
        message_id: 'a1',
        tool_id: 'call_1',
        name: 'message_bot',
        result: { details: { section_id: 'th-bio', status: 'replied' } }
      })
    )
    expect(next.tools).toMatchObject([
      { id: 'call_1', name: 'message_bot', row: 'a1', status: 'ok', args: { to: 'bio' } }
    ])

    // An earlier non-message_bot tool (web_search) reusing call_0 with context "biology"
    // must NOT match and hide an active message_bot(to: "biology") declaration.
    const mixedRaw = [
      { role: 'user', text: 'Search then ask Biology' },
      {
        role: 'assistant',
        row_id: 's1',
        text: 'Searching.',
        turn_id: 'T2',
        tool_calls: [{ id: 'call_0', function: { name: 'web_search', arguments: '{"query":"biology"}' } }]
      },
      {
        role: 'tool',
        name: 'web_search',
        tool_call_id: 'call_0',
        context: 'biology',
        turn_id: 'T2',
        text: 'search results'
      },
      {
        role: 'assistant',
        row_id: 's2',
        text: 'Asking.',
        turn_id: 'T2',
        tool_calls: [{ id: 'call_0', function: { name: 'message_bot', arguments: '{"to":"biology"}' } }]
      }
    ]
    expect(pendingTurnTools(mixedRaw)).toMatchObject([
      { id: 'call_0', name: 'message_bot', row: 's2', turnId: 'T2', status: 'running', args: { to: 'biology' } }
    ])

    // Same-turn completed web_search on call_0 must NOT drop a buffered message_bot(to: "biology")
    // during replayChat or clear a held Biology completion in unconfirmedTurnTools.
    const searchOnlySnapshot = historyMessages([
      { role: 'user', text: 'Search then ask Biology' },
      {
        role: 'assistant',
        row_id: 's1',
        text: 'Searching.',
        turn_id: 'T2',
        tool_calls: [{ id: 'call_0', function: { name: 'web_search', arguments: '{"query":"biology"}' } }]
      },
      {
        role: 'tool',
        name: 'web_search',
        tool_call_id: 'call_0',
        context: 'biology',
        turn_id: 'T2',
        text: 'search results'
      }
    ])
    const replayedRunning = replayChat({ ...emptyChat(), busy: true, messages: searchOnlySnapshot }, [
      event('tool.start', {
        turn_id: 'T2',
        tool_id: 'call_0',
        name: 'message_bot',
        args: { to: 'biology' }
      })
    ])
    expect(replayedRunning.state.tools).toMatchObject([
      { id: 'call_0', name: 'message_bot', status: 'running', args: { to: 'biology' } }
    ])

    const replayedComplete = replayChat({ ...emptyChat(), busy: true, messages: searchOnlySnapshot }, [
      event('tool.start', {
        turn_id: 'T2',
        tool_id: 'call_0',
        name: 'message_bot',
        args: { to: 'biology' }
      }),
      event('tool.complete', {
        turn_id: 'T2',
        tool_id: 'call_0',
        name: 'message_bot',
        context: 'biology',
        result: { details: { section_id: 'th-bio', status: 'replied' } }
      }),
      event('message.complete', { turn_id: 'T2', text: 'Done.' })
    ])
    const heldBio = replayedComplete.state.completingAsks?.[''] ?? []
    expect(heldBio).toHaveLength(1)
    expect(unconfirmedTurnTools(heldBio, searchOnlySnapshot)).toHaveLength(1)

    // A still-running Chemistry ask on call_0 must NOT bind an untagged Biology completion on call_0.
    let runningChem = reduceChat(emptyChat(), event('message.start', { turn_id: 'T3' }))
    runningChem = reduceChat(
      runningChem,
      event('tool.start', {
        turn_id: 'T3',
        message_id: 'a1',
        tool_id: 'call_0',
        name: 'message_bot',
        args: { to: 'chemistry' }
      })
    )
    runningChem = reduceChat(
      runningChem,
      event('tool.complete', {
        turn_id: 'T3',
        tool_id: 'call_0',
        name: 'message_bot',
        context: 'biology',
        result: { details: { section_id: 'th-bio', status: 'replied' } }
      })
    )
    expect(runningChem.tools).toMatchObject([
      { id: 'call_0', row: 'a1', status: 'running', args: { to: 'chemistry' }, detail: '' },
      { id: 'call_0', status: 'ok', action: 'biology' }
    ])

    // An earlier wait:false ("Messaged") Biology send on call_0 must NOT drop or prematurely clear
    // a later wait:true ("Message from") Biology reply reusing call_0 without message_id.
    const sentOnlySnapshot = historyMessages([
      { role: 'user', text: 'Ping then ask Biology' },
      {
        role: 'assistant',
        row_id: 'b1',
        text: 'Notified.',
        turn_id: 'T4',
        tool_calls: [{ id: 'call_0', function: { name: 'message_bot', arguments: '{"to":"biology","wait":false}' } }]
      },
      {
        role: 'tool',
        name: 'message_bot',
        tool_call_id: 'call_0',
        context: 'biology',
        turn_id: 'T4',
        text: '{"status":"sent","section_id":"th-bio"}'
      }
    ])
    const replayedReply = replayChat({ ...emptyChat(), busy: true, messages: sentOnlySnapshot }, [
      event('tool.start', {
        turn_id: 'T4',
        tool_id: 'call_0',
        name: 'message_bot',
        args: { to: 'biology' }
      }),
      event('tool.complete', {
        turn_id: 'T4',
        tool_id: 'call_0',
        name: 'message_bot',
        context: 'biology',
        result: { details: { section_id: 'th-bio', status: 'replied' } }
      }),
      event('message.complete', { turn_id: 'T4', text: 'Biology answered.' })
    ])
    const heldReply = replayedReply.state.completingAsks?.[''] ?? []
    expect(heldReply).toHaveLength(1)
    expect(unconfirmedTurnTools(heldReply, sentOnlySnapshot)).toHaveLength(1)

    // 1. Settled wait:true Biology reply must NOT be overwritten by a later missed-start
    //    untagged wait:false send reusing call_0 on the same section; both survive.
    let bioState = reduceChat(emptyChat(), event('message.start', { turn_id: 'T5' }))
    bioState = reduceChat(
      bioState,
      event('tool.start', {
        turn_id: 'T5',
        message_id: 'a1',
        tool_id: 'call_0',
        name: 'message_bot',
        context: 'biology',
        args: { to: 'biology', wait: true }
      })
    )
    bioState = reduceChat(
      bioState,
      event('tool.complete', {
        turn_id: 'T5',
        message_id: 'a1',
        tool_id: 'call_0',
        name: 'message_bot',
        context: 'biology',
        result: { details: { section_id: 'th-bio', status: 'replied' } }
      })
    )
    bioState = reduceChat(
      bioState,
      event('tool.complete', {
        turn_id: 'T5',
        tool_id: 'call_0',
        name: 'message_bot',
        context: 'biology',
        result: { details: { section_id: 'th-bio', status: 'sent' } }
      })
    )
    expect(bioState.tools).toHaveLength(2)
    expect(
      asksOf(
        bioState.tools.map(t => ({
          args: t.args,
          name: t.name,
          result: t.detail,
          status: t.status,
          summary: t.action
        }))
      )
    ).toEqual([{ sectionId: 'th-bio', sent: false, status: 'ok', target: 'biology' }])

    // 2. Replaying a buffered untagged tool.start + tool.complete onto a busy snapshot that
    //    hydrated Biology call_0 on fragment a2 upgrades a2 in place and settles it cleanly.
    const busyReuseRows = [
      { role: 'user', content: 'Check both' },
      {
        role: 'assistant',
        row_id: 'a1',
        turn_id: 'T6',
        content: 'Asked Chem.',
        tool_calls: [{ id: 'call_0', function: { name: 'message_bot', arguments: '{"to":"chemistry"}' } }]
      },
      {
        role: 'tool',
        tool_call_id: 'call_0',
        message_id: 'a1',
        turn_id: 'T6',
        name: 'message_bot',
        context: 'chemistry',
        text: '{"reply":"Chem ok","section_id":"th-chem"}'
      },
      {
        role: 'assistant',
        row_id: 'a2',
        turn_id: 'T6',
        content: 'Asking Bio.',
        tool_calls: [{ id: 'call_0', function: { name: 'message_bot', arguments: '{"to":"biology"}' } }]
      }
    ]
    const busyReuseState: ChatState = {
      ...emptyChat(),
      busy: true,
      turnId: 'T6',
      messages: historyMessages(busyReuseRows),
      tools: pendingTurnTools(busyReuseRows)
    }
    const replayedBio = replayChat(busyReuseState, [
      event('tool.start', {
        turn_id: 'T6',
        tool_id: 'call_0',
        name: 'message_bot',
        context: 'biology',
        args: { to: 'biology' }
      }),
      event('tool.complete', {
        turn_id: 'T6',
        tool_id: 'call_0',
        name: 'message_bot',
        context: 'biology',
        result: { details: { section_id: 'th-bio', status: 'replied' } }
      })
    ])
    expect(replayedBio.state.tools).toHaveLength(1)
    expect(replayedBio.state.tools[0]).toMatchObject({
      id: 'call_0',
      name: 'message_bot',
      row: 'a2',
      status: 'ok'
    })

    // 3. An untagged Biology tool.start must NOT overwrite a hydrated Chemistry placeholder on a1.
    const chemPendingRows = [
      { role: 'user', content: 'Check chem' },
      {
        role: 'assistant',
        row_id: 'a1',
        turn_id: 'T7',
        content: 'Asking Chem.',
        tool_calls: [{ id: 'call_0', function: { name: 'message_bot', arguments: '{"to":"chemistry"}' } }]
      }
    ]
    const chemPending: ChatState = {
      ...emptyChat(),
      busy: true,
      turnId: 'T7',
      messages: historyMessages(chemPendingRows),
      tools: pendingTurnTools(chemPendingRows)
    }
    const afterBioStart = reduceChat(
      chemPending,
      event('tool.start', {
        turn_id: 'T7',
        tool_id: 'call_0',
        name: 'message_bot',
        context: 'biology',
        args: { to: 'biology' }
      })
    )
    expect(afterBioStart.tools).toMatchObject([
      { args: { to: 'chemistry' }, id: 'call_0', row: 'a1', status: 'running' },
      { args: { to: 'biology' }, id: 'call_0', status: 'running' }
    ])

    // 4. Replaying a second Biology ask reusing call_0 without message_id onto a snapshot that
    //    holds Biology #1 (proven row a1) keeps the new ask running (both with differing question
    //    text and when text is identical/omitted) and settles it cleanly on tool.complete.
    const bioFirstDoneRows = [
      { role: 'user', content: 'Ask Biology twice' },
      {
        role: 'assistant',
        row_id: 'a1',
        turn_id: 'T8',
        content: 'First ask.',
        tool_calls: [
          {
            id: 'call_0',
            function: {
              name: 'message_bot',
              arguments: '{"to":"biology","text":"first question","wait":true}'
            }
          }
        ]
      },
      {
        role: 'tool',
        tool_call_id: 'call_0',
        turn_id: 'T8',
        name: 'message_bot',
        context: 'biology',
        text: '{"reply":"First answer","section_id":"th-bio"}'
      }
    ]
    const bioFirstDoneState: ChatState = {
      ...emptyChat(),
      busy: true,
      turnId: 'T8',
      messages: historyMessages(bioFirstDoneRows)
    }
    const followUpDiffText = replayChat(bioFirstDoneState, [
      event('tool.start', {
        turn_id: 'T8',
        tool_id: 'call_0',
        name: 'message_bot',
        context: 'biology',
        args: { to: 'biology', text: 'follow-up question', wait: true }
      })
    ])
    expect(followUpDiffText.state.tools).toMatchObject([
      {
        id: 'call_0',
        name: 'message_bot',
        status: 'running',
        args: { to: 'biology', text: 'follow-up question', wait: true }
      }
    ])

    const followUpSameText = replayChat(bioFirstDoneState, [
      event('tool.start', {
        turn_id: 'T8',
        tool_id: 'call_0',
        name: 'message_bot',
        context: 'biology',
        args: { to: 'biology', text: 'first question', wait: true }
      })
    ])
    expect(followUpSameText.state.tools).toMatchObject([
      { id: 'call_0', name: 'message_bot', status: 'running' }
    ])
    const followUpSettled = replayChat(bioFirstDoneState, [
      event('tool.start', {
        turn_id: 'T8',
        tool_id: 'call_0',
        name: 'message_bot',
        context: 'biology',
        args: { to: 'biology', wait: true }
      }),
      event('tool.complete', {
        turn_id: 'T8',
        tool_id: 'call_0',
        name: 'message_bot',
        context: 'biology',
        result: { details: { section_id: 'th-bio', status: 'replied' } }
      })
    ])
    expect(followUpSettled.state.tools).toMatchObject([
      { id: 'call_0', name: 'message_bot', status: 'ok' }
    ])
  })
})
describe('message times', () => {
  it('come from history rows, in milliseconds, and are left out when unknown', () => {
    const rows = [
      { role: 'user', text: 'Morning', timestamp: 1_793_340_000.5 },
      { role: 'assistant', text: 'Hi' }
    ]
    expect(historyMessages(rows).map(m => m.createdAt)).toEqual([1_793_340_000_500, undefined])
  })
  it('stamp a reply when it finishes', () => {
    const now = Date.now()
    const done = reduceChat(emptyChat(), event('message.complete', { text: 'Done.' }))
    expect(done.messages[0]?.createdAt).toBeGreaterThanOrEqual(now)
  })
})
describe('heartbeat messages', () => {
  it('join the open thread once', () => {
    const once = heartbeatMessage(emptyChat(), 'heartbeat-1', 'BA 286 is two hours late.')
    expect(once.messages).toEqual([
      {
        id: 'heartbeat-1',
        role: 'assistant',
        // Its history row, so it takes a reaction like any message.
        rowId: 'heartbeat-1',
        text: 'BA 286 is two hours late.',
        createdAt: expect.any(Number)
      }
    ])
    expect(heartbeatMessage(once, 'heartbeat-1', 'BA 286 is two hours late.')).toBe(once)
    // Already in the history it loaded, under the same row id.
    const loaded = {
      ...emptyChat(),
      messages: historyMessages([{ role: 'assistant', text: 'Hi', row_id: 'heartbeat-2' }])
    }
    expect(heartbeatMessage(loaded, 'heartbeat-2', 'Hi')).toBe(loaded)
  })
})

describe('sharedFiles', () => {
  it('lists the files a bot shared once each, not the ones it only wrote', () => {
    const tool = (id: string, name: string, path: string, status: 'ok' | 'error' = 'ok') => ({
      args: JSON.stringify({ path }),
      detail: '',
      id,
      name,
      status
    })
    expect(
      sharedFiles([
        tool('a', 'write', '/work/make_audiobook.py'),
        tool('b', 'hexbot_share_file', '/work/chapter-1.mp3'),
        tool('c', 'hexbot_share_file', '/work/chapter-1.mp3'),
        tool('d', 'hexbot_share_file', '/s/attachments/4157abc3ebd7498086605acf7dd52ace-notes.md'),
        tool('e', 'hexbot_share_file', '/work/missing.md', 'error')
      ])
    ).toEqual([
      { name: 'chapter-1.mp3', path: '/work/chapter-1.mp3' },
      { name: 'notes.md', path: '/s/attachments/4157abc3ebd7498086605acf7dd52ace-notes.md' }
    ])
  })
})

describe('nested_calls history restoration', () => {
  it('restores nested codemode message_bot asks with wait:false status and section_id', () => {
    const messages = historyMessages([
      { role: 'user', text: 'Notify both teammates' },
      {
        role: 'assistant',
        row_id: 'a1',
        turn_id: 'T1',
        text: '',
        tool_calls: [{ id: 'code', function: { name: 'codemode', arguments: '{}' } }]
      },
      {
        role: 'tool',
        row_id: 't1',
        turn_id: 'T1',
        name: 'codemode',
        tool_id: 'code',
        text: 'ok',
        nested_calls: {
          calls: [
            {
              id: 'code/1',
              name: 'message_bot',
              arguments: { to: 'biology', text: 'FYI', wait: false },
              status: 'ok',
              durationMs: 12
            },
            {
              id: 'code/2',
              name: 'message_bot',
              arguments: { to: 'chemistry', text: 'FYI', wait: false },
              section_id: 'th-chem',
              status: 'ok',
              durationMs: 15
            }
          ]
        }
      }
    ])
    const tools = messages.flatMap(m => m.tools ?? [])
    expect(tools).toMatchObject([
      { id: 'code', name: 'codemode', status: 'ok' },
      { id: 'code/1', name: 'message_bot', parentToolCallId: 'code', status: 'ok' },
      { id: 'code/2', name: 'message_bot', parentToolCallId: 'code', status: 'ok' }
    ])
    expect(
      asksOf(
        tools.map(t => ({
          args: t.args,
          name: t.name,
          result: t.detail,
          status: t.status,
          summary: t.action
        }))
      )
    ).toEqual([
      { sectionId: null, sent: true, status: 'ok', target: 'biology' },
      { sectionId: 'th-chem', sent: true, status: 'ok', target: 'chemistry' }
    ])
  })

  it('keeps parallel same-fragment call_0 asks distinct when Chemistry finishes before Biology', () => {
    let s = reduceChat(emptyChat(), event('message.start', { turn_id: 'T-par' }))
    s = reduceChat(
      s,
      event('tool.start', {
        turn_id: 'T-par',
        message_id: 'a1',
        tool_id: 'call_0',
        name: 'message_bot',
        context: 'biology',
        args: { to: 'biology', text: 'Q1', wait: true }
      })
    )
    s = reduceChat(
      s,
      event('tool.start', {
        turn_id: 'T-par',
        message_id: 'a1',
        tool_id: 'call_0',
        name: 'message_bot',
        context: 'chemistry',
        args: { to: 'chemistry', text: 'Q2', wait: true }
      })
    )
    s = reduceChat(
      s,
      event('tool.complete', {
        turn_id: 'T-par',
        message_id: 'a1',
        tool_id: 'call_0',
        name: 'message_bot',
        context: 'chemistry',
        args: { to: 'chemistry', text: 'Q2', wait: true },
        result: { details: { reply: 'chem reply', section_id: 'th-chem' } }
      })
    )
    s = reduceChat(
      s,
      event('tool.complete', {
        turn_id: 'T-par',
        message_id: 'a1',
        tool_id: 'call_0',
        name: 'message_bot',
        context: 'biology',
        args: { to: 'biology', text: 'Q1', wait: true },
        result: { details: { reply: 'bio reply', section_id: 'th-bio' } }
      })
    )
    expect(
      asksOf(
        s.tools.map(t => ({
          args: t.args,
          name: t.name,
          result: t.detail,
          status: t.status,
          summary: t.action
        }))
      )
    ).toEqual([
      { sectionId: 'th-bio', sent: false, status: 'ok', target: 'biology' },
      { sectionId: 'th-chem', sent: false, status: 'ok', target: 'chemistry' }
    ])
  })

  it('settles same-fragment call_0 asks differing only by wait on errors and keeps stored sends in mergeTurnTools', () => {
    let s = reduceChat(emptyChat(), event('message.start', { turn_id: 'T-wait' }))
    s = reduceChat(
      s,
      event('tool.start', {
        turn_id: 'T-wait',
        message_id: 'a1',
        tool_id: 'call_0',
        name: 'message_bot',
        context: 'writer',
        args: { to: 'writer', text: 'Q', wait: true }
      })
    )
    s = reduceChat(
      s,
      event('tool.start', {
        turn_id: 'T-wait',
        message_id: 'a1',
        tool_id: 'call_0',
        name: 'message_bot',
        context: 'writer',
        args: { to: 'writer', text: 'Q', wait: false }
      })
    )
    s = reduceChat(
      s,
      event('tool.complete', {
        turn_id: 'T-wait',
        message_id: 'a1',
        tool_id: 'call_0',
        name: 'message_bot',
        context: 'writer',
        args: { to: 'writer', text: 'Q', wait: true },
        is_error: true,
        result: { error: 'wait failed' }
      })
    )
    s = reduceChat(
      s,
      event('tool.complete', {
        turn_id: 'T-wait',
        message_id: 'a1',
        tool_id: 'call_0',
        name: 'message_bot',
        context: 'writer',
        args: { to: 'writer', text: 'Q', wait: false },
        result: { details: { status: 'sent', section_id: 'th-w' } }
      })
    )
    expect(s.tools.map(t => [(t.args as { wait?: boolean })?.wait, t.status])).toEqual([
      [true, 'error'],
      [false, 'ok']
    ])

    // pendingTurnTools matches result by args.text when two declarations share call_0 & row.
    const pending = pendingTurnTools([
      { role: 'user', text: 'Ask twice' },
      {
        role: 'assistant',
        row_id: 'a1',
        turn_id: 'T1',
        text: '',
        tool_calls: [
          {
            id: 'call_0',
            function: { name: 'message_bot', arguments: '{"to":"writer","text":"first","wait":true}' }
          },
          {
            id: 'call_0',
            function: { name: 'message_bot', arguments: '{"to":"writer","text":"second","wait":true}' }
          }
        ]
      },
      {
        role: 'tool',
        row_id: 't1',
        turn_id: 'T1',
        message_id: 'a1',
        tool_call_id: 'call_0',
        name: 'message_bot',
        context: 'writer',
        args: { to: 'writer', text: 'second', wait: true },
        text: '{"reply":"ok","section_id":"th-w"}'
      }
    ])
    expect(pending.map(t => (t.args as { text?: string })?.text)).toEqual(['first'])

    // mergeTurnTools never overwrites a saved wait:false send with a separate failed wait:true.
    const merged = mergeTurnTools(
      [
        {
          id: 'call_0',
          name: 'message_bot',
          row: 'a1',
          turnId: 'T-wait',
          action: 'writer',
          args: { to: 'writer', text: 'Q', wait: false },
          detail: '{"status":"sent","section_id":"th-w"}',
          status: 'ok'
        }
      ],
      [
        {
          id: 'call_0',
          name: 'message_bot',
          row: 'a1',
          turnId: 'T-wait',
          action: 'writer',
          args: { to: 'writer', text: 'Q', wait: true },
          detail: '{"error":"wait failed"}',
          status: 'error'
        }
      ]
    )
    expect(merged.map(t => [(t.args as { wait?: boolean })?.wait, t.status])).toEqual([
      [false, 'ok'],
      [true, 'error']
    ])

    // Exact text comparison distinguishes "" from " " on same-fragment call_0 asks.
    let ws = reduceChat(emptyChat(), event('message.start', { turn_id: 'T-ws' }))
    ws = reduceChat(
      ws,
      event('tool.start', {
        turn_id: 'T-ws',
        message_id: 'a1',
        tool_id: 'call_0',
        name: 'message_bot',
        context: 'fox',
        args: { to: 'fox', text: ' ', wait: true }
      })
    )
    ws = reduceChat(
      ws,
      event('tool.start', {
        turn_id: 'T-ws',
        message_id: 'a1',
        tool_id: 'call_0',
        name: 'message_bot',
        context: 'fox',
        args: { to: 'fox', text: '', wait: true }
      })
    )
    ws = reduceChat(
      ws,
      event('tool.complete', {
        turn_id: 'T-ws',
        message_id: 'a1',
        tool_id: 'call_0',
        name: 'message_bot',
        context: 'fox',
        args: { to: 'fox', text: '', wait: true },
        is_error: true,
        result: { error: 'missing parameter: text' }
      })
    )
    expect(ws.tools.map(t => [(t.args as { text?: string })?.text, t.status])).toEqual([
      [' ', 'running'],
      ['', 'error']
    ])

    // Live asks from `sections.open` keep a failed sibling as error instead of reviving as running.
    const withLiveAsks = pendingTurnTools(
      [
        { role: 'user', text: 'Ask fox and ghost' },
        {
          role: 'assistant',
          row_id: 'a3',
          turn_id: 'T3',
          text: '',
          tool_calls: [
            {
              id: 'call_0',
              function: { name: 'message_bot', arguments: '{"to":"fox","text":"Hi","wait":true}' }
            },
            {
              id: 'call_1',
              function: { name: 'message_bot', arguments: '{"to":"ghost","text":"Hi","wait":true}' }
            }
          ]
        }
      ],
      undefined,
      [
        {
          args: { to: 'fox', text: 'Hi', wait: true },
          context: 'fox',
          message_id: 'a3',
          section_id: 'th-fox',
          status: 'running',
          tool_id: 'call_0',
          turn_id: 'T3'
        },
        {
          args: { to: 'ghost', text: 'Hi', wait: true },
          context: 'ghost',
          message_id: 'a3',
          result: { error: 'Unknown bot: ghost' },
          status: 'error',
          tool_id: 'call_1',
          turn_id: 'T3'
        }
      ]
    )
    expect(withLiveAsks.map(t => [(t.args as { to?: string })?.to, t.status])).toEqual([
      ['fox', 'running'],
      ['ghost', 'error']
    ])

    // Persisted nested codemode ask from turn t1 is NOT re-added by pendingTurnTools on fallback t2.
    const nestedFallbackPending = pendingTurnTools(
      [
        { role: 'user', text: 'Run code' },
        {
          role: 'assistant',
          row_id: 'a-t1',
          turn_id: 't1',
          text: '',
          tool_calls: [{ id: 'code', function: { name: 'codemode', arguments: '{}' } }]
        },
        {
          role: 'tool',
          row_id: 'r-t1',
          turn_id: 't1',
          tool_call_id: 'code',
          name: 'codemode',
          text: 'ok',
          nested_calls: {
            calls: [
              {
                id: 'code/1',
                name: 'message_bot',
                arguments: { to: 'fox', text: 'Hi', wait: true },
                section_id: 'th-fox',
                status: 'ok',
                durationMs: 10
              }
            ]
          }
        },
        {
          role: 'assistant',
          row_id: 'a-t2',
          turn_id: 't2',
          text: '',
          tool_calls: [{ id: 'sh-1', function: { name: 'terminal', arguments: '{"cmd":"ls"}' } }]
        }
      ],
      undefined,
      [
        {
          args: { to: 'fox', text: 'Hi', wait: true },
          context: 'fox',
          parent_tool_call_id: 'code',
          section_id: 'th-fox',
          status: 'ok',
          tool_id: 'code/1',
          turn_id: 't1'
        }
      ]
    )
    expect(nestedFallbackPending).toEqual([])

    // Two identical same-fragment call_0 asks to Fox stay distinct live and replaying a buffered
    // failure does NOT settle the still-running sibling from [error, running] to [error, error].
    let dup = reduceChat(emptyChat(), event('message.start', { turn_id: 'T-dup' }))
    dup = reduceChat(
      dup,
      event('tool.start', {
        turn_id: 'T-dup',
        message_id: 'a1',
        tool_id: 'call_0',
        name: 'message_bot',
        context: 'fox',
        args: { to: 'fox', text: 'Hi', wait: true }
      })
    )
    dup = reduceChat(
      dup,
      event('tool.start', {
        turn_id: 'T-dup',
        message_id: 'a1',
        tool_id: 'call_0',
        name: 'message_bot',
        context: 'fox',
        args: { to: 'fox', text: 'Hi', wait: true }
      })
    )
    expect(dup.tools.map(t => t.status)).toEqual(['running', 'running'])

    const hydratedDup = {
      ...emptyChat(),
      busy: true,
      turnId: 'T-dup',
      tools: [
        {
          id: 'call_0',
          name: 'message_bot',
          row: 'a1',
          turnId: 'T-dup',
          action: 'fox',
          args: { to: 'fox', text: 'Hi', wait: true },
          detail: '{"error":"session is already working"}',
          status: 'error' as const
        },
        {
          id: 'call_0',
          name: 'message_bot',
          row: 'a1',
          turnId: 'T-dup',
          action: 'fox',
          args: { to: 'fox', text: 'Hi', wait: true },
          detail: '',
          hydrated: true,
          status: 'running' as const
        }
      ]
    }
    const afterReplayedError = reduceChat(
      hydratedDup,
      event('tool.complete', {
        turn_id: 'T-dup',
        message_id: 'a1',
        tool_id: 'call_0',
        name: 'message_bot',
        context: 'fox',
        args: { to: 'fox', text: 'Hi', wait: true },
        is_error: true,
        result: { error: 'session is already working' }
      })
    )
    expect(afterReplayedError.tools.map(t => t.status)).toEqual(['error', 'running'])

    // Two live identical starts + two genuine error completions settle to [error, error]
    // rather than staying [running, running] and flipping to [ok, ok] on message.complete.
    let dupErr = reduceChat(
      dup,
      event('tool.complete', {
        turn_id: 'T-dup',
        message_id: 'a1',
        tool_id: 'call_0',
        name: 'message_bot',
        context: 'fox',
        args: { to: 'fox', text: 'Hi', wait: true },
        is_error: true,
        result: { error: 'boom' }
      })
    )
    dupErr = reduceChat(
      dupErr,
      event('tool.complete', {
        turn_id: 'T-dup',
        message_id: 'a1',
        tool_id: 'call_0',
        name: 'message_bot',
        context: 'fox',
        args: { to: 'fox', text: 'Hi', wait: true },
        is_error: true,
        result: { error: 'boom' }
      })
    )
    expect(dupErr.tools.map(t => t.status)).toEqual(['error', 'error'])

    // Two hydrated identical running asks + two replayed starts stay 2 calls (not 4).
    const twoHydrated = {
      ...emptyChat(),
      busy: true,
      turnId: 'T-hyd',
      tools: [
        {
          id: 'call_0',
          name: 'message_bot',
          row: 'a1',
          turnId: 'T-hyd',
          action: 'fox',
          args: { to: 'fox', text: 'Hi', wait: true },
          detail: '',
          hydrated: true,
          status: 'running' as const
        },
        {
          id: 'call_0',
          name: 'message_bot',
          row: 'a1',
          turnId: 'T-hyd',
          action: 'fox',
          args: { to: 'fox', text: 'Hi', wait: true },
          detail: '',
          hydrated: true,
          status: 'running' as const
        }
      ]
    }
    let replayedStarts = reduceChat(
      twoHydrated,
      event('tool.start', {
        turn_id: 'T-hyd',
        message_id: 'a1',
        tool_id: 'call_0',
        name: 'message_bot',
        context: 'fox',
        args: { to: 'fox', text: 'Hi', wait: true }
      })
    )
    replayedStarts = reduceChat(
      replayedStarts,
      event('tool.start', {
        turn_id: 'T-hyd',
        message_id: 'a1',
        tool_id: 'call_0',
        name: 'message_bot',
        context: 'fox',
        args: { to: 'fox', text: 'Hi', wait: true }
      })
    )
    expect(replayedStarts.tools).toHaveLength(2)

    // Persisted error result consumes only the matching error ask from snapshot [running, error].
    const pendingWithError = pendingTurnTools(
      [
        { role: 'user', text: 'Ask fox twice' },
        {
          role: 'assistant',
          row_id: 'a5',
          turn_id: 'T5',
          text: '',
          tool_calls: [
            {
              id: 'call_0',
              function: { name: 'message_bot', arguments: '{"to":"fox","text":"Hi","wait":true}' }
            },
            {
              id: 'call_0',
              function: { name: 'message_bot', arguments: '{"to":"fox","text":"Hi","wait":true}' }
            }
          ]
        },
        {
          role: 'tool',
          row_id: 't5',
          turn_id: 'T5',
          message_id: 'a5',
          tool_call_id: 'call_0',
          name: 'message_bot',
          context: 'fox',
          is_error: true,
          text: '{"error":"failed"}'
        }
      ],
      undefined,
      [
        {
          args: { to: 'fox', text: 'Hi', wait: true },
          context: 'fox',
          message_id: 'a5',
          section_id: 'th-fox',
          status: 'running',
          tool_id: 'call_0',
          turn_id: 'T5'
        },
        {
          args: { to: 'fox', text: 'Hi', wait: true },
          context: 'fox',
          message_id: 'a5',
          result: { error: 'failed' },
          status: 'error',
          tool_id: 'call_0',
          turn_id: 'T5'
        }
      ]
    )
    expect(pendingWithError.map(t => t.status)).toEqual(['running'])

    // Hydrated [error, running] on identical untagged call_0 asks: replaying both starts upgrades
    // the running sibling instead of reusing the settled ask twice; 1st error leaves [error, running],
    // 2nd error settles [error, error], and normal message.complete never flips it to [error, ok].
    let errRun: ChatState = {
      ...emptyChat(),
      busy: true,
      turnId: 'T-er',
      tools: [
        {
          id: 'call_0',
          name: 'message_bot',
          row: 'a1',
          turnId: 'T-er',
          action: 'fox',
          args: { to: 'fox', text: 'Hi', wait: true },
          detail: '{"error":"boom"}',
          status: 'error' as const
        },
        {
          id: 'call_0',
          name: 'message_bot',
          row: 'a1',
          turnId: 'T-er',
          action: 'fox',
          args: { to: 'fox', text: 'Hi', wait: true },
          detail: '',
          hydrated: true,
          status: 'running' as const
        }
      ]
    }
    const startEv = event('tool.start', {
      turn_id: 'T-er',
      message_id: 'a1',
      tool_id: 'call_0',
      name: 'message_bot',
      context: 'fox',
      args: { to: 'fox', text: 'Hi', wait: true }
    })
    const errEv = event('tool.complete', {
      turn_id: 'T-er',
      message_id: 'a1',
      tool_id: 'call_0',
      name: 'message_bot',
      context: 'fox',
      args: { to: 'fox', text: 'Hi', wait: true },
      is_error: true,
      result: { error: 'boom' }
    })
    errRun = reduceChat(reduceChat(errRun, startEv), startEv)
    expect(errRun.tools.map(t => t.status)).toEqual(['error', 'running'])
    errRun = reduceChat(errRun, errEv)
    expect(errRun.tools.map(t => t.status)).toEqual(['error', 'running'])
    errRun = reduceChat(errRun, errEv)
    expect(errRun.tools.map(t => t.status)).toEqual(['error', 'error'])
    const errRunDone = reduceChat(errRun, event('message.complete', { turn_id: 'T-er', text: 'Done.' }))
    expect(errRunDone.messages.flatMap(m => m.tools ?? []).map(t => t.status)).toEqual([
      'error',
      'error'
    ])

    // Hydrated [error, error] + two replayed starts + two replayed errors stays [error, error] (2 calls).
    let twoErr: ChatState = {
      ...emptyChat(),
      busy: true,
      turnId: 'T-er',
      tools: [
        {
          id: 'call_0',
          name: 'message_bot',
          row: 'a1',
          turnId: 'T-er',
          action: 'fox',
          args: { to: 'fox', text: 'Hi', wait: true },
          detail: '{"error":"boom"}',
          status: 'error' as const
        },
        {
          id: 'call_0',
          name: 'message_bot',
          row: 'a1',
          turnId: 'T-er',
          action: 'fox',
          args: { to: 'fox', text: 'Hi', wait: true },
          detail: '{"error":"boom"}',
          status: 'error' as const
        }
      ]
    }
    twoErr = reduceChat(reduceChat(twoErr, startEv), startEv)
    expect(twoErr.tools.map(t => t.status)).toEqual(['error', 'error'])
    twoErr = reduceChat(reduceChat(twoErr, errEv), errEv)
    expect(twoErr.tools.map(t => t.status)).toEqual(['error', 'error'])

    // replayChat suppresses persisted history tools 1-to-1 rather than dropping identical siblings.
    const storedPlusRunning: ChatState = {
      ...emptyChat(),
      busy: true,
      turnId: 'T-er',
      messages: [
        {
          id: 'm1',
          role: 'assistant',
          rowId: 'a1',
          turnId: 'T-er',
          text: '',
          tools: [
            {
              id: 'call_0',
              name: 'message_bot',
              row: 'a1',
              turnId: 'T-er',
              action: 'fox',
              args: { to: 'fox', text: 'Hi', wait: true },
              detail: '{"error":"boom"}',
              status: 'error'
            }
          ]
        }
      ],
      tools: [
        {
          id: 'call_0',
          name: 'message_bot',
          row: 'a1',
          turnId: 'T-er',
          action: 'fox',
          args: { to: 'fox', text: 'Hi', wait: true },
          detail: '',
          hydrated: true,
          status: 'running'
        }
      ]
    }
    const replayOneErr = replayChat(storedPlusRunning, [startEv, startEv, errEv])
    expect(replayOneErr.state.tools.map(t => t.status)).toEqual(['running'])
    const replayTwoErr = replayChat(storedPlusRunning, [startEv, startEv, errEv, errEv])
    expect(replayTwoErr.state.tools.map(t => t.status)).toEqual(['error'])

    // Replaying only the running sibling's start or only its fresh error (when the first error
    // predates the replay window) keeps the sibling visible instead of dropping tools to [].
    const replaySingleStart = replayChat(storedPlusRunning, [startEv])
    expect(replaySingleStart.state.tools.map(t => t.status)).toEqual(['running'])
    const replaySingleErr = replayChat(storedPlusRunning, [errEv])
    expect(replaySingleErr.state.tools.map(t => t.status)).toEqual(['error'])

    // Hydrated [error, running] + only the 2nd ask's fresh error + normal message.complete
    // settles to [error, error], never flipping the running sibling to ok.
    let freshErr: ChatState = {
      ...emptyChat(),
      busy: true,
      turnId: 'T-er',
      tools: [
        {
          id: 'call_0',
          name: 'message_bot',
          row: 'a1',
          turnId: 'T-er',
          action: 'fox',
          args: { to: 'fox', text: 'Hi', wait: true },
          detail: '{"error":"boom"}',
          status: 'error'
        },
        {
          id: 'call_0',
          name: 'message_bot',
          row: 'a1',
          turnId: 'T-er',
          action: 'fox',
          args: { to: 'fox', text: 'Hi', wait: true },
          detail: '',
          hydrated: true,
          status: 'running'
        }
      ]
    }
    freshErr = reduceChat(freshErr, errEv)
    freshErr = reduceChat(freshErr, event('message.complete', { turn_id: 'T-er', text: 'Done.' }))
    expect(freshErr.messages.flatMap(m => m.tools ?? []).map(t => t.status)).toEqual([
      'error',
      'error'
    ])

    // Hydrated settled nested ask (parentToolCallId without row or occurrenceId) stays settled
    // during replay instead of appending a running duplicate.
    let nestedSettled: ChatState = {
      ...emptyChat(),
      busy: true,
      turnId: 'T-nested',
      tools: [
        {
          id: '1',
          name: 'message_bot',
          parentToolCallId: 'code',
          turnId: 'T-nested',
          action: 'fox',
          args: { to: 'fox', text: 'Nested', wait: true },
          detail: '{"error":"boom"}',
          status: 'error'
        }
      ]
    }
    nestedSettled = reduceChat(
      nestedSettled,
      event('tool.start', {
        turn_id: 'T-nested',
        parent_tool_call_id: 'code',
        tool_id: '1',
        name: 'message_bot',
        context: 'fox',
        args: { to: 'fox', text: 'Nested', wait: true }
      })
    )
    nestedSettled = reduceChat(
      nestedSettled,
      event('tool.complete', {
        turn_id: 'T-nested',
        parent_tool_call_id: 'code',
        tool_id: '1',
        name: 'message_bot',
        context: 'fox',
        args: { to: 'fox', text: 'Nested', wait: true },
        is_error: true,
        result: { error: 'boom' }
      })
    )
    expect(nestedSettled.tools.map(t => t.status)).toEqual(['error'])

    // Persisted codemode nested ask inherits its parent row; replaying its live start/complete
    // (which carry parent_tool_call_id and turn_id but omit message_id) suppresses it instead
    // of showing a duplicate running ask or sticking it in completingAsks.
    const nestedHistoryRows = [
      { role: 'user', text: 'Run code' },
      {
        role: 'assistant',
        row_id: 'a-code',
        turn_id: 'T-nc',
        text: '',
        tool_calls: [{ id: 'code', function: { name: 'codemode', arguments: '{"code":"..."}' } }]
      },
      {
        role: 'tool',
        row_id: 't-code',
        turn_id: 'T-nc',
        message_id: 'a-code',
        tool_call_id: 'code',
        name: 'codemode',
        text: 'ok',
        nested_calls: {
          calls: [
            {
              id: 'code/1',
              name: 'message_bot',
              args: { to: 'fox', text: 'Hi', wait: true },
              section_id: 'th-fox',
              result: { reply: 'Done', section_id: 'th-fox' }
            }
          ]
        }
      }
    ]
    const nestedSnapshot: ChatState = {
      ...emptyChat(),
      busy: true,
      turnId: 'T-nc',
      messages: historyMessages(nestedHistoryRows),
      tools: pendingTurnTools(nestedHistoryRows)
    }
    expect(nestedSnapshot.tools).toEqual([])
    const nestedReplayed = replayChat(nestedSnapshot, [
      event('tool.start', {
        turn_id: 'T-nc',
        parent_tool_call_id: 'code',
        tool_id: 'code/1',
        name: 'message_bot',
        context: 'fox',
        args: { to: 'fox', text: 'Hi', wait: true }
      })
    ])
    expect(nestedReplayed.state.tools).toEqual([])
    const nestedReplayedDone = replayChat(nestedSnapshot, [
      event('tool.start', {
        turn_id: 'T-nc',
        parent_tool_call_id: 'code',
        tool_id: 'code/1',
        name: 'message_bot',
        context: 'fox',
        args: { to: 'fox', text: 'Hi', wait: true }
      }),
      event('tool.complete', {
        turn_id: 'T-nc',
        parent_tool_call_id: 'code',
        tool_id: 'code/1',
        name: 'message_bot',
        context: 'fox',
        result: { details: { reply: 'Done', section_id: 'th-fox' } }
      }),
      event('message.complete', { turn_id: 'T-nc', text: 'Finished.' })
    ])
    expect(nestedReplayedDone.state.completingAsks?.[''] ?? []).toEqual([])

    // A direct completion (with occurrence_id or untagged alongside a running direct ask)
    // must never settle a nested ask sharing the same tool_id, and unconfirmedTurnTools
    // keeps a held direct ask when history only contains the nested ask.
    let nvd: ChatState = reduceChat(
      emptyChat(),
      event('tool.start', {
        turn_id: 'T-nvd',
        parent_tool_call_id: 'code',
        tool_id: 'code/1',
        name: 'message_bot',
        context: 'fox',
        args: { to: 'fox', text: 'Hi', wait: true }
      })
    )
    nvd = reduceChat(
      nvd,
      event('tool.complete', {
        turn_id: 'T-nvd',
        tool_id: 'code/1',
        occurrence_id: 'direct',
        name: 'message_bot',
        context: 'fox',
        args: { to: 'fox', text: 'Hi', wait: true },
        result: { details: { section_id: 'th-fox', status: 'replied' } }
      })
    )
    expect(nvd.tools.map(t => [t.parentToolCallId ?? null, t.occurrenceId ?? null, t.status])).toEqual([
      ['code', null, 'running'],
      [null, 'direct', 'ok']
    ])

    let nvdu: ChatState = reduceChat(
      emptyChat(),
      event('tool.start', {
        turn_id: 'T-nvdu',
        parent_tool_call_id: 'code',
        tool_id: 'code/1',
        name: 'message_bot',
        context: 'fox',
        args: { to: 'fox', text: 'Hi', wait: true }
      })
    )
    nvdu = reduceChat(
      nvdu,
      event('tool.start', {
        turn_id: 'T-nvdu',
        tool_id: 'code/1',
        name: 'message_bot',
        context: 'fox',
        args: { to: 'fox', text: 'Hi', wait: true }
      })
    )
    nvdu = reduceChat(
      nvdu,
      event('tool.complete', {
        turn_id: 'T-nvdu',
        tool_id: 'code/1',
        name: 'message_bot',
        context: 'fox',
        args: { to: 'fox', text: 'Hi', wait: true },
        result: { details: { section_id: 'th-fox', status: 'replied' } }
      })
    )
    expect(nvdu.tools.map(t => [t.parentToolCallId ?? null, t.status])).toEqual([
      ['code', 'running'],
      [null, 'ok']
    ])

    const heldDirect = [
      {
        id: 'code/1',
        name: 'message_bot',
        turnId: 'T-nc',
        action: 'fox',
        args: { to: 'fox', text: 'Hi', wait: true },
        detail: '{"section_id":"th-fox"}',
        status: 'ok' as const
      }
    ]
    expect(unconfirmedTurnTools(heldDirect, nestedSnapshot.messages)).toHaveLength(1)

    // Sibling tools sharing call_0 with message_bot in the same assistant row keep their own
    // row ID and declared args (restoring hexbot_share_file attachments and preventing replay
    // from duplicating a completed web_search sibling).
    const siblingShareRows = [
      { role: 'user', text: 'Ask and search' },
      {
        role: 'assistant',
        row_id: 'a-sib',
        turn_id: 'T-sib',
        text: '',
        tool_calls: [
          {
            id: 'call_0',
            occurrence_id: 'occ-sib-ask',
            function: { name: 'message_bot', arguments: '{"to":"biology","text":"Check"}' }
          },
          {
            id: 'call_0',
            function: { name: 'web_search', arguments: '{"query":"mitosis"}' }
          },
          {
            id: 'call_0',
            function: { name: 'hexbot_share_file', arguments: '{"path":"/work/report.pdf"}' }
          }
        ]
      },
      {
        role: 'tool',
        row_id: 't-sib-search',
        turn_id: 'T-sib',
        tool_call_id: 'call_0',
        name: 'web_search',
        context: 'mitosis',
        text: 'search hits'
      },
      {
        role: 'tool',
        row_id: 't-sib-file',
        turn_id: 'T-sib',
        tool_call_id: 'call_0',
        name: 'hexbot_share_file',
        text: '{"shared":true}'
      }
    ]
    const sibMessages = historyMessages(siblingShareRows)
    const sibTools = sibMessages.flatMap(m => m.tools ?? [])
    expect(sibTools.find(t => t.name === 'web_search')).toMatchObject({
      args: { query: 'mitosis' },
      row: 'a-sib'
    })
    expect(sharedFiles(sibTools)).toEqual([{ name: 'report.pdf', path: '/work/report.pdf' }])

    const sibReplay = replayChat(
      {
        ...emptyChat(),
        busy: true,
        turnId: 'T-sib',
        messages: sibMessages,
        tools: pendingTurnTools(siblingShareRows)
      },
      [
        event('tool.start', {
          turn_id: 'T-sib',
          message_id: 'a-sib',
          tool_id: 'call_0',
          name: 'web_search',
          context: 'mitosis',
          args: { query: 'mitosis' }
        }),
        event('tool.complete', {
          turn_id: 'T-sib',
          message_id: 'a-sib',
          tool_id: 'call_0',
          name: 'web_search',
          context: 'mitosis',
          result_text: 'search hits'
        })
      ]
    )
    expect(sibReplay.state.tools.map(t => [t.name, t.status])).toEqual([['message_bot', 'running']])

    // Repeated codemode invocation reusing call_0 + call_0/1 in the same turn keeps the new
    // parent AND its running nested ask instead of suppressing the child against the earlier parent.
    const repeatCodeRows = [
      { role: 'user', text: 'Run twice' },
      {
        role: 'assistant',
        row_id: 'a-c1',
        turn_id: 'T-rc',
        text: '',
        tool_calls: [
          {
            id: 'call_0',
            occurrence_id: 'p1',
            function: { name: 'codemode', arguments: '{"code":"1"}' }
          }
        ]
      },
      {
        role: 'tool',
        row_id: 't-c1',
        turn_id: 'T-rc',
        message_id: 'a-c1',
        tool_call_id: 'call_0',
        occurrence_id: 'p1',
        name: 'codemode',
        text: 'ok',
        nested_calls: {
          calls: [
            {
              id: 'call_0/1',
              name: 'message_bot',
              args: { to: 'fox', text: 'Same', wait: true },
              section_id: 'th-fox',
              result: { reply: 'First', section_id: 'th-fox' }
            }
          ]
        }
      }
    ]
    const repeatCodeReplay = replayChat(
      {
        ...emptyChat(),
        busy: true,
        turnId: 'T-rc',
        messages: historyMessages(repeatCodeRows)
      },
      [
        event('tool.start', {
          turn_id: 'T-rc',
          tool_id: 'call_0',
          occurrence_id: 'p2',
          name: 'codemode',
          args: { code: '2' }
        }),
        event('tool.start', {
          turn_id: 'T-rc',
          parent_tool_call_id: 'call_0',
          tool_id: 'call_0/1',
          name: 'message_bot',
          context: 'fox',
          args: { to: 'fox', text: 'Same', wait: true }
        })
      ]
    )
    expect(repeatCodeReplay.state.tools.map(t => [t.name, t.id, t.status])).toEqual([
      ['codemode', 'call_0', 'running'],
      ['message_bot', 'call_0/1', 'running']
    ])

    // Two parallel web_search calls sharing call_0 with distinct queries stay separate and
    // settle against their matching context.
    let dualSearch: ChatState = reduceChat(
      emptyChat(),
      event('tool.start', {
        turn_id: 'T-ws',
        message_id: 'a-ws',
        tool_id: 'call_0',
        name: 'web_search',
        context: 'meiosis',
        args: { query: 'meiosis' }
      })
    )
    dualSearch = reduceChat(
      dualSearch,
      event('tool.start', {
        turn_id: 'T-ws',
        message_id: 'a-ws',
        tool_id: 'call_0',
        name: 'web_search',
        context: 'cytokinesis',
        args: { query: 'cytokinesis' }
      })
    )
    expect(dualSearch.tools.map(t => [t.action, t.status])).toEqual([
      ['meiosis', 'running'],
      ['cytokinesis', 'running']
    ])
    dualSearch = reduceChat(
      dualSearch,
      event('tool.complete', {
        turn_id: 'T-ws',
        message_id: 'a-ws',
        tool_id: 'call_0',
        name: 'web_search',
        context: 'meiosis',
        result_text: 'meiosis result'
      })
    )
    dualSearch = reduceChat(
      dualSearch,
      event('tool.complete', {
        turn_id: 'T-ws',
        message_id: 'a-ws',
        tool_id: 'call_0',
        name: 'web_search',
        context: 'cytokinesis',
        result_text: 'cytokinesis result'
      })
    )
    expect(dualSearch.tools.map(t => [t.action, t.status, t.detail])).toEqual([
      ['meiosis', 'ok', 'meiosis result'],
      ['cytokinesis', 'ok', 'cytokinesis result']
    ])

    // Failed nested ask retains its exact section_id alongside its error message on reload.
    const failedNestedMsgs = historyMessages([
      {
        role: 'assistant',
        row_id: 'a-fn',
        turn_id: 'T-fn',
        text: '',
        tool_calls: [{ id: 'code_1', occurrence_id: 'occ-c1', function: { name: 'codemode', arguments: '{}' } }]
      },
      {
        role: 'tool',
        row_id: 't-fn',
        turn_id: 'T-fn',
        tool_call_id: 'code_1',
        occurrence_id: 'occ-c1',
        name: 'codemode',
        text: 'done',
        nested_calls: {
          calls: [
            {
              id: 'code_1/1',
              name: 'message_bot',
              arguments: { to: 'fox', text: 'Check' },
              status: 'error',
              error: 'Peer timed out',
              section_id: 'th-old-fox'
            }
          ]
        }
      }
    ])
    const failedNestedTool = failedNestedMsgs.flatMap(m => m.tools ?? []).find(t => t.name === 'message_bot')!
    expect(
      asksOf([
        {
          args: failedNestedTool.args,
          name: failedNestedTool.name,
          result: failedNestedTool.detail,
          status: failedNestedTool.status
        }
      ])
    ).toEqual([{ sectionId: 'th-old-fox', sent: false, status: 'error', target: 'fox' }])

    // Ambiguous colliding web_search completions (one error, one ok, empty daemon context)
    // must never settle to ['ok', 'ok'] with empty details on message.complete.
    let ambigSearch: ChatState = reduceChat(
      emptyChat(),
      event('message.start', { turn_id: 'T-ambig' })
    )
    ambigSearch = reduceChat(
      ambigSearch,
      event('tool.start', {
        turn_id: 'T-ambig',
        message_id: 'a-ambig',
        tool_id: 'call_0',
        name: 'web_search',
        context: 'meiosis',
        args: { query: 'meiosis' }
      })
    )
    ambigSearch = reduceChat(
      ambigSearch,
      event('tool.start', {
        turn_id: 'T-ambig',
        message_id: 'a-ambig',
        tool_id: 'call_0',
        name: 'web_search',
        context: 'cytokinesis',
        args: { query: 'cytokinesis' }
      })
    )
    ambigSearch = reduceChat(
      ambigSearch,
      event('tool.complete', {
        turn_id: 'T-ambig',
        message_id: 'a-ambig',
        tool_id: 'call_0',
        name: 'web_search',
        context: '',
        is_error: true,
        result: { error: 'Search timed out' },
        result_text: 'Search timed out'
      })
    )
    ambigSearch = reduceChat(
      ambigSearch,
      event('tool.complete', {
        turn_id: 'T-ambig',
        message_id: 'a-ambig',
        tool_id: 'call_0',
        name: 'web_search',
        context: '',
        result_text: 'ok'
      })
    )
    ambigSearch = reduceChat(
      ambigSearch,
      event('message.complete', { turn_id: 'T-ambig', text: 'Done.' })
    )
    const settledTools = ambigSearch.messages.flatMap(m => m.tools ?? [])
    expect(settledTools.map(t => t.status)).toEqual(['unresolved', 'unresolved'])
    expect(settledTools.every(t => t.detail.includes('"failed": 1') && t.detail.includes('"ok": 1'))).toBe(true)

    // Running, settled ok, and failed direct asks in a busy snapshot whose declarations have
    // not persisted yet are all restored.
    for (const status of ['running', 'ok', 'error'] as const) {
      const laggedPending = pendingTurnTools(
        [{ role: 'user', text: 'Ask biology' }],
        undefined,
        [
          {
            args: { to: 'biology', text: 'Check cells', wait: status !== 'ok' },
            context: 'biology',
            occurrence_id: `occ-lag-${status}`,
            ...(status === 'ok'
              ? { result: { section_id: 'th-lag', status: 'sent' } }
              : status === 'error'
                ? { result: { error: 'Peer failed', section_id: 'th-lag' } }
                : {}),
            section_id: 'th-lag',
            status,
            tool_id: 'call_0',
            turn_id: 'T-lag'
          }
        ]
      )
      expect(laggedPending).toHaveLength(1)
      expect(laggedPending[0]).toMatchObject({
        action: 'biology',
        id: 'call_0',
        name: 'message_bot',
        occurrenceId: `occ-lag-${status}`,
        status,
        turnId: 'T-lag'
      })
      expect(laggedPending[0]!.detail).toContain('th-lag')
    }

    // Persisted nested ask consumes only its compatible snapshot entry (target/args/section),
    // keeping a sibling peer's nested ask from the snapshot intact.
    const partialNestedPending = pendingTurnTools(
      [
        { role: 'user', text: 'Ask both in code' },
        {
          role: 'assistant',
          row_id: 'a-chem',
          turn_id: 'T-par-code',
          text: '',
          tool_calls: [{ id: 'code', function: { name: 'codemode', arguments: '{}' } }]
        },
        {
          role: 'tool',
          row_id: 't-chem',
          turn_id: 'T-par-code',
          tool_call_id: 'code',
          name: 'codemode',
          text: 'chem done',
          nested_calls: {
            calls: [
              {
                id: 'code/1',
                name: 'message_bot',
                arguments: { to: 'chemistry', text: 'Check bonds', wait: true },
                status: 'ok',
                section_id: 'th-chem',
                result: { reply: 'Chem ok', section_id: 'th-chem' }
              }
            ]
          }
        }
      ],
      undefined,
      [
        {
          args: { to: 'biology', text: 'Check cells', wait: true },
          context: 'biology',
          parent_tool_call_id: 'code',
          result: { reply: 'Bio ok', section_id: 'th-bio' },
          section_id: 'th-bio',
          status: 'ok',
          tool_id: 'code/1',
          turn_id: 'T-par-code'
        },
        {
          args: { to: 'chemistry', text: 'Check bonds', wait: true },
          context: 'chemistry',
          parent_tool_call_id: 'code',
          result: { reply: 'Chem ok', section_id: 'th-chem' },
          section_id: 'th-chem',
          status: 'ok',
          tool_id: 'code/1',
          turn_id: 'T-par-code'
        }
      ]
    )
    expect(partialNestedPending).toHaveLength(1)
    expect(partialNestedPending[0]).toMatchObject({
      action: 'biology',
      id: 'code/1',
      name: 'message_bot',
      parentToolCallId: 'code',
      status: 'ok'
    })
    expect(partialNestedPending[0]!.detail).toContain('th-bio')

    // Fallback continuation (`message.start(T1)` -> ask ok -> `message.start(T2)` -> `message.complete(T2)`)
    // preserves settled asks across the fallback start and on the final settled reply.
    let fb: ChatState = reduceChat(emptyChat(), event('message.start', { turn_id: 'T1' }))
    fb = reduceChat(
      fb,
      event('tool.start', {
        turn_id: 'T1',
        tool_id: 'call_0',
        occurrence_id: 'occ-fb',
        name: 'message_bot',
        context: 'biology',
        args: { to: 'biology', text: 'Check' }
      })
    )
    fb = reduceChat(
      fb,
      event('tool.complete', {
        turn_id: 'T1',
        tool_id: 'call_0',
        occurrence_id: 'occ-fb',
        name: 'message_bot',
        context: 'biology',
        result: { details: { reply: 'Bio reply', section_id: 'th-bio' } }
      })
    )
    fb = reduceChat(fb, event('message.start', { turn_id: 'T2' }))
    expect(fb.tools).toHaveLength(1)
    expect(fb.tools[0]).toMatchObject({ name: 'message_bot', status: 'ok' })
    fb = reduceChat(fb, event('message.complete', { turn_id: 'T2', text: 'Fallback answer.' }))
    expect(fb.messages.flatMap(m => m.tools ?? [])).toMatchObject([
      { name: 'message_bot', occurrenceId: 'occ-fb', status: 'ok' }
    ])

    // Failed top-level message_bot history row retains its persisted section_id.
    const failedDirectMsgs = historyMessages([
      {
        role: 'assistant',
        row_id: 'a-fd',
        turn_id: 'T-fd',
        text: '',
        tool_calls: [
          {
            id: 'call_0',
            occurrence_id: 'occ-fd',
            function: { name: 'message_bot', arguments: '{"to":"fox","text":"Help"}' }
          }
        ]
      },
      {
        role: 'tool',
        row_id: 't-fd',
        turn_id: 'T-fd',
        tool_call_id: 'call_0',
        occurrence_id: 'occ-fd',
        name: 'message_bot',
        is_error: true,
        section_id: 'th-archived-fox',
        text: 'Peer failed'
      }
    ])
    const failedDirectTool = failedDirectMsgs.flatMap(m => m.tools ?? []).find(t => t.name === 'message_bot')!
    expect(
      asksOf([
        {
          args: failedDirectTool.args,
          name: failedDirectTool.name,
          result: failedDirectTool.detail,
          status: failedDirectTool.status
        }
      ])
    ).toEqual([{ sectionId: 'th-archived-fox', sent: false, status: 'error', target: 'fox' }])

    // Persisted nested codemode ask must not consume an earlier running snapshot sibling.
    const nestedParallelPending = pendingTurnTools(
      [
        { role: 'user', text: 'Check two scripts' },
        {
          role: 'assistant',
          row_id: 'a-np',
          turn_id: 'T-np',
          text: '',
          tool_calls: [
            {
              id: 'call_0',
              occurrence_id: 'occ-p1',
              function: { name: 'codemode', arguments: '{"code":"ask(fox)"}' }
            },
            {
              id: 'call_0',
              occurrence_id: 'occ-p2',
              function: { name: 'codemode', arguments: '{"code":"ask(fox)"}' }
            }
          ]
        },
        {
          role: 'tool',
          row_id: 't-np',
          turn_id: 'T-np',
          tool_call_id: 'call_0',
          occurrence_id: 'occ-p2',
          name: 'codemode',
          nested_calls: {
            calls: [
              {
                id: 'call_0/1',
                name: 'message_bot',
                arguments: { to: 'fox', text: 'Ping', wait: true },
                section_id: 'th-fox',
                status: 'ok'
              }
            ]
          },
          text: 'done'
        }
      ],
      undefined,
      [
        {
          tool_id: 'call_0/1',
          parent_tool_call_id: 'call_0',
          parent_occurrence_id: 'occ-p1',
          turn_id: 'T-np',
          args: { to: 'fox', text: 'Ping', wait: true },
          context: 'fox',
          status: 'running'
        },
        {
          tool_id: 'call_0/1',
          parent_tool_call_id: 'call_0',
          parent_occurrence_id: 'occ-p2',
          turn_id: 'T-np',
          args: { to: 'fox', text: 'Ping', wait: true },
          context: 'fox',
          section_id: 'th-fox',
          status: 'ok'
        }
      ]
    )
    expect(nestedParallelPending.map(t => [t.parentOccurrenceId, t.status])).toEqual([
      ['occ-p1', 'running']
    ])

    // Section live event buffering keeps fallback continuations intact and resets after
    // completed runs even when usage / status.update follow message.complete.
    const fallbackBuf = [
      event('message.start', { turn_id: 't1' }),
      event('tool.start', { tool_id: 'c1', name: 'message_bot' }),
      event('tool.complete', { tool_id: 'c1', name: 'message_bot' }),
      event('message.start', { turn_id: 't2' }),
      event('tool.start', { tool_id: 'c2', name: 'message_bot' })
    ]
    expect(latestRunEvents(fallbackBuf)).toHaveLength(5)
    expect(bufferedRunEnded(fallbackBuf)).toBe(false)

    const finishedWithTrailers = [
      ...fallbackBuf,
      event('message.complete', { text: 'Done' }),
      event('usage', { tokens: 10 }),
      event('status.update', { kind: 'idle' })
    ]
    expect(latestRunEvents(finishedWithTrailers)).toHaveLength(8)
    expect(bufferedRunEnded(finishedWithTrailers)).toBe(true)

    const twoRuns = [
      event('message.start', { turn_id: 'old' }),
      event('message.complete', { text: 'Old' }),
      event('usage', { tokens: 5 }),
      event('status.update', { kind: 'idle' }),
      ...fallbackBuf
    ]
    expect(latestRunEvents(twoRuns)).toEqual(fallbackBuf)
    expect(bufferedRunEnded([event('tool.start', { tool_id: 'mid', name: 'message_bot' })])).toBe(
      false
    )
    expect(bufferedRunEnded([event('message.start'), event('error', { message: 'boom' })])).toBe(
      true
    )

    // mergeTurnTools keeps sequential codemode nested asks with distinct parentOccurrenceId separate.
    const mergedNested = mergeTurnTools(
      [
        {
          id: 'code_0/1',
          name: 'message_bot',
          parentToolCallId: 'code_0',
          parentOccurrenceId: 'occ-p1',
          args: { to: 'biology', text: 'Check', wait: true },
          action: 'biology',
          detail: '{"section_id":"th-bio"}',
          status: 'ok',
          turnId: 'T1'
        }
      ],
      [
        {
          id: 'code_0/1',
          name: 'message_bot',
          parentToolCallId: 'code_0',
          parentOccurrenceId: 'occ-p2',
          args: { to: 'biology', text: 'Check', wait: true },
          action: 'biology',
          detail: '',
          status: 'running',
          turnId: 'T1'
        }
      ]
    )
    expect(mergedNested.map(t => [t.parentOccurrenceId, t.status])).toEqual([
      ['occ-p1', 'ok'],
      ['occ-p2', 'running']
    ])

    // mergeTurnTools deduplicates nested codemode asks when live state inherited `row`
    // while replayed snapshot asks omit `message_id`, and never regresses a settled ask to running.
    const mergedOneSidedRow = mergeTurnTools(
      [
        {
          id: 'code_0/1',
          name: 'message_bot',
          parentToolCallId: 'code_0',
          parentOccurrenceId: 'occ-p1',
          row: 'a2',
          args: { to: 'biology', text: 'Check', wait: true },
          action: 'biology',
          detail: '{"section_id":"th-bio"}',
          status: 'ok',
          turnId: 'T1'
        }
      ],
      [
        {
          id: 'code_0/1',
          name: 'message_bot',
          parentToolCallId: 'code_0',
          parentOccurrenceId: 'occ-p1',
          args: { to: 'biology', text: 'Check', wait: true },
          action: 'biology',
          detail: '',
          status: 'running',
          turnId: 'T1'
        }
      ]
    )
    expect(mergedOneSidedRow).toHaveLength(1)
    expect(mergedOneSidedRow[0]).toMatchObject({
      id: 'code_0/1',
      parentOccurrenceId: 'occ-p1',
      row: 'a2',
      status: 'ok',
      detail: '{"section_id":"th-bio"}'
    })

    // unconfirmedTurnTools clears a held nested ask with inherited `row` against a stored
    // nested ask whose parent tool row had ambiguous ownership (`row: undefined`).
    const remainingAfterNested = unconfirmedTurnTools(
      [
        {
          id: 'code_0/1',
          name: 'message_bot',
          parentToolCallId: 'code_0',
          parentOccurrenceId: 'occ-p1',
          row: 'a2',
          args: { to: 'biology', text: 'Check', wait: true },
          action: 'biology',
          detail: '{"section_id":"th-bio"}',
          status: 'ok',
          turnId: 'T1'
        }
      ],
      [
        {
          id: 'm1',
          role: 'assistant',
          text: 'Done',
          turnId: 'T1',
          tools: [
            {
              id: 'code_0/1',
              name: 'message_bot',
              parentToolCallId: 'code_0',
              parentOccurrenceId: 'occ-p1',
              args: { to: 'biology', text: 'Check', wait: true },
              detail: '{"section_id":"th-bio"}',
              status: 'ok',
              turnId: 'T1'
            }
          ]
        }
      ]
    )
    expect(remainingAfterNested).toEqual([])

    // Replayed nested tool.start with explicit `parent_occurrence_id: 'occ-p1'` while
    // `occ-p2` on `m2` is running resolves `occ-p1` on `m1` instead of duplicating on `m2`,
    // and tool.complete backfills `parentOccurrenceId` when settling a matched nested tool.
    const seededTwoParents: ChatState = {
      ...emptyChat(),
      busy: true,
      turnId: 'T-rp',
      tools: [
        {
          id: 'code_0',
          name: 'codemode',
          occurrenceId: 'occ-p1',
          row: 'm1',
          args: { code: 'ask(1)' },
          detail: 'done',
          status: 'ok',
          turnId: 'T-rp'
        },
        {
          id: 'code_0/1',
          name: 'message_bot',
          parentToolCallId: 'code_0',
          parentOccurrenceId: 'occ-p1',
          row: 'm1',
          args: { to: 'biology', text: 'Check', wait: true },
          action: 'biology',
          detail: '{"section_id":"th-bio"}',
          status: 'ok',
          turnId: 'T-rp'
        },
        {
          id: 'code_0',
          name: 'codemode',
          occurrenceId: 'occ-p2',
          row: 'm2',
          args: { code: 'ask(2)' },
          detail: '',
          status: 'running',
          turnId: 'T-rp'
        }
      ]
    }
    const afterReplayedStart = reduceChat(
      seededTwoParents,
      event('tool.start', {
        turn_id: 'T-rp',
        tool_id: 'code_0/1',
        parent_tool_call_id: 'code_0',
        parent_occurrence_id: 'occ-p1',
        name: 'message_bot',
        context: 'biology',
        args: { to: 'biology', text: 'Check', wait: true }
      })
    )
    expect(
      afterReplayedStart.tools
        .filter(t => t.name === 'message_bot')
        .map(t => [t.row, t.parentOccurrenceId, t.status])
    ).toEqual([['m1', 'occ-p1', 'ok']])

    const untaggedRunningNested: ChatState = {
      ...emptyChat(),
      busy: true,
      turnId: 'T-bf',
      tools: [
        {
          id: 'code_0/1',
          name: 'message_bot',
          parentToolCallId: 'code_0',
          args: { to: 'biology', text: 'Check', wait: true },
          action: 'biology',
          detail: '',
          status: 'running',
          turnId: 'T-bf'
        }
      ]
    }
    const afterBackfillComplete = reduceChat(
      untaggedRunningNested,
      event('tool.complete', {
        turn_id: 'T-bf',
        tool_id: 'code_0/1',
        parent_tool_call_id: 'code_0',
        parent_occurrence_id: 'occ-p1',
        name: 'message_bot',
        context: 'biology',
        result: { details: { reply: 'Ok', section_id: 'th-bio' } }
      })
    )
    expect(afterBackfillComplete.tools).toHaveLength(1)
    expect(afterBackfillComplete.tools[0]).toMatchObject({
      id: 'code_0/1',
      parentOccurrenceId: 'occ-p1',
      status: 'ok'
    })

    // Untagged settled nested ask must not intercept explicit `parent_occurrence_id: 'occ-p2'`
    // on either `tool.complete` or `tool.start`.
    const untaggedVsP2: ChatState = {
      ...emptyChat(),
      busy: true,
      turnId: 'T-uvp2',
      tools: [
        {
          id: 'code_0/1',
          name: 'message_bot',
          parentToolCallId: 'code_0',
          args: { to: 'biology', text: 'Check', wait: true },
          action: 'biology',
          detail: '{"section_id":"th-bio"}',
          status: 'ok',
          turnId: 'T-uvp2'
        },
        {
          id: 'code_0/1',
          name: 'message_bot',
          parentToolCallId: 'code_0',
          parentOccurrenceId: 'occ-p2',
          args: { to: 'biology', text: 'Check', wait: true },
          action: 'biology',
          detail: '',
          status: 'running',
          turnId: 'T-uvp2'
        }
      ]
    }
    const afterUvp2Complete = reduceChat(
      untaggedVsP2,
      event('tool.complete', {
        turn_id: 'T-uvp2',
        tool_id: 'code_0/1',
        parent_tool_call_id: 'code_0',
        parent_occurrence_id: 'occ-p2',
        name: 'message_bot',
        context: 'biology',
        result: { details: { reply: 'Ok', section_id: 'th-bio' } }
      })
    )
    expect(afterUvp2Complete.tools.map(t => [t.parentOccurrenceId ?? null, t.status])).toEqual([
      [null, 'ok'],
      ['occ-p2', 'ok']
    ])

    const afterUvp2Start = reduceChat(
      { ...untaggedVsP2, tools: [untaggedVsP2.tools[0]!] },
      event('tool.start', {
        turn_id: 'T-uvp2',
        tool_id: 'code_0/1',
        parent_tool_call_id: 'code_0',
        parent_occurrence_id: 'occ-p2',
        name: 'message_bot',
        context: 'biology',
        args: { to: 'biology', text: 'Check', wait: true }
      })
    )
    expect(afterUvp2Start.tools.map(t => [t.parentOccurrenceId ?? null, t.status])).toEqual([
      [null, 'ok'],
      ['occ-p2', 'running']
    ])

    // replayChat suppresses a replayed running `occ-p1` nested ask even while a newer
    // unpersisted `occ-p2` parent sharing `code_0` is running.
    const replaySnapshot: ChatState = {
      ...emptyChat(),
      busy: true,
      turnId: 'T-rp2',
      messages: [
        {
          id: 'm1',
          role: 'assistant',
          text: '',
          turnId: 'T-rp2',
          tools: [
            {
              id: 'code_0',
              name: 'codemode',
              occurrenceId: 'occ-p1',
              row: 'm1',
              args: { code: 'ask(1)' },
              detail: 'done',
              status: 'ok',
              turnId: 'T-rp2'
            },
            {
              id: 'code_0/1',
              name: 'message_bot',
              parentToolCallId: 'code_0',
              parentOccurrenceId: 'occ-p1',
              row: 'm1',
              args: { to: 'biology', text: 'Check', wait: true },
              detail: '{"section_id":"th-bio"}',
              status: 'ok',
              turnId: 'T-rp2'
            }
          ]
        }
      ]
    }
    const replayed = replayChat(replaySnapshot, [
      event('tool.start', {
        turn_id: 'T-rp2',
        message_id: 'm2',
        tool_id: 'code_0',
        occurrence_id: 'occ-p2',
        name: 'codemode',
        args: { code: 'ask(2)' }
      }),
      event('tool.start', {
        turn_id: 'T-rp2',
        tool_id: 'code_0/1',
        parent_tool_call_id: 'code_0',
        parent_occurrence_id: 'occ-p1',
        name: 'message_bot',
        context: 'biology',
        args: { to: 'biology', text: 'Check', wait: true }
      })
    ])
    expect(replayed.state.tools.map(t => [t.name, t.occurrenceId ?? t.parentOccurrenceId, t.status])).toEqual([
      ['codemode', 'occ-p2', 'running']
    ])

    // Missed tool.start with 1 or 2 earlier untagged settled asks appends `occ-p2` separately.
    for (const count of [1, 2]) {
      const prior: ChatState = {
        ...emptyChat(),
        busy: true,
        turnId: 'T-ms',
        tools: Array.from({ length: count }, () => ({
          id: 'code_0/1',
          name: 'message_bot',
          parentToolCallId: 'code_0',
          args: { to: 'biology', text: 'Check', wait: true },
          action: 'biology',
          detail: '{"section_id":"th-bio"}',
          status: 'ok' as const,
          turnId: 'T-ms'
        }))
      }
      const afterMissed = reduceChat(
        prior,
        event('tool.complete', {
          turn_id: 'T-ms',
          tool_id: 'code_0/1',
          parent_tool_call_id: 'code_0',
          parent_occurrence_id: 'occ-p2',
          name: 'message_bot',
          context: 'biology',
          result: { details: { reply: 'New', section_id: 'th-bio' } }
        })
      )
      expect(afterMissed.tools.map(t => [t.parentOccurrenceId ?? null, t.status])).toEqual([
        ...Array.from({ length: count }, () => [null, 'ok']),
        ['occ-p2', 'ok']
      ])
    }

    // Hydrated running upgrade matches only `occ-p2`, never hijacking an untagged hydrated sibling.
    const hydratedSiblings: ChatState = {
      ...emptyChat(),
      busy: true,
      turnId: 'T-hs',
      tools: [
        {
          id: 'code_0/1',
          name: 'message_bot',
          parentToolCallId: 'code_0',
          args: { to: 'biology', text: 'Check', wait: true },
          action: 'biology',
          detail: '',
          status: 'running',
          hydrated: true,
          turnId: 'T-hs'
        },
        {
          id: 'code_0/1',
          name: 'message_bot',
          parentToolCallId: 'code_0',
          parentOccurrenceId: 'occ-p2',
          args: { to: 'biology', text: 'Check', wait: true },
          action: 'biology',
          detail: '',
          status: 'running',
          hydrated: true,
          turnId: 'T-hs'
        }
      ]
    }
    const afterHydratedStart = reduceChat(
      hydratedSiblings,
      event('tool.start', {
        turn_id: 'T-hs',
        tool_id: 'code_0/1',
        parent_tool_call_id: 'code_0',
        parent_occurrence_id: 'occ-p2',
        name: 'message_bot',
        context: 'biology',
        args: { to: 'biology', text: 'Check', wait: true }
      })
    )
    expect(
      afterHydratedStart.tools.map(t => [t.parentOccurrenceId ?? null, Boolean(t.liveStarted)])
    ).toEqual([
      [null, false],
      ['occ-p2', true]
    ])

    // Untagged concurrent unpersisted parent in m2 must not shield persisted `occ-p1` nested ask.
    const replayedConcurrent = replayChat(replaySnapshot, [
      event('tool.start', {
        turn_id: 'T-rp2',
        message_id: 'm2',
        tool_id: 'code_0',
        name: 'codemode',
        args: { code: 'ask(2a)' }
      }),
      event('tool.start', {
        turn_id: 'T-rp2',
        tool_id: 'code_0/1',
        parent_tool_call_id: 'code_0',
        parent_occurrence_id: 'occ-p1',
        name: 'message_bot',
        context: 'biology',
        args: { to: 'biology', text: 'Check', wait: true }
      })
    ])
    expect(
      replayedConcurrent.state.tools.map(t => [
        t.name,
        t.occurrenceId ?? t.parentOccurrenceId ?? null,
        t.status
      ])
    ).toEqual([['codemode', null, 'running']])
  })
})
