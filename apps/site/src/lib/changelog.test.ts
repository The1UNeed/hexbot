import { describe, expect, it } from 'vitest'
import { demoteHeadings, newestFirst } from './changelog'

describe('newestFirst', () => {
  it('orders versions numerically, releases above their prereleases', () => {
    const versions = ['0.1.3', '0.1.10', '0.1.5-alpha.1', '0.1.5', '0.1.5-alpha.10', '0.1.5-alpha.2']
    expect(versions.sort(newestFirst)).toEqual([
      '0.1.10', '0.1.5', '0.1.5-alpha.10', '0.1.5-alpha.2', '0.1.5-alpha.1', '0.1.3'
    ])
  })
})

describe('demoteHeadings', () => {
  it('moves every heading down one level and drops its id', () => {
    expect(demoteHeadings('<h1 id="a">A</h1><h2>B</h2>')).toBe('<h2>A</h2><h3>B</h3>')
  })
})
