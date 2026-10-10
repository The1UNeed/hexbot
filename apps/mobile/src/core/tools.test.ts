import { describe, expect, it } from 'vitest'
import { activityLabel, readableResult, resultLine, toolLabel } from './tools'

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
