import { expect, it } from 'vitest'

import { parseDelimited, previewOf, splitName, TABLE_CELLS, TABLE_COLUMNS, TABLE_ROWS, TEXT_CHARS } from './files'

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
    total: 2,
    columns: 2
  })
  const long = Array.from({ length: TABLE_ROWS + 3 }, (_, i) => String(i)).join('\n')
  const tall = previewOf({ mime: 'text/csv', name: 'big.CSV', text: long })
  expect(tall).toMatchObject({ kind: 'table', total: TABLE_ROWS + 3 })
  expect(tall.kind === 'table' && tall.rows.length).toBe(TABLE_ROWS)
  // A wide file keeps to the column and cell limits, however few rows it has.
  const wide = previewOf({
    mime: 'text/csv',
    name: 'wide.csv',
    text: Array.from({ length: 500 }, () => Array(2000).fill('x').join(',')).join('\n')
  })
  if (wide.kind !== 'table') throw new Error('expected a table')
  expect(wide.rows[0]).toHaveLength(TABLE_COLUMNS)
  expect(wide.rows.length * TABLE_COLUMNS).toBeLessThanOrEqual(TABLE_CELLS)
  expect([wide.total, wide.columns]).toEqual([500, 2000])
  // More rows than a function call takes arguments still opens.
  const rows = 300_000
  expect(previewOf({ mime: 'text/csv', name: 'tall.csv', text: 'a,b\n'.repeat(rows) })).toMatchObject({
    total: rows,
    columns: 2
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
