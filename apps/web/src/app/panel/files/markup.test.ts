import { describe, expect, it } from 'vitest'

import { linesOf } from './comment-layer'
import { areaOf, boundsOf, type Mark, markAt, moved, nextStep } from './markup'
import { columnName, rangeName } from './sheet-grid'

const arrow: Mark = {
  color: '#f00',
  id: 'a',
  kind: 'arrow',
  width: 4,
  x1: 10,
  x2: 110,
  y1: 50,
  y2: 10
}

const pen: Mark = { color: '#f00', id: 'p', kind: 'pen', points: [0, 0, 20, 30], width: 2 }
const step: Mark = { color: '#00f', id: 's', kind: 'step', n: 2, size: 10, x: 200, y: 200 }

describe('marks on a picture', () => {
  it('measure, hit and move', () => {
    expect(areaOf(110, 10, 10, 50)).toEqual({ h: 40, w: 100, x: 10, y: 10 })
    expect(boundsOf(arrow)).toEqual({ h: 48, w: 108, x: 6, y: 6 })
    expect(boundsOf(pen)).toEqual({ h: 32, w: 22, x: -1, y: -1 })
    expect(markAt([pen, arrow, step], 60, 30, 2)?.id).toBe('a')
    expect(markAt([pen, arrow, step], 400, 400, 2)).toBeNull()
    expect(moved(arrow, 5, -5)).toMatchObject({ x1: 15, x2: 115, y1: 45, y2: 5 })
    expect(moved(pen, 1, 2)).toMatchObject({ points: [1, 2, 21, 32] })
    expect(nextStep([pen, step])).toBe(3)
  })
})

describe('where a comment points', () => {
  it('names lines of a text field and cells of a sheet', () => {
    expect(linesOf('a\nbb\nccc', 2, 4)).toBe('line 2')
    expect(linesOf('a\nbb\nccc', 0, 8)).toBe('lines 1–3')
    expect(columnName(0)).toBe('A')
    expect(columnName(27)).toBe('AB')
    expect(rangeName({ anchor: { col: 2, row: 3 }, focus: { col: 1, row: 1 } })).toBe('B2:C4')
    expect(rangeName({ anchor: { col: 0, row: 0 }, focus: { col: 0, row: 0 } })).toBe('A1')
  })
})
