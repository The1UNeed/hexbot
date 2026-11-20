// A PowerPoint file as the panel shows it: each slide's text boxes, shapes,
// pictures and tables where the slide puts them, with the theme's colours.
// It is a preview, not PowerPoint: charts, effects and animations show as a
// plain box or not at all. Text edits change the runs in place.

import { attr, child, children, find, NS, type OfficePackage } from './package'
import { runText, type RunView, writeRuns } from './runs'

const A = NS.a
const P = NS.p
const PRESENTATION = 'ppt/presentation.xml'

export interface PptxParagraph {
  element: Element
  runs: Element[]
  views: RunView[]
  align?: 'center' | 'end' | 'justify' | 'start'
  bullet: boolean
  level: number
  /** Points, for an empty paragraph's height. */
  size: number
}

interface Box {
  x: number
  y: number
  w: number
  h: number
}

export type PptxShape = Box & {
  /** 'text' boxes and shapes, 'picture's, 'table's and anything else as a plain 'frame'. */
  kind: 'frame' | 'picture' | 'table' | 'text'
  id: string
  fill?: string
  line?: string
  round?: 'ellipse' | 'rounded'
  rotation?: number
  paragraphs?: PptxParagraph[]
  anchor?: 'bottom' | 'middle' | 'top'
  inset?: { b: number; l: number; r: number; t: number }
  /** A picture's object URL. */
  src?: string
  /** A table's cells, each a cell's paragraphs. */
  cells?: PptxParagraph[][][]
  columns?: number[]
  label?: string
}

export interface PptxSlide {
  index: number
  path: string
  background: string
  shapes: PptxShape[]
}

export interface PptxDeck {
  /** EMU. */
  width: number
  height: number
  slides: PptxSlide[]
}

const SCHEME_ALIAS: Record<string, string> = { bg1: 'lt1', bg2: 'lt2', tx1: 'dk1', tx2: 'dk2' }

type Colors = Map<string, string>

function themeColors(pkg: OfficePackage, master: string): Colors {
  const colors: Colors = new Map()
  const theme = [...pkg.rels(master).values()].find(rel => rel.type.endsWith('/theme'))
  const scheme = theme ? find(pkg.xml(theme.target)?.documentElement, A, 'clrScheme') : null

  for (const entry of Array.from(scheme?.children ?? [])) {
    const srgb = child(entry, A, 'srgbClr')
    const sys = child(entry, A, 'sysClr')
    const value = attr(srgb, 'val') ?? attr(sys, 'lastClr')

    if (value) {
      colors.set(entry.localName, `#${value}`)
    }
  }

  return colors
}

/** Applies DrawingML's lumMod and lumOff to a colour, which themes use for tints. */
function adjust(hex: string, node: Element): string {
  const mod = Number(attr(child(node, A, 'lumMod'), 'val') ?? 100000) / 100000
  const off = Number(attr(child(node, A, 'lumOff'), 'val') ?? 0) / 100000

  if (mod === 1 && off === 0) {
    return hex
  }

  const channel = (index: number) => parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16)

  const out = [0, 1, 2]
    .map(index => Math.round(Math.min(255, Math.max(0, channel(index) * mod + 255 * off))))
    .map(value => value.toString(16).padStart(2, '0'))
    .join('')

  return `#${out}`
}

/** The colour a fill or run names: an RGB value or one of the theme's. */
function colorOf(node: Element | null, colors: Colors): string | undefined {
  if (!node) {
    return undefined
  }

  const srgb = child(node, A, 'srgbClr')

  if (srgb) {
    return adjust(`#${attr(srgb, 'val')}`, srgb)
  }

  const scheme = child(node, A, 'schemeClr')

  if (scheme) {
    const name = attr(scheme, 'val') ?? ''
    const base = colors.get(SCHEME_ALIAS[name] ?? name)

    return base ? adjust(base, scheme) : undefined
  }

  const preset = child(node, A, 'prstClr')

  return preset ? (attr(preset, 'val') ?? undefined) : undefined
}

function boxOf(xfrm: Element | null): Box | null {
  const off = child(xfrm, A, 'off')
  const ext = child(xfrm, A, 'ext')

  if (!off || !ext) {
    return null
  }

  return {
    h: Number(attr(ext, 'cy')),
    w: Number(attr(ext, 'cx')),
    x: Number(attr(off, 'x')),
    y: Number(attr(off, 'y'))
  }
}

/** A placeholder's type and index, which a layout and master match on. */
function placeholder(shape: Element): null | { idx: null | string; type: string } {
  const nv = Array.from(shape.children).find(node => node.localName.startsWith('nv'))
  const ph = find(nv, P, 'ph')

  return ph ? { idx: attr(ph, 'idx'), type: attr(ph, 'type') ?? 'body' } : null
}

function samePlaceholder(
  a: { idx: null | string; type: string },
  b: { idx: null | string; type: string }
) {
  const title = (type: string) => (type === 'ctrTitle' ? 'title' : type)

  return (a.idx !== null && a.idx === b.idx) || title(a.type) === title(b.type)
}

interface Inherited {
  box?: Box
  size?: number
  anchor?: string
}

/** What a placeholder takes from its layout, then its master. */
function inherited(
  pkg: OfficePackage,
  parts: string[],
  ph: { idx: null | string; type: string }
): Inherited {
  const found: Inherited = {}

  for (const part of parts) {
    const tree = find(pkg.xml(part)?.documentElement, P, 'spTree')

    for (const shape of tree ? children(tree, P, 'sp') : []) {
      const other = placeholder(shape)

      if (!other || !samePlaceholder(ph, other)) {
        continue
      }

      found.box ??= boxOf(find(child(shape, P, 'spPr'), A, 'xfrm')) ?? undefined
      const size = attr(find(find(child(shape, P, 'txBody'), A, 'lvl1pPr'), A, 'defRPr'), 'sz')

      if (size) {
        found.size ??= Number(size) / 100
      }

      found.anchor ??= attr(child(child(shape, P, 'txBody'), A, 'bodyPr'), 'anchor') ?? undefined

      break
    }
  }

  return found
}

/** The master's text size for a kind of text, in points. */
function masterSize(pkg: OfficePackage, master: string, type: string): number | undefined {
  const styles = find(pkg.xml(master)?.documentElement, P, 'txStyles')

  const kind =
    type === 'title' || type === 'ctrTitle'
      ? 'titleStyle'
      : type === 'body' || type === 'subTitle' || type === 'obj'
        ? 'bodyStyle'
        : 'otherStyle'

  const size = attr(find(find(child(styles, P, kind), A, 'lvl1pPr'), A, 'defRPr'), 'sz')

  return size ? Number(size) / 100 : undefined
}

function backgroundOf(pkg: OfficePackage, part: string, colors: Colors): string | undefined {
  const bg = find(find(pkg.xml(part)?.documentElement, P, 'cSld'), P, 'bg')

  if (!bg) {
    return undefined
  }

  const props = child(bg, P, 'bgPr')

  if (props) {
    return colorOf(child(props, A, 'solidFill'), colors) ?? colorOf(find(props, A, 'gs'), colors)
  }

  return colorOf(child(bg, P, 'bgRef'), colors)
}

function paragraphsOf(
  body: Element | null,
  colors: Colors,
  size: number,
  scale: number,
  /** A body placeholder: its paragraphs are bulleted unless they say not. */
  bulleted = false
): PptxParagraph[] {
  if (!body) {
    return []
  }

  return children(body, A, 'p').map(element => {
    const props = child(element, A, 'pPr')
    const algn = attr(props, 'algn')

    // A line break sits between runs; it shows, and editing leaves it be.
    const ordered = Array.from(element.children).filter(
      node => node.namespaceURI === A && ['br', 'fld', 'r'].includes(node.localName)
    )

    const end = child(element, A, 'endParaRPr')
    const endSize = attr(end, 'sz')

    return {
      align:
        algn === 'ctr' ? 'center' : algn === 'r' ? 'end' : algn === 'just' ? 'justify' : undefined,
      bullet: Boolean(
        child(props, A, 'buChar') ||
        child(props, A, 'buAutoNum') ||
        (bulleted && !child(props, A, 'buNone') && ordered.some(run => runText(run, A).trim()))
      ),
      element,
      level: Number(attr(props, 'lvl') ?? 0),
      runs: ordered,
      size: (endSize ? Number(endSize) / 100 : size) * scale,
      views: ordered.map(run => {
        const rp = child(run, A, 'rPr')
        const sz = attr(rp, 'sz')

        if (run.localName === 'br') {
          return { text: '\n' }
        }

        return {
          bold: attr(rp, 'b') === '1',
          color: colorOf(child(rp, A, 'solidFill'), colors),
          italic: attr(rp, 'i') === '1',
          size: (sz ? Number(sz) / 100 : size) * scale,
          strike: (attr(rp, 'strike') ?? 'noStrike') !== 'noStrike',
          text: runText(run, A),
          underline: (attr(rp, 'u') ?? 'none') !== 'none'
        }
      })
    }
  })
}

let shapeIds = 0

function readSlide(pkg: OfficePackage, path: string, index: number): PptxSlide {
  const rels = pkg.rels(path)
  const layout = [...rels.values()].find(rel => rel.type.endsWith('/slideLayout'))?.target

  const master = layout
    ? [...pkg.rels(layout).values()].find(rel => rel.type.endsWith('/slideMaster'))?.target
    : undefined

  const colors = master ? themeColors(pkg, master) : new Map<string, string>()
  const parts = [layout, master].filter((part): part is string => Boolean(part))
  const shapes: PptxShape[] = []

  const walk = (tree: Element, place: (box: Box) => Box) => {
    for (const node of Array.from(tree.children)) {
      const id = `shape-${++shapeIds}`

      if (node.namespaceURI !== P) {
        continue
      }

      if (node.localName === 'grpSp') {
        const xfrm = find(child(node, P, 'grpSpPr'), A, 'xfrm')
        const outer = boxOf(xfrm)
        const chOff = child(xfrm, A, 'chOff')
        const chExt = child(xfrm, A, 'chExt')

        if (outer && chOff && chExt) {
          const cx = Number(attr(chOff, 'x'))
          const cy = Number(attr(chOff, 'y'))
          const sx = outer.w / (Number(attr(chExt, 'cx')) || outer.w || 1)
          const sy = outer.h / (Number(attr(chExt, 'cy')) || outer.h || 1)

          walk(node, box =>
            place({
              h: box.h * sy,
              w: box.w * sx,
              x: outer.x + (box.x - cx) * sx,
              y: outer.y + (box.y - cy) * sy
            })
          )
        } else {
          walk(node, place)
        }

        continue
      }

      if (node.localName === 'sp' || node.localName === 'cxnSp') {
        const props = child(node, P, 'spPr')
        const xfrm = find(props, A, 'xfrm')
        const ph = placeholder(node)
        const from = ph ? inherited(pkg, parts, ph) : {}
        const box = boxOf(xfrm) ?? from.box

        if (!box) {
          continue
        }

        const body = child(node, P, 'txBody')
        const bodyPr = child(body, A, 'bodyPr')
        const fit = child(bodyPr, A, 'normAutofit')
        const scale = Number(attr(fit, 'fontScale') ?? 100000) / 100000

        const size =
          from.size ?? (ph && master ? masterSize(pkg, master, ph.type) : undefined) ?? 18

        const geometry = attr(child(props, A, 'prstGeom'), 'prst')
        const anchor = attr(bodyPr, 'anchor') ?? from.anchor
        const inset = (name: string, fallback: number) => Number(attr(bodyPr, name) ?? fallback)
        const style = child(node, P, 'style')

        shapes.push({
          ...place(box),
          anchor: anchor === 'ctr' ? 'middle' : anchor === 'b' ? 'bottom' : 'top',
          fill: child(props, A, 'noFill')
            ? undefined
            : (colorOf(child(props, A, 'solidFill'), colors) ??
              colorOf(child(style, A, 'fillRef'), colors)),
          id,
          inset: {
            b: inset('bIns', 45720),
            l: inset('lIns', 91440),
            r: inset('rIns', 91440),
            t: inset('tIns', 45720)
          },
          kind: 'text',
          line: child(child(props, A, 'ln'), A, 'noFill')
            ? undefined
            : colorOf(child(child(props, A, 'ln'), A, 'solidFill'), colors),
          paragraphs: paragraphsOf(
            body,
            colors,
            size,
            scale,
            ph !== null && (ph.type === 'body' || ph.type === 'obj')
          ),
          rotation: Number(attr(xfrm, 'rot') ?? 0) / 60000 || undefined,
          round:
            geometry === 'ellipse' ? 'ellipse' : geometry === 'roundRect' ? 'rounded' : undefined
        })
      } else if (node.localName === 'pic') {
        const box = boxOf(find(child(node, P, 'spPr'), A, 'xfrm'))
        const embed = attr(find(child(node, P, 'blipFill'), A, 'blip'), 'embed', NS.r)
        const rel = embed ? rels.get(embed) : undefined

        if (box) {
          shapes.push({
            ...place(box),
            id,
            kind: 'picture',
            src: rel && !rel.external ? pkg.pictureUrl(rel.target) : undefined
          })
        }
      } else if (node.localName === 'graphicFrame') {
        const box = boxOf(child(node, P, 'xfrm'))
        const table = find(node, A, 'tbl')

        if (!box) {
          continue
        }

        if (table) {
          shapes.push({
            ...place(box),
            cells: children(table, A, 'tr').map(row =>
              children(row, A, 'tc').map(cell =>
                paragraphsOf(child(cell, A, 'txBody'), colors, 14, 1)
              )
            ),
            columns: children(child(table, A, 'tblGrid') ?? table, A, 'gridCol').map(col =>
              Number(attr(col, 'w'))
            ),
            id,
            kind: 'table'
          })
        } else {
          const uri = attr(find(node, A, 'graphicData'), 'uri') ?? ''

          shapes.push({
            ...place(box),
            id,
            kind: 'frame',
            label: uri.includes('chart') ? 'Chart' : uri.includes('diagram') ? 'Diagram' : 'Object'
          })
        }
      }
    }
  }

  const tree = find(pkg.xml(path)?.documentElement, P, 'spTree')

  if (tree) {
    walk(tree, box => box)
  }

  const background =
    backgroundOf(pkg, path, colors) ??
    (layout ? backgroundOf(pkg, layout, colors) : undefined) ??
    (master ? backgroundOf(pkg, master, colors) : undefined) ??
    colors.get('lt1') ??
    '#ffffff'

  return { background, index, path, shapes }
}

export function readPptx(pkg: OfficePackage): PptxDeck | null {
  const doc = pkg.xml(PRESENTATION)

  if (!doc) {
    return null
  }

  const size = find(doc.documentElement, P, 'sldSz')
  const rels = pkg.rels(PRESENTATION)

  const slides = Array.from(doc.getElementsByTagNameNS(P, 'sldId'))
    .map(slide => rels.get(attr(slide, 'id', NS.r) ?? '')?.target)
    .filter((path): path is string => Boolean(path && pkg.has(path)))
    .map((path, index) => readSlide(pkg, path, index))

  return {
    height: Number(attr(size, 'cy') ?? 6858000),
    slides,
    width: Number(attr(size, 'cx') ?? 12192000)
  }
}

/** Puts a paragraph's edited text back, one string per run. */
export function setSlideText(
  pkg: OfficePackage,
  slide: PptxSlide,
  paragraph: PptxParagraph,
  texts: string[]
) {
  if (paragraph.runs.length) {
    writeRuns(paragraph.runs, A, texts)
  } else {
    const text = texts.join('')

    if (!text) {
      return
    }

    const doc = paragraph.element.ownerDocument
    const prefix = paragraph.element.prefix ? `${paragraph.element.prefix}:` : ''
    const run = doc.createElementNS(A, `${prefix}r`)
    const end = child(paragraph.element, A, 'endParaRPr')
    const props = doc.createElementNS(A, `${prefix}rPr`)

    // The paragraph's end properties are how its text looks when typed.
    for (const name of Array.from(end?.attributes ?? [])) {
      props.setAttribute(name.name, name.value)
    }

    for (const node of Array.from(end?.children ?? [])) {
      props.append(node.cloneNode(true))
    }

    run.append(props)
    paragraph.element.insertBefore(run, end)
    writeRuns([run], A, [text])
  }

  pkg.touch(slide.path)
}
