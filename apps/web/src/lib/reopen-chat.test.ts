import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { useConnection } from '../stores/connection'
import { useSections } from '../stores/sections'
import { resetTranscriptEffects, setTranscriptEffects, useTranscripts } from '../stores/transcripts'

import { setActiveRpc } from './rpc'
import type { DaemonInfo, Section } from './types'

const section = { id: 'chat', bot: 'owl', live_session_id: 'chat', peer_bot: null } as Section
const prior = [{ role: 'user', row_id: 'old-user', text: 'Earlier question' }]
let rows: object[] = prior
const texts = () => useTranscripts.getState().bySession.chat!.messages.map(m => m.text)

beforeEach(() => {
  useSections.setState({ byId: { chat: section }, idsByBot: { owl: ['chat'] }, liveSessionId: {} })
  useTranscripts.setState({ bySession: {} })
  setTranscriptEffects({ touchSection: () => {}, notify: () => {}, ackApproval: () => {} })
  rows = prior
  setActiveRpc({ call: vi.fn(() => Promise.resolve({ section, messages: rows })) } as never)
})
afterEach(() => {
  setActiveRpc(null)
  resetTranscriptEffects()
})

it.each([false, true])(
  'shows a sent message once after the chat is opened again, transcript identity=%s',
  async identity => {
    useConnection.setState({
      target: { kind: 'local' },
      epoch: 'process',
      daemon: { one_chat: true, ...(identity && { transcript_identity: true }) } as DaemonInfo
    })
    await useSections.getState().open('chat')
    useTranscripts.getState().appendUserMessage('chat', 'hi')
    // Saved without an input ID: an older daemon never stores one, and a
    // queued or steered input on a newer one may not.
    rows = [
      ...prior,
      { role: 'user', row_id: 'hi', text: 'hi' },
      { role: 'assistant', row_id: 'hello', text: 'Hello' }
    ]
    await useSections.getState().open('chat')
    expect(texts()).toEqual(['Earlier question', 'hi', 'Hello'])
  }
)

it('reopens a long chat with every row and tool once, with a message still unsaved', async () => {
  useConnection.setState({
    target: { kind: 'local' },
    epoch: 'process',
    daemon: { one_chat: true, transcript_identity: true } as DaemonInfo
  })
  const ids = (turn: number) => Array.from({ length: 10 }, (_, n) => `call-${turn}-${n}`)
  rows = Array.from({ length: 600 }, (_, turn) => [
    { role: 'user', row_id: `u${turn}`, text: `Question ${turn}`, input_id: `i${turn}` },
    {
      role: 'assistant',
      row_id: `c${turn}`,
      text: '',
      turn_id: `t${turn}`,
      tool_calls: ids(turn).map(id => ({ id, function: { name: 'read', arguments: '{}' } }))
    },
    ...ids(turn).map(id => ({
      role: 'tool',
      row_id: `r-${id}`,
      tool_call_id: id,
      name: 'read',
      text: 'ok',
      turn_id: `t${turn}`
    })),
    { role: 'assistant', row_id: `a${turn}`, text: `Answer ${turn}`, turn_id: `t${turn}` }
  ]).flat()
  await useSections.getState().open('chat')
  const shown = () => useTranscripts.getState().bySession.chat!.messages
  const before = shown().map(m => [m.id, m.text, m.toolCalls.length])
  // A message not saved yet keeps the merge on the slow path.
  useTranscripts
    .getState()
    .appendUserMessage('chat', 'Still sending', [
      { id: 'f', name: 'f.txt', mime: 'text/plain', size: 1, kind: 'file', path: '/f.txt' }
    ])
  await useSections.getState().open('chat')
  expect(
    shown()
      .slice(0, -1)
      .map(m => [m.id, m.text, m.toolCalls.length])
  ).toEqual(before)
  expect(shown().at(-1)!.text).toBe('Still sending')
  expect(shown().flatMap(m => m.toolCalls)).toHaveLength(6000)
})
