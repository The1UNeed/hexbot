import { describe, it, expect } from 'vitest'
import { emptyChat, reduceChat, historyMessages, replayChat } from './chat'
import type { GatewayEvent } from '@hermes/shared'
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
