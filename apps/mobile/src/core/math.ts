// The phone has no math typesetting, so a bot's LaTeX becomes plain text that
// reads like the formula: \frac{3}{2\sqrt{x}} is 3/(2√x), x^{-1} is x⁻¹.

// prettier-ignore
const SYMBOLS: Record<string, string> = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ',
  eta: 'η', theta: 'θ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ',
  pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ',
  omega: 'ω', Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Pi: 'Π', Sigma: 'Σ',
  Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  cdot: '·', times: '×', div: '÷', pm: '±', mp: '∓', le: '≤', leq: '≤', ge: '≥', geq: '≥',
  ne: '≠', neq: '≠', approx: '≈', equiv: '≡', sim: '∼', propto: '∝', infty: '∞',
  to: '→', rightarrow: '→', leftarrow: '←', Rightarrow: '⇒', implies: '⇒', iff: '⇔',
  in: '∈', notin: '∉', subset: '⊂', subseteq: '⊆', cup: '∪', cap: '∩', emptyset: '∅',
  forall: '∀', exists: '∃', partial: '∂', nabla: '∇', int: '∫', oint: '∮', sum: '∑',
  prod: '∏', angle: '∠', circ: '∘', degree: '°', prime: '′', ldots: '…', cdots: '⋯',
  dots: '…', langle: '⟨', rangle: '⟩', lfloor: '⌊', rfloor: '⌋', lceil: '⌈', rceil: '⌉',
  vert: '|', lvert: '|', rvert: '|', mid: '|', neg: '¬', land: '∧', lor: '∨', perp: '⊥',
  parallel: '∥', hbar: 'ℏ', ell: 'ℓ', quad: ' ', qquad: ' ', ',': ' ', ':': ' ', ';': ' ',
  ' ': ' ', '!': '', '\\': '\n'
}
/** Sizing and layout commands that change nothing in plain text. */
// prettier-ignore
const DROPPED = new Set(['left', 'right', 'displaystyle', 'textstyle', 'limits', 'nolimits',
  'big', 'Big', 'bigg', 'Bigg', 'bigl', 'bigr', 'Bigl', 'Bigr'])
/** Commands whose one argument is shown as it is. */
// prettier-ignore
const PLAIN = new Set(['boxed', 'text', 'textbf', 'textit', 'mathrm', 'mathbf', 'mathit',
  'mathsf', 'mathcal', 'operatorname', 'bm', 'boldsymbol', 'underline'])
/** Accents mean something (ẋ is a derivative, x̄ a mean), so each letter keeps its mark. */
// prettier-ignore
const ACCENTS: Record<string, string> = { hat: '\u0302', widehat: '\u0302', bar: '\u0304',
  overline: '\u0305', vec: '\u20d7', dot: '\u0307', ddot: '\u0308', tilde: '\u0303',
  widetilde: '\u0303' }
const BLACKBOARD: Record<string, string> = { R: 'ℝ', N: 'ℕ', Z: 'ℤ', Q: 'ℚ', C: 'ℂ' }
// prettier-ignore
const SUP: Record<string, string> = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸',
  '9': '⁹', '+': '⁺', '-': '⁻', '−': '⁻', '=': '⁼', '(': '⁽', ')': '⁾', n: 'ⁿ', i: 'ⁱ'
}
// prettier-ignore
const SUB: Record<string, string> = {
  '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈',
  '9': '₉', '+': '₊', '-': '₋', '=': '₌', '(': '₍', ')': '₎', a: 'ₐ', e: 'ₑ', i: 'ᵢ', j: 'ⱼ',
  k: 'ₖ', m: 'ₘ', n: 'ₙ', o: 'ₒ', t: 'ₜ', x: 'ₓ'
}

/** One term that needs no brackets after / or √: 4, x², 2π, n′. */
const atom = (text: string) => /^[\p{L}\p{N}.′]+$/u.test(text)
const wrap = (text: string) => (atom(text) ? text : `(${text})`)
function script(text: string, map: Record<string, string>, mark: string) {
  const chars = [...text]
  if (chars.length && chars.every(c => c in map)) return chars.map(c => map[c]).join('')
  return mark + (chars.length === 1 ? text : `(${text})`)
}

export function texToText(tex: string): string {
  let i = 0
  const space = () => {
    while (tex[i] === ' ') i++
  }
  const command = () => {
    const name = /^[a-zA-Z]+|^./s.exec(tex.slice(i))?.[0] ?? ''
    i += name.length
    return name
  }
  const braced = () => {
    let depth = 1
    const start = ++i
    while (i < tex.length && depth) {
      if (tex[i] === '\\') i++
      else if (tex[i] === '{') depth++
      else if (tex[i] === '}') depth--
      i++
    }
    return tex.slice(start, depth ? i : i - 1)
  }
  // One argument: a {group}, a \command, or a single character.
  const raw = () => {
    space()
    if (tex[i] === '{') return braced()
    const token =
      tex[i] === '\\' ? (/^\\(?:[a-zA-Z]+|.)/s.exec(tex.slice(i))?.[0] ?? '\\') : (tex[i] ?? '')
    i += token.length
    return token
  }
  const arg = () => texToText(raw()).trim()

  let out = ''
  while (i < tex.length) {
    const c = tex[i]
    if (c === '\\') {
      i++
      const name = command()
      if (name === 'frac' || name === 'dfrac' || name === 'tfrac') {
        const top = arg()
        const bottom = arg()
        // Only one number or one letter goes bare below the line: 1/(2x), not 1/2x.
        const under = /^(?:[\p{Nd}.]+|\p{L})[\p{No}\p{Lm}′]*$/u.test(bottom)
          ? bottom
          : `(${bottom})`
        const fraction = `${wrap(top)}/${under}`
        // A term touching the fraction keeps it apart: (3/2)², 2(1/2), (1/2)(3/4), (1/2)x.
        const touching =
          /[\p{L}\p{N})]$/u.test(out) ||
          /^ *(?:[\^_\p{L}\p{N}(]|\\[dt]?frac|\\sqrt)/u.test(tex.slice(i))
        out += touching ? `(${fraction})` : fraction
      } else if (name === 'sqrt') {
        space()
        let index = ''
        if (tex[i] === '[') {
          const end = tex.indexOf(']', i)
          index = texToText(tex.slice(i + 1, end < 0 ? tex.length : end)).trim()
          i = end < 0 ? tex.length : end + 1
        }
        const root =
          index === '3' ? '∛' : index === '4' ? '∜' : index ? `${script(index, SUP, '')}√` : '√'
        out += root + wrap(arg())
      } else if (name === 'mathbb') {
        const text = arg()
        out += BLACKBOARD[text] ?? text
      } else if (name === 'begin' || name === 'end') {
        raw()
      } else if (name in ACCENTS) {
        out += [...arg()].map(c => c + ACCENTS[name]).join('')
      } else if (PLAIN.has(name)) {
        out += arg()
      } else if (!DROPPED.has(name)) {
        const symbol = SYMBOLS[name] ?? name
        out += symbol
        // \pi r is πr, but \ne x keeps its space.
        if (/\p{L}$/u.test(symbol) && /^ +[\p{L}\p{N}]/u.test(tex.slice(i))) space()
      }
    } else if (c === '^' || c === '_') {
      i++
      out += c === '^' ? script(arg(), SUP, '^') : script(arg(), SUB, '_')
    } else if (c === '{') {
      const group = texToText(braced())
      // {x+1}^2 is (x+1)², not x+1².
      out += /^ *[\^_]/.test(tex.slice(i)) ? wrap(group) : group
    } else {
      i++
      // & separates matrix and aligned columns: 1&2 is "1 2", not 12.
      if (c !== '}') out += c === '~' || c === '&' ? ' ' : c
    }
  }
  return out
    .split('\n')
    .map(line => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
}

/** Replaces \( \), \[ \] and $$ $$ in a message with the readable text of their LaTeX. */
export function readableMath(text: string) {
  const plain = (_: string, tex: string) => texToText(tex).trim()
  return text
    .replace(/(?<!\\)\\\[((?:[^\\]|\\[^\]])+?)\\\]/g, plain)
    .replace(/\$\$([^$]+?)\$\$/g, plain)
    .replace(/(?<!\\)\\\(((?:[^\\\n]|\\[^)\n])+?)\\\)/g, plain)
}
