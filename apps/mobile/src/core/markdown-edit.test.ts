import { describe, expect, it } from 'vitest'

import { applyFormat } from './markdown-edit'

describe('applyFormat', () => {
  it('wraps a selection in bold or italic, or puts the caret between the marks', () => {
    expect(applyFormat('be kind', { end: 7, start: 3 }, 'bold')).toEqual({
      selection: { end: 9, start: 5 },
      text: 'be **kind**'
    })
    expect(applyFormat('be ', { end: 3, start: 3 }, 'italic')).toEqual({
      selection: { end: 4, start: 4 },
      text: 'be **'
    })
  })

  it('sets and clears headings on the caret line', () => {
    const text = 'Intro\nValues\nEnd'
    const h2 = applyFormat(text, { end: 8, start: 8 }, 'h2')

    expect(h2.text).toBe('Intro\n## Values\nEnd')
    expect(applyFormat(h2.text, { end: 9, start: 9 }, 'h1').text).toBe('Intro\n# Values\nEnd')
    expect(applyFormat(h2.text, { end: 9, start: 9 }, 'h2').text).toBe(text)
  })

  it('lists the selected lines and takes the list off again', () => {
    const text = 'Tea\nTrains\n\nQuiet'
    const bullets = applyFormat(text, { end: text.length, start: 0 }, 'bullet')

    expect(bullets.text).toBe('- Tea\n- Trains\n\n- Quiet')
    expect(applyFormat(bullets.text, bullets.selection, 'bullet').text).toBe(text)

    const numbered = applyFormat(bullets.text, bullets.selection, 'ordered')
    expect(numbered.text).toBe('1. Tea\n2. Trains\n\n3. Quiet')
    expect(applyFormat(numbered.text, numbered.selection, 'ordered').text).toBe(text)
  })
})
