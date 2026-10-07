import { attachmentPrompt, submitChatPrompt } from './chat-send'
import { setActiveRpc } from './rpc'
import { useSections } from '../stores/sections'
import { emptyTranscript, useTranscripts } from '../stores/transcripts'

beforeEach(() => {
  useSections.setState(useSections.getInitialState())
  useTranscripts.getState().dropAll()
})
afterEach(() => setActiveRpc(null))

it('submits attachment-only sends with a nonempty prompt', async () => {
  const call = vi.fn().mockResolvedValue({ status: 'accepted' })
  setActiveRpc({ call } as never)
  await submitChatPrompt('live', 'section', attachmentPrompt('  ', true))
  expect(call).toHaveBeenCalledWith('prompt.submit', {
    session_id: 'live',
    text: 'Please review the attached files.'
  })
})

it('restages attachments on an expired session before resending', async () => {
  const call = vi.fn().mockImplementation((method: string, params: { session_id?: string }) => {
    if (method === 'prompt.submit' && params.session_id === 'old')
      return Promise.reject(new Error('session not found'))
    if (method === 'hexbot.sections.open')
      return Promise.resolve({
        section: { id: 'section', bot: 'ada', live_session_id: 'new' },
        messages: []
      })
    return Promise.resolve({ status: 'accepted' })
  })
  setActiveRpc({ call } as never)
  const restage = vi.fn().mockResolvedValue([{ id: 'photo', kind: 'image', name: 'photo.png' }])
  await submitChatPrompt('old', 'section', 'Please review the attached files.', restage)
  expect(restage).toHaveBeenCalledWith('new')
  expect(call).toHaveBeenLastCalledWith('prompt.submit', {
    session_id: 'new',
    text: 'Please review the attached files.'
  })
  expect(useTranscripts.getState().bySession.new?.messages[0]?.attachments).toHaveLength(1)
})

it('reports failed reopening without an unhandled rejection', async () => {
  const call = vi
    .fn()
    .mockRejectedValueOnce(new Error('session not found'))
    .mockRejectedValueOnce(new Error('Disconnected'))
  setActiveRpc({ call } as never)
  useTranscripts.setState({ bySession: { old: emptyTranscript('old', 'section') } })
  await submitChatPrompt('old', 'section', 'Hello')
  expect(useTranscripts.getState().bySession.old?.error).toBe('Disconnected')
})
