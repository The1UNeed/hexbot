import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { Markdown } from '../app/conversation'

import { mathDelimiters } from './math'

// The reply that showed bare [ ] and (x=4): LaTeX between \( \) and \[ \].
const reply = String.raw`**3. Substitute \(x=4\)**

\[
h'(4)=-\frac{2}{4^2}+\frac{3}{2\sqrt4}
=\boxed{\frac58}.
\]

**Meaning:** At \(x=4\), the tangent line has slope \(\frac58\).`

describe('math', () => {
  it('turns \\( \\) and \\[ \\] into the delimiters remark-math reads', () => {
    expect(mathDelimiters(String.raw`slope \(\frac58\) here`)).toBe(
      String.raw`slope $$\frac58$$ here`
    )
    expect(mathDelimiters(String.raw`so \[x^2\] holds`)).toBe('so $$x^2$$ holds')
    expect(mathDelimiters(String.raw`\[ x^2 \]`)).toBe('$$\nx^2\n$$')
    expect(mathDelimiters('1. Step\n   \\[\n   a=b\n   \\]')).toBe('1. Step\n   $$\n   a=b\n   $$')
    expect(mathDelimiters('> \\[a\\]')).toBe('> $$\n> a\n> $$')
    expect(mathDelimiters('> \\[\n> x^2\n> \\]')).toBe('> $$\n> x^2\n> $$')
    expect(mathDelimiters('\\[ a\n  b \\]')).toBe('$$\na\n  b\n$$')
  })

  it('renders a formula inside a quote once, without a stray >', () => {
    const { container } = render(<Markdown text={'> \\[\n> x^2\n> \\]'} />)
    expect(container.querySelectorAll('blockquote .katex-display')).toHaveLength(1)
    expect(container.textContent).not.toContain('>')
  })

  it('keeps each formula apart', () => {
    expect(mathDelimiters('\\[a\\] and\n\\[b\\]')).toBe('$$a$$ and\n$$\nb\n$$')
    expect(mathDelimiters(String.raw`\(a\) or \(b\)`)).toBe('$$a$$ or $$b$$')
  })

  it('leaves code, escaped backslashes and plain brackets alone', () => {
    const code = '`\\(x\\)` and\n```\n\\[y\\]\n```'
    expect(mathDelimiters(code)).toBe(code)
    expect(mathDelimiters('```\n\\[still streaming\\]')).toBe('```\n\\[still streaming\\]')
    expect(mathDelimiters('a \\\\[b\\] c')).toBe('a \\\\[b\\] c')
    expect(mathDelimiters('[link](https://a.b) (aside) $5 and $10')).toBe(
      '[link](https://a.b) (aside) $5 and $10'
    )
  })

  it('renders the reply as formulas, with no stray brackets', () => {
    const { container } = render(<Markdown text={reply} />)
    expect(container.querySelectorAll('.katex-display')).toHaveLength(1)
    expect(container.querySelectorAll('.katex')).toHaveLength(4)
    expect(container.querySelector('.katex-error')).toBeNull()
    // KaTeX keeps the source in a hidden annotation; check only the text around it.
    container.querySelectorAll('.katex').forEach(node => node.remove())
    expect(container.textContent?.replace(/\s+/g, ' ')).toBe(
      '3. Substitute Meaning: At , the tangent line has slope .'
    )
  })

  it('leaves money as text', () => {
    const { container } = render(<Markdown text="It costs $5 and $10." />)
    expect(container.querySelector('.katex')).toBeNull()
    expect(container.textContent).toBe('It costs $5 and $10.')
  })
})
