/**
 * Copying words out of Hexbot keeps their shape (paragraphs, lists, bold,
 * links, code) but not the page's look. Left alone, Chromium writes the
 * computed styles into the copied HTML, so a paste into Mail, Docs or Notes
 * carries a bot's bubble colour behind every paragraph, and dark-theme text
 * colours with it.
 */

// Controls, icons and things nobody sees: the default copy skips most of
// them because they take no space, but a cloned range keeps them all.
// `aria-hidden` also drops KaTeX's drawn copy of a formula, leaving its MathML.
const DROP =
  'button, svg, script, style, template, iframe, input, textarea, select, [hidden], [aria-hidden="true"], .sr-only, .hidden'

const STRIP = /^(?:style|class|id|data-.*|aria-.*|role|tabindex)$/

const KEEPS_BREAKS = new Set(['break-spaces', 'pre-line', 'pre-wrap'])

function textNodes(root: Node): Text[] {
  if (root instanceof Text) {
    return [root]
  }

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []

  while (walker.nextNode()) {
    nodes.push(walker.currentNode as Text)
  }

  return nodes
}

/**
 * For each text node the range copies, in the order `cloneContents` copies
 * them: whether the page shows its newlines as line breaks. Chat paragraphs
 * are `pre-wrap`, so an address or a poem keeps its lines; without the style
 * the paste would run them together.
 */
function shownBreaks(range: Range): boolean[] {
  return textNodes(range.commonAncestorContainer)
    .filter(node => range.intersectsNode(node))
    .map(
      ({ parentElement }) =>
        parentElement instanceof HTMLElement &&
        KEEPS_BREAKS.has(getComputedStyle(parentElement).whiteSpace)
    )
}

export function cleanCopiedHtml(fragment: DocumentFragment, breaks: boolean[]): string {
  const copied = textNodes(fragment)

  // Only when the copy lines up with the page; otherwise newlines stay text.
  if (copied.length === breaks.length) {
    copied.forEach((node, index) => {
      if (breaks[index] && node.data.includes('\n')) {
        const lines = node.data.split('\n')

        node.replaceWith(
          ...lines.flatMap((line, at) => (at ? [document.createElement('br'), line] : [line]))
        )
      }
    })
  }

  for (const node of fragment.querySelectorAll(DROP)) {
    node.remove()
  }

  for (const element of fragment.querySelectorAll('*')) {
    for (const { name } of [...element.attributes]) {
      if (STRIP.test(name)) {
        element.removeAttribute(name)
      }
    }
  }

  const holder = document.createElement('div')
  holder.append(fragment)

  return holder.innerHTML
}

function editing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false
  }

  return target.isContentEditable || target.closest('input, textarea, select') !== null
}

export function handleCopy(event: ClipboardEvent): void {
  const selection = document.getSelection()

  if (
    event.defaultPrevented ||
    !event.clipboardData ||
    !selection ||
    selection.isCollapsed ||
    editing(event.target)
  ) {
    return
  }

  const fragment = document.createDocumentFragment()
  const breaks: boolean[] = []

  for (let index = 0; index < selection.rangeCount; index += 1) {
    const range = selection.getRangeAt(index)

    const within = range.commonAncestorContainer
    // Part of a code block copies its text without the <pre> that keeps its
    // lines and indents, so put one back.
    const pre = (within instanceof Element ? within : within.parentElement)?.closest('pre')
    const copy = pre ? document.createElement('pre') : fragment

    breaks.push(...shownBreaks(range))
    copy.append(range.cloneContents())

    if (copy !== fragment) {
      fragment.append(copy)
    }
  }

  event.clipboardData.setData('text/plain', selection.toString())
  event.clipboardData.setData('text/html', cleanCopiedHtml(fragment, breaks))
  event.preventDefault()
}

export function installCleanCopy(): () => void {
  document.addEventListener('copy', handleCopy)

  return () => document.removeEventListener('copy', handleCopy)
}
