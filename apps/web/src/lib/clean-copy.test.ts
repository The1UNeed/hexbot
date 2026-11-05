import { afterEach, describe, expect, it } from 'vitest'

import { handleCopy } from './clean-copy'

function copyEvent() {
  const data = new Map<string, string>()
  const event = new Event('copy', { bubbles: true, cancelable: true }) as ClipboardEvent

  Object.defineProperty(event, 'clipboardData', {
    value: {
      getData: (type: string) => data.get(type) ?? '',
      setData: (type: string, value: string) => data.set(type, value)
    }
  })

  return { data, event }
}

function select(node: Node) {
  const range = document.createRange()

  range.selectNodeContents(node)
  document.getSelection()?.removeAllRanges()
  document.getSelection()?.addRange(range)
}

afterEach(() => {
  document.getSelection()?.removeAllRanges()
  document.body.innerHTML = ''
})

describe('handleCopy', () => {
  it('copies a bubble without its colour, keeping paragraphs, bold and links', () => {
    document.body.innerHTML = `
      <div class="bg-bubble" style="background: #f0d6e4; color: #222">
        <div class="hex-prose">
          <p style="background: #f0d6e4">Dear <strong class="font-bold">Mr. Mooney</strong>,</p>
          <p>See <a class="underline" href="https://example.com" data-x="1">the scope</a>.</p>
          <button aria-label="Copy"><svg></svg></button>
          <span class="sr-only">Sent</span>
          <span class="katex"><math><mi>x</mi></math><span aria-hidden="true">x</span></span>
        </div>
      </div>`
    select(document.querySelector('.hex-prose')!)

    const { data, event } = copyEvent()

    handleCopy(event)

    expect(event.defaultPrevented).toBe(true)
    expect(data.get('text/html')?.replace(/>\s+</g, '><').trim()).toBe(
      '<p>Dear <strong>Mr. Mooney</strong>,</p><p>See <a href="https://example.com">the scope</a>.</p><span><math><mi>x</mi></math></span>'
    )
    expect(data.get('text/html')).not.toMatch(/style|class|background/)
    expect(data.get('text/plain')).toContain('Dear Mr. Mooney,')
  })

  it('keeps the line breaks a chat paragraph shows, but not a code block’s', () => {
    document.body.innerHTML = `<style>.hex-prose p { white-space: pre-wrap }</style><div class="hex-prose"><p>Alex\n12 Main Street\nShanghai</p><pre><code>a\nb</code></pre></div>`
    select(document.querySelector('.hex-prose')!)

    const whole = copyEvent()

    handleCopy(whole.event)

    expect(whole.data.get('text/html')).toBe(
      '<p>Alex<br>12 Main Street<br>Shanghai</p><pre><code>a\nb</code></pre>'
    )

    // A selection inside one paragraph copies bare text, no <p> to carry it.
    const text = document.querySelector('p')!.firstChild!
    const range = document.createRange()

    range.setStart(text, 2)
    range.setEnd(text, 16)
    document.getSelection()?.removeAllRanges()
    document.getSelection()?.addRange(range)

    const part = copyEvent()

    handleCopy(part.event)

    expect(part.data.get('text/html')).toBe('ex<br>12 Main Str')

    // Lines from inside a code block keep the <pre> that holds them.
    const code = document.querySelector('code')!.firstChild!
    const lines = document.createRange()

    lines.setStart(code, 0)
    lines.setEnd(code, 3)
    document.getSelection()?.removeAllRanges()
    document.getSelection()?.addRange(lines)

    const inCode = copyEvent()

    handleCopy(inCode.event)

    expect(inCode.data.get('text/html')).toBe('<pre>a\nb</pre>')
  })

  it('leaves copying from the composer to the browser', () => {
    document.body.innerHTML = '<textarea>hello</textarea><p>picked</p>'
    select(document.querySelector('p')!)

    const { data, event } = copyEvent()

    document.querySelector('textarea')!.dispatchEvent(event)
    handleCopy(event)

    expect(event.defaultPrevented).toBe(false)
    expect(data.size).toBe(0)
  })

  it('does nothing without a selection', () => {
    const { data, event } = copyEvent()

    handleCopy(event)

    expect(event.defaultPrevented).toBe(false)
    expect(data.size).toBe(0)
  })
})
