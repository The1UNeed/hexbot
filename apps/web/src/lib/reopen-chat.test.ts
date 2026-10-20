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
