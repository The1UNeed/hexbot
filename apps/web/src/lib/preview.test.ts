import { previewLine } from './preview'

describe('previewLine', () => {
  it('drops markdown marks and line breaks', () => {
    expect(previewLine('**Go with a 550W PSU. 650W is fine if you want it quieter.*...')).toBe(
      'Go with a 550W PSU. 650W is fine if you want it quieter....'
    )
    expect(previewLine('## Plan\n- **one** and `two`\n> quoted')).toBe('Plan one and two quoted')
    expect(previewLine('See [the docs](https://hexbot.app) now')).toBe('See the docs now')
    expect(previewLine('See [the install guide](https://hexbot.app/docs/install...')).toBe(
      'See the install guide'
    )
    expect(previewLine('An *italic* word')).toBe('An italic word')
    expect(previewLine('*你好*，再试试')).toBe('你好，再试试')
  })

  it('keeps math and plain text readable', () => {
    expect(previewLine("I'm reading your function as\n\\[\nh(x)=\\frac{2}{x}\n...")).toBe(
      "I'm reading your function as h(x)=\\frac{2}{x} ..."
    )
    expect(previewLine('Hey Alex! What are we reviewing today?')).toBe(
      'Hey Alex! What are we reviewing today?'
    )
    expect(previewLine('snake_case stays')).toBe('snake_case stays')
    expect(previewLine('Calculate 2 * 3, or 2*3, in *.ts files')).toBe(
      'Calculate 2 * 3, or 2*3, in *.ts files'
    )
    expect(previewLine('')).toBe('')
  })
})
