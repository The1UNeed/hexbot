import { expect, it } from 'vitest'

import { parseDelimited, previewOf, splitName, TABLE_ROWS, TEXT_CHARS } from './files'

it('reads quoted fields with commas, quotes and line breaks', () => {
  const text = '﻿Qty,Part,Note\r\n15,"Joint motors","XL330, ""family"""\n\n1,Battery,"two\nlines"\n'
  expect(parseDelimited(text, ',')).toEqual([
    ['Qty', 'Part', 'Note'],
    ['15', 'Joint motors', 'XL330, "family"'],
    ['1', 'Battery', 'two\nlines']
  ])
  expect(parseDelimited('a\tb\n1\t', '\t')).toEqual([
    ['a', 'b'],
    ['1', '']
  ])
})

it('shows CSV as a table, Markdown formatted and other text as it is', () => {
  expect(previewOf({ mime: 'text/csv', name: 'parts.csv', text: 'a,b\n1,2' })).toEqual({
    kind: 'table',
    rows: [
      ['a', 'b'],
      ['1', '2']
    ],
    more: 0
  })
  const long = Array.from({ length: TABLE_ROWS + 3 }, (_, i) => String(i)).join('\n')
  expect(previewOf({ mime: 'text/csv', name: 'big.CSV', text: long })).toMatchObject({
    kind: 'table',
    more: 3
  })
  expect(previewOf({ mime: 'text/markdown', name: 'notes.md', text: '# Hi' }).kind).toBe('markdown')
  expect(previewOf({ mime: 'text/plain', name: 'main.rs', text: 'x'.repeat(TEXT_CHARS + 1) })).toMatchObject({
    kind: 'text',
    more: true
  })
})

it('shows pictures, video, audio and PDFs, and nothing for other files', () => {
  const read = (name: string, mime: string) => previewOf({ data_url: 'data:x;base64,', mime, name })
  expect(read('board.pdf', 'application/octet-stream').kind).toBe('pdf')
  expect(read('a.png', 'image/png').kind).toBe('image')
  expect(read('a.svg', 'image/svg+xml').kind).toBe('none')
  expect(read('a.mp4', 'video/mp4').kind).toBe('video')
  expect(read('a.mp3', 'audio/mpeg').kind).toBe('audio')
  expect(read('a.zip', 'application/zip').kind).toBe('none')
  expect(previewOf({ mime: 'application/zip', name: 'a.zip' }).kind).toBe('none')
})

it('keeps the extension when a name is cut', () => {
  expect(splitName('microduck-parts-list.csv')).toEqual({ stem: 'microduck-parts-list', ext: 'csv' })
  expect(splitName('Makefile')).toEqual({ stem: 'Makefile', ext: '' })
})
