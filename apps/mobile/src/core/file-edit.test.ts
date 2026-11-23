import { describe, expect, it } from 'vitest'

import { JsonRpcGatewayError } from '../../../shared/src/json-rpc-gateway'
import { withComments } from '../../../web/src/lib/file-comments'
import type { Mark } from '../../../web/src/lib/markup'
import {
  addRow,
  cropWithin,
  editorOf,
  freshSteps,
  markSizes,
  pictureName,
  rangeQuote,
  redo,
  rowsOf,
  saveFailure,
  savesPicture,
  setCell,
  step,
  tableText,
  undo
} from './file-edit'

const mark = (id: string): Mark => ({ color: '#ef4444', id, kind: 'pen', points: [0, 0], width: 2 })

describe('the editor a file opens in', () => {
  it('edits text, Markdown, tables and pictures, and only shows the rest', () => {
    expect(editorOf({ mime: 'text/plain', name: 'notes.txt', text: 'hi' })).toBe('text')
    expect(editorOf({ mime: 'text/markdown', name: 'plan.MD', text: '# Plan' })).toBe('markdown')
    expect(editorOf({ mime: 'text/csv', name: 'parts.csv', text: 'a,b' })).toBe('table')
    expect(editorOf({ mime: 'text/tab-separated-values', name: 'p.tsv', text: 'a' })).toBe('table')
    expect(
      editorOf({ data_url: 'data:image/png;base64,AA', mime: 'image/png', name: 'a.png' })
    ).toBe('image')
    // An SVG can run code; Word files stay a preview on the phone.
    expect(
      editorOf({ data_url: 'data:image/svg+xml;base64,AA', mime: 'image/svg+xml', name: 'a.svg' })
    ).toBeNull()
    expect(
      editorOf({
        data_url: 'data:application/zip;base64,AA',
        mime: 'application/zip',
        name: 'a.docx'
      })
    ).toBeNull()
  })

  it('saves PNG, JPEG and WebP back, and names any other picture as the PNG it sends', () => {
    expect(savesPicture('image/jpeg')).toBe(true)
    expect(savesPicture('image/gif')).toBe(false)
    expect(pictureName('shot.jpg', 'image/jpeg')).toBe('shot.jpg')
    expect(pictureName('loop.gif', 'image/gif')).toBe('loop.png')
  })
})

describe('a table edited on the phone', () => {
  it('sets a cell past the end of its row and keeps the file’s line endings', () => {
    const text = '﻿Part,Qty\r\nMotor,2\r\n'
    const rows = setCell(rowsOf(text, 'parts.csv'), 1, 2, 'XL330, metal')
    expect(rows).toEqual([
      ['Part', 'Qty'],
      ['Motor', '2', 'XL330, metal']
    ])
    expect(tableText(rows, 'parts.csv', text)).toBe('﻿Part,Qty\r\nMotor,2,"XL330, metal"\r\n')
  })

  it('writes a TSV with tabs and adds a row as wide as the widest', () => {
    const rows = addRow(rowsOf('a\tb\tc\n1\n', 'p.tsv'))
    expect(rows.at(-1)).toEqual(['', '', ''])
    expect(tableText(setCell(rows, 2, 1, 'x'), 'p.tsv', 'a\n')).toBe('a\tb\tc\n1\n\tx\t\n')
  })

  it('quotes a range a row a line, whichever corner it started from', () => {
    const rows = [
      ['a', 'b', 'c'],
      ['1', '2']
    ]
    expect(rangeQuote(rows, { anchor: { col: 2, row: 1 }, focus: { col: 1, row: 0 } })).toBe(
      'b\tc\n2\t'
    )
  })
})

describe('the steps of a picture’s markup', () => {
  it('undoes and redoes each step, and a new step forgets what was undone', () => {
    let steps = step(freshSteps(), { crop: null, marks: [mark('a')] })
    steps = step(steps, { crop: null, marks: [mark('a'), mark('b')] })
    steps = undo(steps)
    expect(steps.now.marks.map(m => m.id)).toEqual(['a'])
    expect(redo(steps).now.marks.map(m => m.id)).toEqual(['a', 'b'])
    steps = step(steps, { crop: { h: 20, w: 20, x: 0, y: 0 }, marks: [] })
    expect(steps.future).toEqual([])
    expect(undo(undo(undo(steps))).now).toEqual({ crop: null, marks: [] })
    expect(undo(freshSteps())).toEqual(freshSteps())
  })

  it('keeps a crop inside the picture and drops a sliver', () => {
    expect(cropWithin({ h: 300, w: 300, x: -20, y: 50 }, 200, 200)).toEqual({
      h: 150,
      w: 200,
      x: 0,
      y: 50
    })
    expect(cropWithin({ h: 4, w: 100, x: 0, y: 0 }, 200, 200)).toBeNull()
  })

  it('scales lines and text to the picture, as the desktop does', () => {
    expect(markSizes(4000, 3000, 1)).toEqual({ line: 20, text: 120, unit: 10 })
    expect(markSizes(300, 200, 0)).toEqual({ line: 2, text: 16, unit: 2 })
  })
})

it('tells a file the bot changed from any other refused save', () => {
  expect(saveFailure(new JsonRpcGatewayError('changed', { code: 4209 }))).toEqual({
    conflict: true,
    message: ''
  })
  expect(saveFailure(new Error('Not allowed here.'))).toEqual({
    conflict: false,
    message: 'Not allowed here.'
  })
})

it('sends comments made on the phone the way the desktop sends them', () => {
  expect(
    withComments('', [
      { id: '1', name: 'parts.csv', note: 'Use two', path: '/w/parts.csv', quote: '2', where: 'B2' }
    ])
  ).toBe(
    'Please work through my comments on these files.\n\nMy comments:\n1. [parts.csv](</w/parts.csv>), B2, on "2": Use two\n\nWhere a comment asks for a change, edit the file in place.'
  )
})
