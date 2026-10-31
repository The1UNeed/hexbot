import { describe, expect, it } from 'vitest'

import type { Message, RoomEvent, ToolCall } from '../../lib/types'

import { chatEntries, roomEntries, search, snippetOf, visualText } from './search'

const call = (partial: Partial<ToolCall>): ToolCall => ({
  args: {},
  durationS: 0,
  name: 'write',
  result: null,
  startedAt: 0,
  status: 'ok',
  toolId: 't1',
  ...partial
})

const message = (partial: Partial<Message>): Message => ({
  attachments: [],
  createdAt: 0,
  id: 'm1',
  role: 'user',
  streaming: false,
  text: '',
  toolCalls: [],
  ...partial
})

const chat = chatEntries(
  [
    message({
      attachments: [
        { id: 'a1', kind: 'pdf', mime: 'application/pdf', name: 'Budget 2026.pdf', size: 10 }
      ],
      id: 'm1',
      text: 'Here is the budget for the café'
    }),
    message({
      id: 'm2',
      parts: ['Reading the budget now.'],
      role: 'assistant',
      text: 'The budget is tight in March.',
      toolCalls: [
        call({ args: { path: '/Users/me/Hexbot/notes/budget-summary.md' }, toolId: 'w1' }),
        call({ args: '{"path":"draft.md"}', name: 'edit', toolId: 'w2' }),
        call({ args: { path: 'failed.md' }, status: 'error', toolId: 'w3' }),
        call({
          args: {
            html: '<style>.budget{}</style><h1>Spend by month</h1><script>budget()</script>',
            title: 'Budget chart'
          },
          name: 'hexbot_show_html',
          toolId: 'v1'
        })
      ]
    }),
    message({ id: 'm3', role: 'system', text: 'budget system line' })
  ],
  { bot: 'Muse' }
)

describe('chatEntries', () => {
  it('reads what was said, shared, written and drawn, and skips other roles', () => {
    expect(chat.map(entry => entry.id)).toEqual(['m1', 'm2'])
    expect(chat[0]!.author).toBe('You')
    expect(chat[1]!.author).toBe('Muse')
    expect(chat[1]!.text).toBe('Reading the budget now.\nThe budget is tight in March.')
    expect(chat[1]!.files.map(file => file.name)).toEqual(['budget-summary.md', 'draft.md'])
    expect(chat[1]!.visuals.map(visual => visual.title)).toEqual(['Budget chart'])
  })
})

describe('search', () => {
  it('finds messages, files, visuals and documents, newest first', () => {
    const results = search(chat, 'budget', [
      { kind: 'memory', text: 'Prefers a monthly budget review.', title: 'Memory' },
      { kind: 'soul', text: 'Be kind.', title: 'Soul' }
    ])

    expect(results.messages.map(hit => hit.target)).toEqual([
      { id: 'm2', kind: 'entry' },
      { id: 'm1', kind: 'entry' }
    ])
    expect(results.files.map(hit => [hit.title, hit.snippet])).toEqual([
      ['budget-summary.md', '/Users/me/Hexbot/notes/budget-summary.md'],
      ['Budget 2026.pdf', '']
    ])
    expect(results.visuals.map(hit => [hit.title, hit.snippet])).toEqual([
      ['Budget chart', 'Spend by month']
    ])
    expect(results.documents.map(hit => hit.target)).toEqual([
      { document: 'memory', kind: 'document' }
    ])
    expect(results.total).toBe(6)
  })

  it('needs every word, ignoring case and accents', () => {
    expect(search(chat, 'CAFE budget').messages.map(hit => hit.target)).toEqual([
      { id: 'm1', kind: 'entry' }
    ])
    expect(search(chat, 'budget april').total).toBe(0)
    expect(search(chat, '   ').total).toBe(0)
  })

  it('matches a visual by its words, not its markup or code', () => {
    expect(search(chat, 'spend month').visuals).toHaveLength(1)
    expect(search(chat, 'h1').visuals).toHaveLength(0)
    expect(search(chat, 'budget()').visuals).toHaveLength(0)
  })
})

describe('snippetOf', () => {
  it('centres long text on the first match', () => {
    const text = `${'a '.repeat(100)}needle ${'b '.repeat(100)}`
    const snippet = snippetOf(text, ['needle'], 40)!

    expect(snippet.startsWith('…')).toBe(true)
    expect(snippet.endsWith('…')).toBe(true)
    expect(snippet).toContain('needle')
  })
})

describe('visualText', () => {
  it('keeps the page text', () => {
    expect(visualText({ html: '<p>Tom &amp; Jerry</p>', title: 'Cast', toolId: 'v' })).toBe(
      'Tom & Jerry'
    )
  })
})

describe('roomEntries', () => {
  it('reads messages and their files, naming who spoke', () => {
    const event = (partial: Partial<RoomEvent>): RoomEvent => ({
      actor_id: 'muse',
      actor_kind: 'bot',
      created_at: 10,
      kind: 'message.bot',
      payload: {},
      room_id: 'r1',
      seq: 1,
      ...partial
    })

    const entries = roomEntries(
      [
        event({ payload: { attachments: [{ name: 'plan.pdf' }, {}], text: 'Plan' }, seq: 4 }),
        event({ kind: 'member.added', seq: 5 })
      ],
      item => item.actor_id ?? 'Someone'
    )

    expect(entries).toEqual([
      {
        at: 10_000,
        author: 'muse',
        files: [{ name: 'plan.pdf' }],
        id: '4',
        text: 'Plan',
        visuals: []
      }
    ])
  })
})
