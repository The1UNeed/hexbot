import { describe, it, expect } from 'vitest'
import { mediaOf } from '../../../web/src/lib/media'
import { settledCard } from '../../../web/src/lib/settled-cards'
import {
  heartbeatMessage,
  emptyChat,
  reduceChat,
  historyMessages,
  replayChat,
  sharedFiles
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
    const cards = (state: { tools?: { args: unknown; detail: string; name: string; status: 'error' | 'ok' | 'running' }[] }[]) =>
      state.flatMap(m => m.tools ?? []).map(t => settledCard({ ...t, result: t.detail }))
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
