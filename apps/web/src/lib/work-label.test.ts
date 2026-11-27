import { describe, expect, it } from 'vitest'

import { labelText, phaseLabel, stepLabel, stepMood } from './work-label'

const line = (name: string, args?: unknown, summary?: string) =>
  labelText(stepLabel({ args, name, summary }))

describe('stepLabel', () => {
  it('names a page by its site and a file by its own name', () => {
    expect(line('computer_use', { action: 'open', url: 'https://www.taobao.com/?spm=1' })).toBe(
      'Opening Taobao'
    )
    expect(line('computer_use', { action: 'open', url: '/home/bot/report final.pdf' })).toBe(
      'Opening report final.pdf'
    )
    expect(line('computer_use', { action: 'launch', app: 'firefox' })).toBe('Opening Firefox')
    expect(line('web_extract', { urls: ['https://github.com/a/b'] })).toBe('Reading GitHub')
    expect(line('read_file', { path: '/Users/me/work/notes.md' })).toBe('Reading notes.md')
    expect(line('hexbot_share_file', undefined, 'out/summary.pdf')).toBe('Sharing summary.pdf')
  })

  it('reads the action from the context line when the arguments did not come', () => {
    expect(line('computer_use', undefined, 'click')).toBe('Clicking on the computer')
    expect(line('computer_use', undefined, 'open')).toBe('Opening a page')
    expect(line('computer_use')).toBe('Using the computer')
    expect(line('hexbot_mail', undefined, 'draft')).toBe('Drafting an email')
  })

  it('says what it does in your calendar, files and documents, by action', () => {
    expect(stepLabel({ name: 'hexbot_calendar', summary: 'list' })).toEqual({
      object: 'the calendar',
      verb: 'Checking'
    })
    expect(line('hexbot_documents', { action: 'create' })).toBe('Writing a document')
    expect(line('hexbot_drive')).toBe('Working with your files')
    expect(stepMood({ name: 'hexbot_spreadsheets', summary: 'read' })).toBe('reading')
    expect(stepMood({ name: 'hexbot_drive', summary: 'search' })).toBe('searching')
    expect(stepMood({ name: 'hexbot_tasks', summary: 'add' })).toBe('writing')
  })

  it('says what is searched for, with the query as the specific part', () => {
    expect(stepLabel({ args: { query: 'CER test dates' }, name: 'web_search' })).toEqual({
      object: 'CER test dates',
      verb: 'Searching the web for'
    })
    expect(line('web_search')).toBe('Searching the web')
    expect(line('hexbot_mail', { action: 'search', query: 'invoice' })).toBe(
      'Searching email for invoice'
    )
  })

  it('never quotes a command or a script', () => {
    expect(line('terminal', { command: 'rm -rf ./probe' }, 'rm -rf ./probe')).toBe(
      'Running a command'
    )
    expect(line('codemode', { code: 'await fetch(secret)' })).toBe('Running code')
  })

  it('reads arguments that arrive as a JSON string, and shortens a long one', () => {
    expect(line('read_file', '{"path":"a/b/plan.md"}')).toBe('Reading plan.md')
    expect(line('web_search', { query: 'x'.repeat(200) })).toHaveLength(
      'Searching the web for '.length + 60
    )
  })

  it('names a connector, and falls back to the tool in plain words', () => {
    expect(line('mcp__notion__search')).toBe('Using Notion')
    expect(labelText(stepLabel({ name: 'mcp_project_tools_list' }, 'Project tools'))).toBe(
      'Using Project tools'
    )
    expect(line('some_new_tool')).toBe('Using some new tool')
  })

  it('tells reading from writing by the action', () => {
    expect(line('memory', { action: 'read' })).toBe('Reading its memory')
    expect(line('memory', { action: 'note', text: 'x' })).toBe('Writing a note')
    expect(line('hexbot_soul', { action: 'write', text: 'x' })).toBe('Updating its soul')
    expect(line('message_bot', { to: 'biology', wait: false })).toBe('Messaging biology')
  })
})

describe('phaseLabel', () => {
  it('has a word for the time between steps', () => {
    expect(labelText(phaseLabel('thinking'))).toBe('Thinking…')
    expect(labelText(phaseLabel('typing'))).toBe('Typing…')
    expect(labelText(phaseLabel('working'))).toBe('Working…')
  })
})

describe('stepMood', () => {
  it('gives each kind of step its face', () => {
    expect(stepMood({ name: 'computer_use' })).toBe('computer')
    expect(stepMood({ name: 'web_search' })).toBe('searching')
    expect(stepMood({ name: 'read_file' })).toBe('reading')
    expect(stepMood({ name: 'web_extract' })).toBe('reading')
    expect(stepMood({ name: 'write_file' })).toBe('writing')
    expect(stepMood({ name: 'clarify' })).toBe('listening')
    expect(stepMood({ name: 'terminal' })).toBe('working')
    expect(stepMood({ args: { action: 'read' }, name: 'memory' })).toBe('reading')
    expect(stepMood({ args: { action: 'add' }, name: 'memory' })).toBe('writing')
    expect(stepMood({ name: 'hexbot_mail', summary: 'search' })).toBe('searching')
  })
})
