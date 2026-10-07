import { describe, expect, it, vi } from 'vitest'

import { memoryMarks } from '../app/conversation/steps'

import { attachFile, messagesFromHistory } from './api'
import { rpcCall } from './rpc'

vi.mock('./rpc', () => ({ rpcCall: vi.fn() }))

describe('attachment size limits', () => {
  it.each([
    ['image.png', 'image/png', 25],
    ['document.pdf', 'application/pdf', 45],
    ['document.PDF', '', 45],
    ['archive.zip', 'application/zip', 45]
  ])('rejects oversized %s before reading or sending it', async (name, type, limit) => {
    const file = new File([], name, { type })
    Object.defineProperty(file, 'size', { value: (limit as number) * 1024 * 1024 + 1 })
    await expect(attachFile('session', file)).rejects.toThrow(`attachment exceeds ${limit} MiB`)
    expect(rpcCall).not.toHaveBeenCalled()
  })

  it('sends a supported file through the existing RPC', async () => {
    vi.mocked(rpcCall).mockResolvedValue({ attached: true })
    await expect(
      attachFile('session', new File(['hello'], 'small.txt', { type: 'text/plain' }))
    ).resolves.toEqual({ attached: true })
    expect(rpcCall).toHaveBeenCalledWith(
      'file.attach',
      expect.objectContaining({
        session_id: 'session',
        name: 'small.txt',
        data_url: 'data:text/plain;base64,aGVsbG8='
      })
    )
  })
})

describe('history projection', () => {
  it('keeps each message of a turn as its own part', () => {
    const [message] = messagesFromHistory([
      { role: 'assistant', text: 'I will check.' },
      { name: 'terminal', role: 'tool', text: 'ok' },
      { role: 'assistant', text: 'Done.' }
    ] as Parameters<typeof messagesFromHistory>[0])

    expect(message).toMatchObject({ parts: ['I will check.'], text: 'Done.' })
    expect(message?.toolCalls).toHaveLength(1)
    // History keeps no timestamps: no start time rather than the time it was reopened.
    expect(message?.toolCalls[0]?.startedAt).toBe(0)
  })

  it('restores each call with the arguments the assistant row made it with', () => {
    const [message] = messagesFromHistory([
      {
        role: 'assistant',
        text: '',
        tool_calls: [
          {
            function: {
              arguments: '{"title":"Costs","html":"<p>1</p>"}',
              name: 'hexbot_show_html'
            },
            id: 'call-1',
            type: 'function'
          }
        ]
      },
      {
        name: 'hexbot_show_html',
        role: 'tool',
        text: '{"shown":true}',
        tool_call_id: 'call-1',
        tool_id: 'call-1'
      },
      { role: 'assistant', text: 'Done.' }
    ] as Parameters<typeof messagesFromHistory>[0])

    expect(message?.toolCalls[0]?.args).toEqual({ html: '<p>1</p>', title: 'Costs' })
  })

  it('brings back the memory marks a reopened section showed live', () => {
    const [message] = messagesFromHistory([
      {
        role: 'assistant',
        text: '',
        tool_calls: [
          {
            function: { arguments: '{"action":"add","content":"Likes tea."}', name: 'memory' },
            id: 'call-2',
            type: 'function'
          }
        ]
      },
      { name: 'memory', role: 'tool', text: '{"ok":true}', tool_call_id: 'call-2' },
      { role: 'assistant', text: 'Noted.' }
    ] as Parameters<typeof messagesFromHistory>[0])

    expect(memoryMarks(message!)).toEqual([{ kind: 'memory', text: 'Likes tea.' }])
  })
})

it('restores nested code steps with their parent, arguments, duration and errors', () => {
  const [message] = messagesFromHistory([
    { role: 'assistant', text: '' },
    {
      role: 'tool',
      name: 'codemode',
      tool_id: 'code',
      text: 'done',
      is_error: true,
      nested_calls: {
        calls: [
          {
            id: 'code/1',
            name: 'mcp__github__list',
            arguments: { repo: 'hexbot' },
            durationMs: 12,
            status: 'ok'
          },
          {
            id: 'code/2',
            name: 'mcp__github__change',
            durationMs: 30,
            status: 'error',
            error: 'Denied'
          }
        ]
      }
    },
    { role: 'assistant', text: 'Finished' }
  ])

  expect(message?.toolCalls).toMatchObject([
    { toolId: 'code', name: 'codemode', status: 'error' },
    {
      toolId: 'code/1',
      parentToolCallId: 'code',
      args: { repo: 'hexbot' },
      durationS: 0.012,
      status: 'ok'
    },
    { toolId: 'code/2', parentToolCallId: 'code', result: 'Denied', status: 'error' }
  ])
})
