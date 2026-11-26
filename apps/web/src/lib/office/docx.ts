// A Word file as the panel shows it: paragraphs and tables in order, each
// paragraph's runs with their look. Edits change the text in place; Enter
// splits a paragraph and Backspace at its start joins it to the one before,
// moving the runs themselves so their formatting goes with them.

import { attr, child, children, find, NS, type OfficePackage, setRunText } from './package'
import { runText, type RunView, writeRuns } from './runs'

const W = NS.w

export interface DocxParagraph {
  kind: 'paragraph'
  element: Element
  runs: Element[]
  views: RunView[]
  /** 1–3 for headings and the title, else 0. */
  heading: number
  /** The document's title style, larger than a heading. */
  title: boolean
  list?: { ordered: boolean; level: number }
  align?: 'center' | 'end' | 'justify' | 'start'
  /** Pictures in the paragraph, as `data:` URLs. */
  pictures: string[]
  /** "paragraph 4, under “Results”", for a comment. */
  where: string
}

export interface DocxTable {
  kind: 'table'
  element: Element
  rows: DocxParagraph[][][]
}

export type DocxBlock = DocxParagraph | DocxTable

export interface DocxDocument {
  blocks: DocxBlock[]
  /** The page's width and side margins, in CSS px. */
  page: { margin: number; width: number }
}

const DOCUMENT = 'word/document.xml'

const on = (node: Element | null) => {
  if (!node) {
    return false
  }

  const value = attr(node, 'val', W)

  return value === null || value === '' || !['0', 'false', 'none', 'off'].includes(value)
}

function runView(run: Element, href?: string): RunView {
  const props = child(run, W, 'rPr')
  const color = attr(child(props, W, 'color'), 'val', W)
  const size = attr(child(props, W, 'sz'), 'val', W)

  return {
    bold: on(child(props, W, 'b')),
    color: color && /^[0-9a-f]{6}$/i.test(color) ? `#${color}` : undefined,
    href,
    italic: on(child(props, W, 'i')),
    size: size ? Number(size) / 2 : undefined,
    strike: on(child(props, W, 'strike')),
    text: runText(run, W),
    underline: on(child(props, W, 'u'))
  }
}

/** Runs that belong to this paragraph, not to a text box nested in it. */
function ownRuns(paragraph: Element): Element[] {
  return Array.from(paragraph.getElementsByTagNameNS(W, 'r')).filter(run => {
    let node = run.parentElement

    while (node && node !== paragraph) {
      if (node.namespaceURI === W && (node.localName === 'p' || node.localName === 'txbxContent')) {
        return false
      }

      node = node.parentElement
    }

    return true
  })
}

/** Whether each list in the file counts (decimal, letters) or uses bullets. */
function listFormats(pkg: OfficePackage): (numId: string, level: number) => boolean {
  const doc = pkg.xml('word/numbering.xml')

  if (!doc) {
    return () => false
  }

  const abstract = new Map<string, Element>()

  for (const item of Array.from(doc.getElementsByTagNameNS(W, 'abstractNum'))) {
    abstract.set(attr(item, 'abstractNumId', W) ?? '', item)
  }

  const nums = new Map<string, string>()

  for (const num of Array.from(doc.getElementsByTagNameNS(W, 'num'))) {
    nums.set(attr(num, 'numId', W) ?? '', attr(child(num, W, 'abstractNumId'), 'val', W) ?? '')
  }

  return (numId, level) => {
    const definition = abstract.get(nums.get(numId) ?? '')

    const lvl = definition
      ? children(definition, W, 'lvl').find(item => attr(item, 'ilvl', W) === String(level))
      : undefined

    const format = attr(child(lvl, W, 'numFmt'), 'val', W)

    return Boolean(format && format !== 'bullet' && format !== 'none')
  }
}

/** Reads the document; null when the file has no main part. */
export function readDocx(pkg: OfficePackage): DocxDocument | null {
  const doc = pkg.xml(DOCUMENT)
  const body = find(doc?.documentElement, W, 'body')

  if (!doc || !body) {
    return null
  }

  const rels = pkg.rels(DOCUMENT)
  const ordered = listFormats(pkg)
  let count = 0
  let section = ''

  const picture = (id: string) => {
    const rel = rels.get(id)

    return rel && !rel.external ? pkg.pictureUrl(rel.target) : undefined
  }

  const paragraph = (element: Element): DocxParagraph => {
    const props = child(element, W, 'pPr')
    const style = attr(child(props, W, 'pStyle'), 'val', W) ?? ''
    const level = /^heading\s?(\d)$/i.exec(style)?.[1]
    const heading = /^title$/i.test(style) ? 1 : level ? Math.min(Number(level), 3) : 0
    const numPr = child(props, W, 'numPr')
    const numId = attr(child(numPr, W, 'numId'), 'val', W)
    const listLevel = Number(attr(child(numPr, W, 'ilvl'), 'val', W) ?? 0)
    const jc = attr(child(props, W, 'jc'), 'val', W)
    const runs = ownRuns(element)

    const views = runs.map(run => {
      const link = run.parentElement
      const id = link?.localName === 'hyperlink' ? attr(link, 'id', NS.r) : null
      const target = id ? rels.get(id) : undefined

      return runView(run, target?.external ? target.target : undefined)
    })

    const found = Array.from(element.getElementsByTagNameNS(NS.a, 'blip'))
      .map(blip => picture(attr(blip, 'embed', NS.r) ?? ''))
      .filter((url): url is string => Boolean(url))

    const text = views
      .map(view => view.text)
      .join('')
      .trim()

    count += 1

    if (heading && text) {
      section = text
    }

    return {
      align:
        jc === 'center'
          ? 'center'
          : jc === 'right' || jc === 'end'
            ? 'end'
            : jc === 'both' || jc === 'distribute'
              ? 'justify'
              : undefined,
      element,
      heading,
      kind: 'paragraph',
      list:
        numId && numId !== '0'
          ? { level: listLevel, ordered: ordered(numId, listLevel) }
          : // A list style numbers its paragraphs itself, as Word's List Bullet does.
            /^list\s?(bullet|number)/i.test(style)
            ? { level: Number(/(\d)$/.exec(style)?.[1] ?? 1) - 1, ordered: /number/i.test(style) }
            : undefined,
      pictures: found,
      runs,
      title: /^title$/i.test(style),
      views,
      where: heading
        ? `the heading “${text.length > 60 ? `${text.slice(0, 59)}…` : text}”`
        : section
          ? `paragraph ${count}, under “${section.length > 60 ? `${section.slice(0, 59)}…` : section}”`
          : `paragraph ${count}`
    }
  }

  const blocks: DocxBlock[] = []

  for (const element of Array.from(body.children)) {
    if (element.namespaceURI !== W) {
      continue
    }

    if (element.localName === 'p') {
      blocks.push(paragraph(element))
    } else if (element.localName === 'tbl') {
      blocks.push({
        element,
        kind: 'table',
        rows: children(element, W, 'tr').map(row =>
          children(row, W, 'tc').map(cell => children(cell, W, 'p').map(paragraph))
        )
      })
    }
  }

  const sect = child(body, W, 'sectPr')
  const width = Number(attr(child(sect, W, 'pgSz'), 'w', W) ?? 12240)
  const margin = Number(attr(child(sect, W, 'pgMar'), 'left', W) ?? 1440)

  return { blocks, page: { margin: Math.round(margin / 15), width: Math.round(width / 15) } }
}

/** A run for new text, looking like `like` (or plain). */
function newRun(paragraph: Element, like?: Element): Element {
  const doc = paragraph.ownerDocument
  const run = doc.createElementNS(W, 'w:r')
  const props = like ? child(like, W, 'rPr') : child(child(paragraph, W, 'pPr'), W, 'rPr')

  if (props) {
    const copy = props.cloneNode(true) as Element

    // Tracked-change marks on the paragraph mark are not the new text's.
    for (const mark of children(copy, W, 'del').concat(children(copy, W, 'ins'))) {
      mark.remove()
    }

    run.append(copy)
  }

  return run
}

/** Puts a paragraph's edited text back; `texts` holds one string per run. */
export function setParagraphText(pkg: OfficePackage, block: DocxParagraph, texts: string[]) {
  if (!block.runs.length) {
    const text = texts.join('')

    if (!text) {
      return
    }

    const run = newRun(block.element)
    block.element.append(run)
    writeRuns([run], W, [text])
  } else {
    writeRuns(block.runs, W, texts)
  }

  pkg.touch(DOCUMENT)
}

/**
 * Splits a paragraph where Enter was pressed: `texts` is its text by run as
 * typed, and the split falls `offset` characters into run `run`. That run is
 * cut in two; it and everything after it (runs, links, bookmarks) move into
 * a new paragraph with the same style, formatting and all. Returns the new
 * paragraph's element.
 */
export function splitParagraph(
  pkg: OfficePackage,
  block: DocxParagraph,
  texts: string[],
  run: number,
  offset: number
): Element {
  setParagraphText(pkg, block, texts)

  const doc = block.element.ownerDocument
  const next = doc.createElementNS(W, 'w:p')
  const props = child(block.element, W, 'pPr')

  if (props) {
    next.append(props.cloneNode(true))
    // A section ends at the paragraph that carries its properties: now the new one.
    child(props, W, 'sectPr')?.remove()
  }

  // After a heading, Word goes on in body text.
  if (block.heading) {
    child(child(next, W, 'pPr'), W, 'pStyle')?.remove()
  }

  block.element.after(next)
  pkg.touch(DOCUMENT)

  // Runs read again: the text above may have merged them or made the first.
  const runs = ownRuns(block.element)
  const target = runs[Math.min(texts.length === runs.length ? run : 0, runs.length - 1)]

  if (!target) {
    next.append(newRun(next))

    return next
  }

  const whole = runText(target, W)
  // The second half takes the run's look, not what else it holds (a picture).
  const second = doc.createElementNS(W, target.tagName)
  const look = child(target, W, 'rPr')

  if (look) {
    second.append(look.cloneNode(true))
  }

  // Breaks after the caret go with the second half, page and column breaks as they were.
  const breaks = Array.from(target.children).filter(
    node => node.namespaceURI === W && (node.localName === 'br' || node.localName === 'cr')
  )

  const kept = (whole.slice(0, offset).match(/\n/g) ?? []).length

  for (const old of breaks.slice(kept)) {
    second.append(old.cloneNode(true))
  }

  setRunText(target, W, whole.slice(0, offset))
  setRunText(second, W, whole.slice(offset))

  // What holds the run inside the paragraph (a link) is copied around the
  // second half, then whatever followed at each level moves after it.
  const holders: Element[] = []

  for (let node = target.parentElement; node && node !== block.element; node = node.parentElement) {
    holders.unshift(node)
  }

  let into: Element = next

  for (const holder of holders) {
    const copy = holder.cloneNode(false) as Element
    into.append(copy)
    into = copy
  }

  into.append(second)

  for (
    let node: Element | null = target;
    node && node !== block.element;
    node = node.parentElement
  ) {
    while (node.nextSibling) {
      into.append(node.nextSibling)
    }

    into = into.parentElement ?? next
  }

  return next
}

/**
 * Joins a paragraph to the one before it, as Backspace at its start does:
 * its runs move over, formatting and all. Returns the length of the earlier
 * paragraph's text, where the caret goes.
 */
export function joinParagraph(
  pkg: OfficePackage,
  previous: DocxParagraph,
  block: DocxParagraph
): number {
  const length = previous.views.reduce((sum, view) => sum + view.text.length, 0)

  // Everything in the paragraph but its properties moves over in order: runs,
  // links, bookmarks and comment anchors, and a run typed a moment ago.
  for (const node of Array.from(block.element.children)) {
    if (!(node.namespaceURI === W && node.localName === 'pPr')) {
      previous.element.append(node)
    }
  }

  // A section that ended at the removed paragraph now ends at the joined one.
  const section = child(child(block.element, W, 'pPr'), W, 'sectPr')

  if (section) {
    let props = child(previous.element, W, 'pPr')

    if (!props) {
      props = previous.element.ownerDocument.createElementNS(W, 'w:pPr')
      previous.element.prepend(props)
    }

    child(props, W, 'sectPr')?.remove()
    props.append(section)
  }

  block.element.remove()
  pkg.touch(DOCUMENT)

  return length
}
