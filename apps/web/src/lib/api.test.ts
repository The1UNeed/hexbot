import { JsonRpcGatewayError } from '@hermes/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  attachFile,
  botsCreate,
  botsUpdate,
  messagesFromHistory,
  PART_BYTES,
  WholeFilesOnly
} from './api'
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

  it('sends a file in parts, saying how much the daemon has, then attaches it', async () => {
    vi.mocked(rpcCall).mockReset().mockResolvedValue({ attached: true })
    const bytes = new Uint8Array(PART_BYTES * 2.5).map((_, i) => i % 251)
    const progress: (number | undefined)[] = []
    await expect(
      attachFile('session', new File([bytes], 'notes.bin', { type: 'application/octet-stream' }), {
        onProgress: value => progress.push(value)
      })
    ).resolves.toEqual({ attached: true })
    const calls = vi.mocked(rpcCall).mock.calls as [string, Record<string, unknown>][]
    expect(calls.map(([method, input]) => [method, input.offset])).toEqual([
      ['attachments.part', 0],
      ['attachments.part', PART_BYTES],
      ['attachments.part', PART_BYTES * 2],
      ['file.attach', undefined]
    ])
    const upload = calls[0]![1].upload
    expect(
      calls.every(([, input]) => input.upload === upload && input.session_id === 'session')
    ).toBe(true)
    expect(calls[3]![1]).toEqual({ name: 'notes.bin', session_id: 'session', upload })

    const sent = calls
      .slice(0, 3)
      .flatMap(([, input]) => [...Buffer.from(String(input.data), 'base64')])

    expect(sent).toEqual([...bytes])
    // Whole only when the daemon answers the attach.
    expect(progress).toEqual([0.4, 0.8, 0.99])
  })

  it('sends the file whole to a daemon without part uploads', async () => {
    vi.mocked(rpcCall)
      .mockReset()
      .mockRejectedValueOnce(new JsonRpcGatewayError('unknown runtime method', { code: -32601 }))
      .mockResolvedValue({ attached: true })
    await expect(
      attachFile('old-chat', new File(['hello'], 'small.txt', { type: 'text/plain' }))
    ).resolves.toEqual({ attached: true })
    expect(rpcCall).toHaveBeenLastCalledWith('file.attach', {
      session_id: 'old-chat',
      name: 'small.txt',
      data_url: 'data:text/plain;base64,aGVsbG8='
    })
    // Asked once: the next file there goes whole straight away.
    await attachFile('old-chat', new File(['again'], 'again.txt', { type: 'text/plain' }))
    expect(vi.mocked(rpcCall).mock.calls.map(([method]) => method)).toEqual([
      'attachments.part',
      'file.attach',
      'file.attach'
    ])
  })

  it('stages nothing ahead of Send on a daemon without part uploads', async () => {
    vi.mocked(rpcCall)
      .mockReset()
      .mockRejectedValueOnce(new JsonRpcGatewayError('unknown runtime method', { code: -32601 }))
    await expect(
      attachFile('older-chat', new File(['hello'], 'small.txt'), { ahead: true })
    ).rejects.toBeInstanceOf(WholeFilesOnly)
    expect(vi.mocked(rpcCall).mock.calls.map(([method]) => method)).toEqual(['attachments.part'])
  })

  it('sends nothing more once nobody wants the file', async () => {
    vi.mocked(rpcCall).mockReset().mockResolvedValue({})
    const stop = new AbortController()
    const file = new File([new Uint8Array(PART_BYTES * 3)], 'big.bin')

    const sent = attachFile('session', file, {
      onProgress: () => stop.abort(),
      signal: stop.signal
    })

    await expect(sent).rejects.toThrow()
    expect(vi.mocked(rpcCall).mock.calls.map(([method]) => method)).toEqual(['attachments.part'])
  })
})

describe('PDF attachments', () => {
  beforeEach(() => vi.mocked(rpcCall).mockReset())

  it('sends a PDF as a file when the daemon cannot render its pages', async () => {
    vi.mocked(rpcCall)
      .mockResolvedValueOnce({ received: 8 })
      .mockRejectedValueOnce(
        new JsonRpcGatewayError('pdftoppm not installed (poppler-utils package required)', {
          code: 5028
        })
      )
      .mockResolvedValueOnce({ attached: true, path: '/s/attachments/a-board.pdf' })

    await expect(
      attachFile('session', new File(['%PDF-1.4'], 'board.pdf', { type: 'application/pdf' }))
    ).resolves.toEqual({ attached: true, path: '/s/attachments/a-board.pdf' })
    const calls = vi.mocked(rpcCall).mock.calls as [string, Record<string, unknown>][]
    expect(calls.map(([method]) => method)).toEqual([
      'attachments.part',
      'pdf.attach',
      'file.attach'
    ])
    // The daemon keeps the parts of a PDF it could not draw, for the file.
    expect(calls[2]![1].upload).toBe(calls[0]![1].upload)
  })

  it('keeps any other refusal', async () => {
    vi.mocked(rpcCall)
      .mockResolvedValueOnce({ received: 4 })
      .mockRejectedValueOnce(new JsonRpcGatewayError('payload is not a PDF', { code: 4017 }))

    await expect(
      attachFile('session', new File(['nope'], 'board.pdf', { type: 'application/pdf' }))
    ).rejects.toThrow('payload is not a PDF')
    expect(rpcCall).toHaveBeenCalledTimes(2)
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
    // History keeps no tool start times: none rather than the time it was reopened.
    expect(message?.toolCalls[0]?.startedAt).toBe(0)
  })

  it('keeps when each message was sent, and still marks it as history', () => {
    const messages = messagesFromHistory([
      { role: 'user', text: 'Morning', timestamp: 1_793_340_000.5 },
      { role: 'assistant', text: 'I will check.', timestamp: 1_793_340_010 },
      { name: 'terminal', role: 'tool', text: 'ok', timestamp: 1_793_340_020 },
      { role: 'assistant', text: 'Done.', timestamp: 1_793_340_030 },
      { role: 'user', text: 'Unknown' }
    ] as Parameters<typeof messagesFromHistory>[0])

    expect(messages.map(message => [message.createdAt, message.sentAt])).toEqual([
      [0, 1_793_340_000_500],
      // A reply is sent when it ends, not when its first step began.
      [0, 1_793_340_030_000],
      [0, undefined]
    ])
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

  it('brings back the files you sent as attachments, not as text', () => {
    const kept = '/h/runtime/sessions/s/attachments/0123456789abcdef0123456789abcdef-clip.mp4'

    const [mine, theirs] = messagesFromHistory([
      { role: 'user', text: `Watch this\n\nAttached files:\n${kept}` },
      { role: 'assistant', text: 'Attached files:\nnot a list of yours' }
    ] as Parameters<typeof messagesFromHistory>[0])

    expect(mine?.text).toBe('Watch this')
    expect(mine?.attachments).toEqual([
      { id: kept, kind: 'video', mime: 'video/mp4', name: 'clip.mp4', path: kept }
    ])
    expect(theirs?.attachments).toEqual([])
  })

  it('brings back a sent draft card under the message whose tool showed it', () => {
    // The rows the daemon stores for "write the admissions email": the draft
    // call, the user sending it from the card, then the bot's reply.
    const messages = messagesFromHistory([
      { role: 'user', row_id: 'u1', text: 'Write to admissions', turn_id: 't' },
      {
        role: 'assistant',
        row_id: 'a1',
        text: '',
        tool_calls: [
          {
            function: {
              arguments:
                '{"action":"draft","subject":"Report cards","body":"Dear Admissions Team,"}',
              name: 'hexbot_mail'
            },
            id: 'm1',
            type: 'function'
          }
        ],
        turn_id: 't'
      },
      {
        name: 'hexbot_mail',
        role: 'tool',
        text: '{"account":"microsoft","body":"Dear Admissions Team,","cc":[],"sent":true,"subject":"Report cards","to":["admission@example.com"]}',
        tool_call_id: 'm1',
        tool_id: 'm1',
        turn_id: 't'
      },
      { role: 'assistant', row_id: 'a2', text: 'Sent to the admissions team.', turn_id: 't' }
    ] as Parameters<typeof messagesFromHistory>[0])

    // The card ends its message, as it does live, so it sits before the reply.
    expect(messages.map(message => message.text)).toEqual([
      'Write to admissions',
      '',
      'Sent to the admissions team.'
    ])
    expect(messages[1]?.approvals).toMatchObject([
      {
        decision: 'once',
        form: { kind: 'email_draft', service: 'microsoft', subject: 'Report cards' },
        messageId: 'a1',
        outcome: { draft: { to: ['admission@example.com'] }, mail_action: 'send' },
        requestId: 'm1',
        turnId: 't'
      }
    ])
    expect(messages[2]?.approvals).toBeUndefined()
  })

  it('brings back each answered question under the message that asked it', () => {
    const ask = (id: string, args: object) => ({
      role: 'assistant',
      tool_calls: [
        { function: { arguments: JSON.stringify(args), name: 'clarify' }, id, type: 'function' }
      ]
    })

    const messages = messagesFromHistory([
      { ...ask('c1', { choices: ['Research', 'Writing'], question: 'What for?' }), text: 'Hi.' },
      { name: 'clarify', role: 'tool', text: 'Research', tool_call_id: 'c1', tool_id: 'c1' },
      {
        ...ask('c2', {
          questions: [
            { choices: ['Short', 'Long'], question: 'How long?' },
            { multi_select: true, question: 'Which topics?' }
          ]
        }),
        text: 'Got it.'
      },
      {
        name: 'clarify',
        role: 'tool',
        text: '{"q1":"Short","q2":"[\\"AI\\",\\"Money\\"]"}',
        tool_call_id: 'c2',
        tool_id: 'c2'
      },
      { ...ask('c3', { question: 'Anything else?' }), text: 'Noted.' },
      {
        name: 'clarify',
        role: 'tool',
        text: 'The question was cancelled.',
        tool_call_id: 'c3',
        tool_id: 'c3'
      },
      { role: 'assistant', text: 'Done.' }
    ] as Parameters<typeof messagesFromHistory>[0])

    // Each question ends its message, as it does live, so its card sits between.
    expect(messages.map(message => message.text)).toEqual(['Hi.', 'Got it.', 'Noted.', 'Done.'])
    expect(messages[0]?.clarifies).toEqual([
      {
        answers: { c1: 'Research' },
        expired: undefined,
        questions: [
          { choices: ['Research', 'Writing'], multiSelect: false, question: 'What for?' }
        ],
        receivedAt: 0,
        requestId: 'c1',
        sessionId: ''
      }
    ])
    expect(messages[1]?.clarifies?.[0]).toMatchObject({
      answers: { q1: 'Short', q2: '["AI","Money"]' },
      questions: [
        { question: 'How long?', questionId: 'q1' },
        { multiSelect: true, question: 'Which topics?', questionId: 'q2' }
      ]
    })
    expect(messages[1]?.clarifies?.[0]?.expired).toBeUndefined()
    expect(messages[2]?.clarifies?.[0]).toMatchObject({ answers: {}, expired: true })
    expect(messages[3]?.clarifies).toBeUndefined()
  })

  it('skips a question the tool refused before asking', () => {
    const [message] = messagesFromHistory([
      {
        role: 'assistant',
        text: 'Hi.',
        tool_calls: [{ function: { arguments: '{}', name: 'clarify' }, id: 'c1', type: 'function' }]
      },
      {
        is_error: true,
        name: 'clarify',
        role: 'tool',
        text: 'A question is required',
        tool_call_id: 'c1',
        tool_id: 'c1'
      }
    ] as Parameters<typeof messagesFromHistory>[0])

    expect(message?.clarifies).toBeUndefined()
  })

  it('numbers a batch whose ids are not text, as the daemon does', () => {
    const [message] = messagesFromHistory([
      {
        role: 'assistant',
        text: 'Hi.',
        tool_calls: [
          {
            function: { arguments: '{"questions":[{"qid":1,"question":"Why?"}]}', name: 'clarify' },
            id: 'c1',
            type: 'function'
          }
        ]
      },
      { name: 'clarify', role: 'tool', text: '{"q1":"Because"}', tool_call_id: 'c1', tool_id: 'c1' }
    ] as Parameters<typeof messagesFromHistory>[0])

    expect(message?.clarifies?.[0]).toMatchObject({
      answers: { q1: 'Because' },
      questions: [{ questionId: 'q1' }]
    })
    expect(message?.clarifies?.[0]?.expired).toBeUndefined()
  })

  it('settles a batch whose questions share an id with one answer', () => {
    const [message] = messagesFromHistory([
      {
        role: 'assistant',
        text: 'Hi.',
        tool_calls: [
          {
            function: {
              arguments: '{"questions":[{"qid":"q2","question":"Why?"},{"question":"How?"}]}',
              name: 'clarify'
            },
            id: 'c1',
            type: 'function'
          }
        ]
      },
      { name: 'clarify', role: 'tool', text: '{"q2":"Because"}', tool_call_id: 'c1', tool_id: 'c1' }
    ] as Parameters<typeof messagesFromHistory>[0])

    expect(message?.clarifies?.[0]?.expired).toBeUndefined()
  })

  it('keeps a batch unanswered when an id names an inherited property', () => {
    const [message] = messagesFromHistory([
      {
        role: 'assistant',
        text: 'Hi.',
        tool_calls: [
          {
            function: {
              arguments: '{"questions":[{"qid":"constructor","question":"Why?"}]}',
              name: 'clarify'
            },
            id: 'c1',
            type: 'function'
          }
        ]
      },
      {
        name: 'clarify',
        role: 'tool',
        text: 'The question was cancelled.',
        tool_call_id: 'c1',
        tool_id: 'c1'
      }
    ] as Parameters<typeof messagesFromHistory>[0])

    expect(message?.clarifies?.[0]).toMatchObject({ answers: {}, expired: true })
  })

  it('leaves a question still waiting to the live card', () => {
    const [message] = messagesFromHistory([
      {
        role: 'assistant',
        text: 'Hi.',
        tool_calls: [
          {
            function: { arguments: '{"question":"What for?"}', name: 'clarify' },
            id: 'c1',
            type: 'function'
          }
        ]
      }
    ] as Parameters<typeof messagesFromHistory>[0])

    expect(message?.clarifies).toBeUndefined()
  })

  it('restores unmatched running message_bot declarations only when busy is true', () => {
    const rows = [
      { role: 'user', row_id: 'u0', text: 'Old' },
      {
        role: 'assistant',
        row_id: 'a0',
        text: 'Old reply.',
        tool_calls: [
          { function: { arguments: '{"to":"old"}', name: 'message_bot' }, id: 'c0', type: 'function' }
        ],
        turn_id: 'T0'
      },
      { role: 'user', row_id: 'u1', text: 'Ask Biology' },
      {
        role: 'assistant',
        row_id: 'a1',
        text: 'Checking.',
        tool_calls: [
          {
            function: { arguments: '{"to":"chemistry"}', name: 'message_bot' },
            id: 'call_0',
            type: 'function'
          },
          {
            function: { arguments: '{"to":"biology"}', name: 'message_bot' },
            id: 'call_1',
            type: 'function'
          }
        ],
        turn_id: 'T1'
      },
      {
        name: 'message_bot',
        role: 'tool',
        text: '{"section_id":"th-chem"}',
        tool_call_id: 'call_0',
        turn_id: 'T1'
      }
    ] as Parameters<typeof messagesFromHistory>[0]

    const busyMessages = messagesFromHistory(rows, { busy: true })
    expect(busyMessages.at(-1)?.toolCalls).toMatchObject([
      { args: { to: 'chemistry' }, name: 'message_bot', status: 'ok', toolId: 'call_0' },
      {
        args: { to: 'biology' },
        messageId: 'a1',
        name: 'message_bot',
        startedAt: 0,
        status: 'running',
        toolId: 'call_1'
      }
    ])
    // Earlier exchange's unmatched declaration is NOT restored.
    expect(busyMessages[1]?.toolCalls).toEqual([])

    // Idle chats do not restore unmatched running declarations.
    const idleMessages = messagesFromHistory(rows, { busy: false })
    expect(idleMessages.at(-1)?.toolCalls).toMatchObject([
      { args: { to: 'chemistry' }, name: 'message_bot', status: 'ok', toolId: 'call_0' }
    ])

    // An earlier non-message_bot tool (e.g. web_search) sharing call_0 and context "biology"
    // must NOT consume an active message_bot(to: "biology") declaration.
    const mixedRows = [
      { role: 'user', row_id: 'u2', text: 'Search then ask Biology' },
      {
        role: 'assistant',
        row_id: 's1',
        text: 'Searching.',
        tool_calls: [
          { function: { arguments: '{"query":"biology"}', name: 'web_search' }, id: 'call_0', type: 'function' }
        ],
        turn_id: 'T2'
      },
      {
        context: 'biology',
        name: 'web_search',
        role: 'tool',
        text: 'search results',
        tool_call_id: 'call_0',
        turn_id: 'T2'
      },
      {
        role: 'assistant',
        row_id: 's2',
        text: 'Asking.',
        tool_calls: [
          { function: { arguments: '{"to":"biology"}', name: 'message_bot' }, id: 'call_0', type: 'function' }
        ],
        turn_id: 'T2'
      }
    ] as Parameters<typeof messagesFromHistory>[0]

    const mixedMessages = messagesFromHistory(mixedRows, { busy: true })
    expect(
      mixedMessages.flatMap(m => m.toolCalls).filter(c => c.name === 'message_bot')
    ).toMatchObject([
      { args: { to: 'biology' }, messageId: 's2', name: 'message_bot', status: 'running', toolId: 'call_0' }
    ])
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

it('preserves wait:false outcome and section_id on persisted nested message_bot calls', async () => {
  const { asksOf } = await import('./asks')

  const [message] = messagesFromHistory([
    { role: 'assistant', text: '' },
    {
      role: 'tool',
      name: 'codemode',
      tool_id: 'code',
      text: 'done',
      nested_calls: {
        calls: [
          {
            id: 'code/1',
            name: 'message_bot',
            arguments: { to: 'biology', text: 'FYI', wait: false },
            durationMs: 15,
            status: 'ok'
          },
          {
            id: 'code/2',
            name: 'message_bot',
            arguments: { to: 'chemistry', text: 'FYI', wait: false },
            durationMs: 12,
            section_id: 'th-chem',
            status: 'ok'
          }
        ]
      }
    },
    { role: 'assistant', text: 'Notified both.' }
  ])

  expect(asksOf(message?.toolCalls ?? [])).toEqual([
    { sectionId: null, sent: true, status: 'ok', target: 'biology' },
    { sectionId: 'th-chem', sent: true, status: 'ok', target: 'chemistry' }
  ])
})

it('disambiguates same-fragment call_0 declarations by text and wait mode when restoring pending asks', () => {
  const pendingByText = messagesFromHistory(
    [
      { role: 'user', text: 'Ask writer twice' },
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
            function: {
              name: 'message_bot',
              arguments: '{"to":"writer","text":"second","wait":true}'
            }
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
    ],
    { busy: true }
  )

  const runningByText = pendingByText
    .flatMap(m => m.toolCalls)
    .filter(c => c.status === 'running')
    .map(c => (c.args as { text?: string } | null)?.text)

  expect(runningByText).toEqual(['first'])

  const pendingByWait = messagesFromHistory(
    [
      { role: 'user', text: 'Send and wait' },
      {
        role: 'assistant',
        row_id: 'a2',
        turn_id: 'T2',
        text: '',
        tool_calls: [
          {
            id: 'call_0',
            function: { name: 'message_bot', arguments: '{"to":"writer","text":"Q","wait":false}' }
          },
          {
            id: 'call_0',
            function: { name: 'message_bot', arguments: '{"to":"writer","text":"Q","wait":true}' }
          }
        ]
      },
      {
        role: 'tool',
        row_id: 't2',
        turn_id: 'T2',
        message_id: 'a2',
        tool_call_id: 'call_0',
        name: 'message_bot',
        context: 'writer',
        is_error: true,
        args: { to: 'writer', text: 'Q', wait: true },
        text: '{"error":"timed out"}'
      }
    ],
    { busy: true }
  )

  const runningByWait = pendingByWait
    .flatMap(m => m.toolCalls)
    .filter(c => c.status === 'running')
    .map(c => (c.args as { wait?: boolean } | null)?.wait)

  expect(runningByWait).toEqual([false])

  // Live asks from `sections.open` prevent a rejected sibling from reviving as running while
  // Pi still buffers the parallel batch's toolResult rows.
  const withLiveAsks = messagesFromHistory(
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
    {
      asks: [
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
      ],
      busy: true
    }
  )

  expect(
    withLiveAsks.flatMap(m => m.toolCalls).map(c => ({
      status: c.status,
      to: (c.args as { to?: string } | null)?.to
    }))
  ).toEqual([
    { status: 'running', to: 'fox' },
    { status: 'error', to: 'ghost' }
  ])

  // Untrimmed whitespace handles (`"fox "` / `" ghost"`) match their rejected snapshot ask.
  const withWhitespaceHandle = messagesFromHistory(
    [
      { role: 'user', text: 'Ask fox and padded handle' },
      {
        role: 'assistant',
        row_id: 'a4',
        turn_id: 'T4',
        text: '',
        tool_calls: [
          {
            id: 'call_0',
            function: { name: 'message_bot', arguments: '{"to":"fox","text":"Hi","wait":true}' }
          },
          {
            id: 'call_0',
            function: { name: 'message_bot', arguments: '{"to":"fox ","text":"Hi","wait":true}' }
          },
          {
            id: 'call_0',
            function: { name: 'message_bot', arguments: '{"to":" ghost","text":"Hi","wait":true}' }
          }
        ]
      }
    ],
    {
      asks: [
        {
          args: { to: 'fox', text: 'Hi', wait: true },
          context: 'fox',
          message_id: 'a4',
          section_id: 'th-fox',
          status: 'running',
          tool_id: 'call_0',
          turn_id: 'T4'
        },
        {
          args: { to: 'fox ', text: 'Hi', wait: true },
          context: 'fox ',
          message_id: 'a4',
          result: { error: 'Unknown bot: fox ' },
          status: 'error',
          tool_id: 'call_0',
          turn_id: 'T4'
        },
        {
          args: { to: ' ghost', text: 'Hi', wait: true },
          context: ' ghost',
          message_id: 'a4',
          result: { error: 'Unknown bot:  ghost' },
          status: 'error',
          tool_id: 'call_0',
          turn_id: 'T4'
        }
      ],
      busy: true
    }
  )

  expect(withWhitespaceHandle.flatMap(m => m.toolCalls).map(c => c.status)).toEqual([
    'running',
    'error',
    'error'
  ])

  // Persisted nested codemode ask from turn t1 is NOT duplicated onto fallback turn t2.
  const fallbackNested = messagesFromHistory(
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
    {
      asks: [
        {
          args: { to: 'fox', text: 'Hi', wait: true },
          context: 'fox',
          parent_tool_call_id: 'code',
          section_id: 'th-fox',
          status: 'ok',
          tool_id: 'code/1',
          turn_id: 't1'
        }
      ],
      busy: true
    }
  )

  expect(
    fallbackNested.flatMap(m => m.toolCalls).filter(c => c.name === 'message_bot')
  ).toHaveLength(1)

  // Persisted error result consumes only the matching settled snapshot ask, never a running sibling.
  const persistedErrorWithRunningSibling = messagesFromHistory(
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
    {
      asks: [
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
      ],
      busy: true
    }
  )

  expect(persistedErrorWithRunningSibling.flatMap(m => m.toolCalls).map(c => c.status)).toEqual([
    'running',
    'error'
  ])

  // Persisted nested codemode ask must not consume an earlier running snapshot sibling.
  const nestedParallelMessages = messagesFromHistory(
    [
      { content: 'Check two scripts', role: 'user' },
      {
        content: '',
        role: 'assistant',
        row_id: 'a-np',
        tool_calls: [
          {
            function: { arguments: '{"code":"ask(fox)"}', name: 'codemode' },
            id: 'call_0',
            occurrence_id: 'occ-p1'
          },
          {
            function: { arguments: '{"code":"ask(fox)"}', name: 'codemode' },
            id: 'call_0',
            occurrence_id: 'occ-p2'
          }
        ],
        turn_id: 'T-np'
      },
      {
        name: 'codemode',
        nested_calls: {
          calls: [
            {
              arguments: { text: 'Ping', to: 'fox', wait: true },
              id: 'call_0/1',
              name: 'message_bot',
              section_id: 'th-fox',
              status: 'ok'
            }
          ]
        },
        occurrence_id: 'occ-p2',
        role: 'tool',
        text: 'done',
        tool_call_id: 'call_0',
        turn_id: 'T-np'
      }
    ],
    {
      asks: [
        {
          args: { text: 'Ping', to: 'fox', wait: true },
          context: 'fox',
          parent_occurrence_id: 'occ-p1',
          parent_tool_call_id: 'call_0',
          status: 'running',
          tool_id: 'call_0/1',
          turn_id: 'T-np'
        },
        {
          args: { text: 'Ping', to: 'fox', wait: true },
          context: 'fox',
          parent_occurrence_id: 'occ-p2',
          parent_tool_call_id: 'call_0',
          section_id: 'th-fox',
          status: 'ok',
          tool_id: 'call_0/1',
          turn_id: 'T-np'
        }
      ],
      busy: true
    }
  )

  const nestedAskCalls = nestedParallelMessages
    .flatMap(m => m.toolCalls)
    .filter(c => c.name === 'message_bot')

  expect(nestedAskCalls.map(c => [c.parentOccurrenceId, c.status])).toEqual([
    ['occ-p2', 'ok'],
    ['occ-p1', 'running']
  ])
})

describe('picked faces on older daemons', () => {
  const face = { color: 'orange', shape: 'pill' }
  const avatar = 'data:image/png;base64,iVBORw0KGgo='
  const unknownFace = () => new JsonRpcGatewayError('unknown bot field: face', { code: 4201 })

  beforeEach(() => {
    vi.mocked(rpcCall).mockReset()
  })

  it('sends the write again without the face, keeping its picture', async () => {
    vi.mocked(rpcCall).mockRejectedValueOnce(unknownFace()).mockResolvedValueOnce({ bot: {} })

    await botsUpdate('owl', { avatar, face })

    expect(rpcCall).toHaveBeenCalledTimes(2)
    expect(rpcCall).toHaveBeenLastCalledWith('hexbot.bots.update', { avatar, name: 'owl' })
  })

  it('creates the bot without the face', async () => {
    vi.mocked(rpcCall).mockRejectedValueOnce(unknownFace()).mockResolvedValueOnce({ bot: {} })

    const input = { avatar, face, model: 'm', name: 'owl', provider: 'p' }
    await botsCreate(input)

    expect(rpcCall).toHaveBeenLastCalledWith('hexbot.bots.create', {
      avatar,
      model: 'm',
      name: 'owl',
      provider: 'p'
    })
  })

  it.each([
    ['another refusal', new JsonRpcGatewayError('unknown bot field: eyes', { code: 4201 })],
    ['a bad face', new JsonRpcGatewayError('face needs the avatar it describes', { code: 4202 })]
  ])('passes %s through without trying again', async (_, error) => {
    vi.mocked(rpcCall).mockRejectedValueOnce(error)

    await expect(botsUpdate('owl', { avatar, face })).rejects.toBe(error)
    expect(rpcCall).toHaveBeenCalledTimes(1)
  })

  it('never retries a write that had no face', async () => {
    const error = unknownFace()
    vi.mocked(rpcCall).mockRejectedValueOnce(error)

    await expect(botsUpdate('owl', { description: 'Reads' })).rejects.toBe(error)
    expect(rpcCall).toHaveBeenCalledTimes(1)
  })
})
