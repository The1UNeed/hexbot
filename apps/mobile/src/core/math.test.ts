import { describe, expect, it } from 'vitest'
import { readableMath, texToText } from './math'

describe('math on the phone', () => {
  it('reads the formulas of a derivative reply', () => {
    expect(texToText('h(x)=2x^{-1}+3x^{1/2}')).toBe('h(x)=2x⁻¹+3x^(1/2)')
    expect(texToText(String.raw`h'(x)=2(-1)x^{-2}+3\left(\frac12\right)x^{-1/2}`)).toBe(
      "h'(x)=2(-1)x⁻²+3(1/2)x^(-1/2)"
    )
    expect(texToText(String.raw`\boxed{h'(x)=-\frac{2}{x^2}+\frac{3}{2\sqrt{x}}}`)).toBe(
      "h'(x)=-2/x²+3/(2√x)"
    )
    expect(texToText(String.raw`\frac{d}{dx}(x^n)=nx^{n-1}`)).toBe('d/dx(xⁿ)=nxⁿ⁻¹')
    expect(texToText(String.raw`\sqrt[3]{x}`)).toBe('∛x')
    expect(texToText(String.raw`3\sqrt{x+1}`)).toBe('3√(x+1)')
    expect(texToText(String.raw`\frac{3}{2}^2`)).toBe('(3/2)²')
    expect(texToText('{x+1}^2 + {y}^2')).toBe('(x+1)² + y²')
  })

  it('keeps the lines of a display formula', () => {
    expect(
      texToText(String.raw`h'(4)=-\frac{2}{4^2}+\frac{3}{2\sqrt4}
=-\frac18+\frac34
=\boxed{\frac58}.`)
    ).toBe("h'(4)=-2/4²+3/(2√4)\n=-1/8+3/4\n=5/8.")
  })

  it('names symbols, sets and text', () => {
    expect(texToText(String.raw`\alpha \cdot \pi r^2 \le \infty`)).toBe('α · πr² ≤ ∞')
    expect(texToText(String.raw`x \in \mathbb{R}, \text{ so } x_1 \ne x_{10}`)).toBe(
      'x ∈ ℝ, so x₁ ≠ x₁₀'
    )
    expect(texToText(String.raw`\sin\theta = \frac{a_{max}}{b} + y_{\pi}`)).toBe(
      'sinθ = aₘₐₓ/b + y_π'
    )
  })

  it('replaces every kind of math in a message and nothing else', () => {
    expect(
      readableMath(String.raw`At \(x=4\), slope \(\frac58\).

\[
h'(4)=\frac58
\]
or $$x^2$$, costs $5 and $10, a [link](https://a.b) (aside)`)
    ).toBe(`At x=4, slope 5/8.

h'(4)=5/8
or x², costs $5 and $10, a [link](https://a.b) (aside)`)
  })
})
