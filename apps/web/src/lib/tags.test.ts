import { describe, expect, it } from 'vitest'

import { faviconOf, linkLabel, siteName, splitMentions, tagOf } from './tags'

describe('tagOf', () => {
  it('reads a web page with its site', () => {
    expect(tagOf('https://www.taobao.com/list?q=1')).toEqual({
      host: 'taobao.com',
      kind: 'link',
      site: 'Taobao',
      url: 'https://www.taobao.com/list?q=1'
    })
  })

  it('reads a file from an absolute path, a file link or a tag', () => {
    expect(tagOf('/Users/me/out/report.pdf')).toEqual({
      kind: 'file',
      name: 'report.pdf',
      path: '/Users/me/out/report.pdf'
    })
    expect(tagOf('/Users/me/My%20Notes.md')).toMatchObject({ path: '/Users/me/My Notes.md' })
    expect(tagOf('~/notes.md')).toMatchObject({ kind: 'file', name: 'notes.md' })
    expect(tagOf('C:\\Users\\me\\a.txt')).toMatchObject({ kind: 'file', name: 'a.txt' })
    expect(tagOf('file:///Users/me/a.txt')).toMatchObject({ path: '/Users/me/a.txt' })
    expect(tagOf('file:///C:/Users/me/a.txt')).toMatchObject({ path: 'C:/Users/me/a.txt' })
    expect(tagOf('hexbot:file/out%2Fplan.md')).toMatchObject({ name: 'plan.md', path: 'out/plan.md' })
  })

  it('reads the places in Hexbot', () => {
    expect(tagOf('hexbot:bot/biology')).toEqual({ handle: 'biology', kind: 'bot' })
    expect(tagOf('hexbot://bot/@Biology')).toEqual({ handle: 'biology', kind: 'bot' })
    expect(tagOf('hexbot:room/Study%20group')).toEqual({ kind: 'room', room: 'Study group' })
    expect(tagOf('hexbot:jobs')).toEqual({ bot: null, kind: 'jobs' })
    expect(tagOf('hexbot:jobs/biology')).toEqual({ bot: 'biology', kind: 'jobs' })
    expect(tagOf('hexbot:settings/passwords')).toEqual({ kind: 'settings', page: 'passwords' })
    expect(tagOf('hexbot:plugin/Notion')).toEqual({ kind: 'plugin', name: 'Notion' })
    expect(tagOf('hexbot:skill/weekly-review')).toEqual({ kind: 'skill', name: 'weekly-review' })
  })

  it('is no tag for anything else', () => {
    for (const href of [
      '',
      undefined,
      'mailto:me@example.com',
      '//example.com/a',
      'notes.md',
      '#top',
      'hexbot:settings/nowhere',
      'hexbot:bot/Not A Handle',
      'hexbot:pair?host=1',
      'javascript:alert(1)'
    ]) {
      expect(tagOf(href)).toBeNull()
    }
  })
})

describe('siteName', () => {
  it('names a site by its own label, with brand spellings', () => {
    expect(siteName('https://github.com/a')).toBe('GitHub')
    expect(siteName('https://docs.schoology.com/x')).toBe('Schoology')
    expect(siteName('https://www.bbc.co.uk/news')).toBe('BBC')
    expect(siteName('example.com.cn')).toBe('Example')
  })

  it('has no name for an address on your network', () => {
    expect(siteName('http://192.168.1.4:9119/login')).toBeNull()
    expect(siteName('http://localhost:5173')).toBeNull()
    expect(siteName('http://printer.local')).toBeNull()
  })
})

describe('faviconOf', () => {
  it("asks only a public https site for its icon", () => {
    expect(faviconOf('https://www.taobao.com/a/b')).toBe('https://www.taobao.com/favicon.ico')
    expect(faviconOf('http://example.com')).toBeNull()
    expect(faviconOf('https://192.168.1.4/')).toBeNull()
    expect(faviconOf('https://nas.local/')).toBeNull()
  })
})

describe('splitMentions', () => {
  it('cuts text at its handles', () => {
    expect(splitMentions('Ask @biology, then @Writer-2.')).toEqual([
      'Ask ',
      { handle: 'biology' },
      ', then ',
      { handle: 'writer-2' },
      '.'
    ])
    expect(splitMentions('(@scout) done')).toEqual(['(', { handle: 'scout' }, ') done'])
  })

  it('leaves addresses and paths alone', () => {
    expect(splitMentions('mail me@example.com')).toEqual(['mail me@example.com'])
    expect(splitMentions('npm i @types/node and a/@scope')).toEqual([
      'npm i ',
      { handle: 'types' },
      '/node and a/@scope'
    ])
    expect(splitMentions('no handles here')).toEqual(['no handles here'])
  })
})

describe('linkLabel', () => {
  it('keeps a name, and shortens a link written as its own address', () => {
    expect(linkLabel('MIT CER guide', 'https://mit.edu/cer')).toBe('MIT CER guide')
    expect(linkLabel('https://www.taobao.com/', 'https://www.taobao.com/')).toBe('taobao.com')
    expect(linkLabel('https://example.com/a/b', 'https://example.com/a/b')).toBe('example.com/a/b')
    expect(linkLabel('', `https://example.com/${'a'.repeat(80)}`)).toHaveLength(48)
  })
})
