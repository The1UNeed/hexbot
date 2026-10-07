import { messagesFromHistory } from './api'

describe('restored tool arguments', () => {
  it('uses the assistant call arguments for the matching tool result', () => {
    const messages = messagesFromHistory([
      {
        role: 'assistant',
        text: '',
        tool_calls: [
          { id: 'call-1', function: { name: 'read', arguments: '{"path":"README.md"}' } }
        ]
      },
      { role: 'tool', tool_call_id: 'call-1', name: 'read', text: 'Contents' },
      { role: 'assistant', text: 'Read it.' }
    ])
    expect(messages).toHaveLength(1)
    expect(messages[0]?.toolCalls[0]?.args).toEqual({ path: 'README.md' })
  })

  it('preserves malformed JSON and explicit arguments on old history rows', () => {
    const messages = messagesFromHistory([
      {
        role: 'assistant',
        tool_calls: [
          { id: 'call-1', function: { arguments: '{broken' } },
          { id: 'call-2', function: { arguments: '{"path":"other"}' } }
        ]
      },
      { role: 'tool', tool_call_id: 'call-1', name: 'read' },
      { role: 'tool', tool_id: 'call-2', name: 'read', args: { path: 'explicit' } }
    ])
    expect(messages[0]?.toolCalls.map(call => call.args)).toEqual(['{broken', { path: 'explicit' }])
  })
})
