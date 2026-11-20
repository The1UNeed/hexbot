import { describe, expect, it } from 'vitest'

import { parseDelimited, serializeDelimited } from './delimited'

describe('CSV and TSV', () => {
  it('quotes only what needs it and round-trips', () => {
    const rows = [
      ['pin', 'use'],
      ['GPIO2', 'ADC, input'],
      ['GPIO15', 'says "JTAG"\nnext line']
    ]

    const text = serializeDelimited(rows, ',')

    expect(text).toBe('pin,use\nGPIO2,"ADC, input"\nGPIO15,"says ""JTAG""\nnext line"\n')
    expect(parseDelimited(text, ',')).toEqual(rows)
  })

  it('keeps a record of one empty field in a one-column file', () => {
    const rows = parseDelimited('before\n""\nafter\n', ',')

    expect(rows).toEqual([['before'], [''], ['after']])
    expect(serializeDelimited(rows, ',', 'x\n')).toBe('before\n""\nafter\n')
  })

  it('keeps the file’s line endings, byte-order mark and final line break', () => {
    expect(serializeDelimited([['a', 'b']], ',', '\ufeffx,y\r\n')).toBe('\ufeffa,b\r\n')
    expect(serializeDelimited([['a', 'b']], ',', 'x,y')).toBe('a,b')
    expect(serializeDelimited([['a', 'b c']], '\t', 'x\ty\n')).toBe('a\tb c\n')
  })
})
