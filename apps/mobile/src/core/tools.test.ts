import { describe, expect, it } from 'vitest'
import { activityLabel, chatActivityLabel, readableResult, resultLine, toolLabel } from './tools'
import type { GatewayEvent } from '@hermes/shared'
import type { Room } from './types'
import { emptyChat, reduceChat } from './chat'
import { reduceRoom, restoreRoom } from './room-chat'

describe('tool wording', () => {
  it('names known tools in plain words and falls back to the tool name', () => {
    expect(toolLabel('write_file')).toBe('Wrote a file')
    expect(toolLabel('write_file', true)).toBe('Writing a file')
    expect(toolLabel('hexbot_show_html')).toBe('Showed a visual')
    expect(toolLabel('github_create_issue')).toBe('Github create issue')
    expect(activityLabel('Using web_search')).toBe('Searching the web')
    expect(activityLabel('Thinking')).toBe('Thinking')
  })

  it('unwraps MCP-style results, including JSON inside the text', () => {
    const wrapped = JSON.stringify({ content: [{ type: 'text', text: 'Saved 3 files.' }] })
    expect(readableResult(wrapped)).toBe('Saved 3 files.')
    expect(resultLine(wrapped)).toBe('Saved 3 files.')
    const nested = JSON.stringify({
      content: [{ type: 'text', text: JSON.stringify({ when: 'Morning' }) }],
      details: {}
    })
    expect(readableResult(nested)).toBe('{\n  "when": "Morning"\n}')
    expect(resultLine(nested)).toBe('')
    expect(readableResult('plain output')).toBe('plain output')
    expect(readableResult('{not json')).toBe('{not json')
  })
})

const wire = (type: string, payload: Record<string, unknown>, session_id = 'a'): GatewayEvent => ({
  type,
  payload,
  session_id
})
const retry = (state: ReturnType<typeof emptyChat>) => {
  // runtime.rs auto_retry_start emits both events without asking the user anything.
  state = reduceChat(state, wire('thinking.delta', { text: 'Retrying the model request' }))
  return reduceChat(
    state,
    wire('status.update', { kind: 'waiting', text: 'Retrying the model request' })
  )
}
const room: Room = {
  id: 'room',
  name: 'Planning',
  owner_id: 'owner',
  main_bot: 'alpha',
  approval_mode: null,
  limits: {},
  archived_at: null,
  created_at: 0,
  updated_at: 0,
  last_activity_at: 0,
  members: [],
  turns: [
    { bot: 'alpha', live_session_id: 'a' },
    { bot: 'beta', live_session_id: 'b' }
  ]
}
const roomReduce = (state: ReturnType<typeof emptyChat>, event: GatewayEvent) =>
  reduceRoom(state, event, room, bot => (bot === 'alpha' ? 'Alpha display' : 'Beta display'))

describe('conversation activity wording', () => {
  it('keeps the private automatic retry explanation without a human request', () => {
    const state = retry(emptyChat())
    expect(state).toMatchObject({ busy: true, waiting: true, approvals: [], questions: [] })
    expect(chatActivityLabel(state)).toBe('Retrying the model request')
  })

  it('shows tool activity after a retry when the resumed text becomes an interim reply', () => {
    let state = reduceChat(emptyChat(), wire('message.start', {}))
    state = reduceChat(state, wire('status.update', { kind: 'working', text: 'Working' }))
    state = retry(state)
    state = reduceChat(state, wire('message.delta', { text: 'Checking the file.' }))
    // A tool-calling assistant message ends as an interim reply, without another Working event.
    state = reduceChat(
      state,
      wire('message.interim', { text: 'Checking the file.', already_streamed: true })
    )
    state = reduceChat(
      state,
      wire('tool.start', { tool_id: 'read', name: 'read_file', args: { path: 'report' } })
    )
    expect(state).toMatchObject({
      busy: true,
      waiting: true,
      streaming: '',
      approvals: [],
      questions: []
    })
    expect(state.interim).toEqual(['Checking the file.'])
    expect(state.tools[0]).toMatchObject({ name: 'read_file', status: 'running' })
    expect(chatActivityLabel(state)).toBe('Reading a file')
  })

  it('keeps generic activity wording and existing tool labels', () => {
    const state = reduceChat(
      emptyChat(),
      wire('status.update', { kind: 'waiting', text: 'Using read_file' })
    )
    expect(chatActivityLabel(state)).toBe('Reading a file')
    expect(chatActivityLabel(emptyChat())).toBe('Working')
  })

  it('shows Waiting for a native approval even without a waiting status update', () => {
    let state = reduceChat(
      emptyChat(),
      wire('approval.request', { request_id: 'approval', command: 'touch report' })
    )
    state = reduceChat(state, wire('thinking.delta', { text: 'Working' }))
    expect(chatActivityLabel(state)).toBe('Waiting')
    state = reduceChat(state, wire('approval.resolved', { request_id: 'approval', choice: 'once' }))
    expect(chatActivityLabel(retry(state))).toBe('Retrying the model request')
  })

  it('keeps Waiting through partial clarification, then shows the next automatic wait', () => {
    let state = reduceChat(
      emptyChat(),
      wire('clarify.request', {
        request_id: 'batch',
        questions: [
          { qid: 'first', question: 'When?' },
          { qid: 'first', question: 'When again?' },
          { qid: 'second', question: 'Where?' }
        ]
      })
    )
    state = reduceChat(
      state,
      wire('clarify.resolved', { request_id: 'batch', status: 'waiting', answers: { first: '' } })
    )
    expect(state.questions[0].questions.map(q => q.id)).toEqual(['second'])
    expect(chatActivityLabel(state)).toBe('Waiting')
    state = reduceChat(
      state,
      wire('clarify.resolved', {
        request_id: 'batch',
        status: 'answered',
        answers: { first: '', second: 'Here' }
      })
    )
    expect(chatActivityLabel(retry(state))).toBe('Retrying the model request')
  })

  it('keeps automatic retry and sibling room activity, reserving Waiting for a pending human card', () => {
    let state = restoreRoom(room, [])
    state = roomReduce(state, wire('thinking.delta', { text: 'Retrying the model request' }))
    state = roomReduce(
      state,
      wire('status.update', { kind: 'waiting', text: 'Retrying the model request' })
    )
    state = roomReduce(
      state,
      wire(
        'hexbot.rooms.turn',
        { room_id: room.id, bot: 'beta', live_session_id: 'b', status: 'working' },
        ''
      )
    )
    expect(chatActivityLabel(state)).toBe('Retrying the model request · Beta display is working')
    state = roomReduce(state, wire('approval.request', { request_id: 'approval' }, 'b'))
    expect(chatActivityLabel(state)).toBe('Waiting')
    state = roomReduce(
      state,
      wire('approval.resolved', { request_id: 'approval', choice: 'once' }, 'b')
    )
    expect(state.waiting).toBe(true)
    expect(chatActivityLabel(state)).toBe('Retrying the model request')
  })

  it('preserves named room wait text when no human card has been confirmed', () => {
    const state = roomReduce(
      restoreRoom(room, []),
      wire(
        'hexbot.rooms.turn',
        {
          room_id: room.id,
          bot: 'alpha',
          live_session_id: 'a',
          status: 'waiting'
        },
        ''
      )
    )
    expect(chatActivityLabel(state)).toBe('Alpha display is waiting')
  })
})
