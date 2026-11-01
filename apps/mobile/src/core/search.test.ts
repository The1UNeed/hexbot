import { describe, expect, it } from 'vitest'

import { search, searchEntries } from './search'
import type { ChatMessage } from './types'

const messages: ChatMessage[] = [
  {
    attachments: [{ name: 'trips.csv' }],
    createdAt: 1000,
    id: 'm1',
    role: 'user',
    text: 'Plan the Lisbon trip'
  },
  {
    createdAt: 2000,
    id: 'm2',
    role: 'assistant',
    sender: 'muse',
    text: 'Here is a Lisbon itinerary.',
    tools: [
      { args: { path: 'notes/lisbon.md' }, detail: '', id: 't1', name: 'write', status: 'ok' },
      {
        args: '{"html":"<h1>Lisbon days</h1>","title":"Trip map"}',
        detail: '',
        id: 't2',
        name: 'hexbot_show_html',
        status: 'ok'
      }
    ]
  },
  { id: 'n', role: 'system', text: 'Lisbon notice' }
]

describe('searchEntries', () => {
  it('reads messages, files and visuals with the transcript ids', () => {
    const entries = searchEntries(messages, m => (m.role === 'user' ? 'You' : 'Muse'))

    expect(entries.map(entry => entry.id)).toEqual(['m1', 'm2'])
    expect(entries[1]!.files).toEqual([{ name: 'lisbon.md', path: 'notes/lisbon.md' }])
    expect(entries[1]!.visuals.map(visual => visual.toolId)).toEqual(['visual-m2-0'])

    const results = search(entries, 'lisbon')
    expect(results.messages.map(hit => hit.title)).toEqual(['Muse', 'You'])
    expect(results.files.map(hit => hit.title)).toEqual(['lisbon.md'])
    expect(results.visuals.map(hit => hit.title)).toEqual(['Trip map'])
  })
})
