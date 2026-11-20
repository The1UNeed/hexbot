// An Office file (Word, Excel, PowerPoint) is a zip of XML parts. The panel
// reads the parts it shows and writes back only the ones it changed, so
// everything it does not understand (styles, charts, comments) is kept as is.

import { strFromU8, strToU8, unzipSync, type Zippable, zipSync } from 'fflate'

export const NS = {
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  p: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  rel: 'http://schemas.openxmlformats.org/package/2006/relationships',
  s: 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
} as const

/** The bytes of a base64 data URL. */
export function bytesOfDataUrl(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(',')
  const binary = atob(dataUrl.slice(comma + 1))
  const bytes = new Uint8Array(binary.length)

  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index)
  }

  return bytes
}

/** A base64 data URL of `bytes`. */
export function dataUrlOf(bytes: Uint8Array, mime: string): string {
  let binary = ''
  const chunk = 0x8000

  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk))
  }

  return `data:${mime};base64,${btoa(binary)}`
}

/** The MIME type of a picture inside a package, by its name. */
export function pictureMime(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()

  return (
    {
      bmp: 'image/bmp',
      gif: 'image/gif',
      jpeg: 'image/jpeg',
      jpg: 'image/jpeg',
      png: 'image/png',
      svg: 'image/svg+xml',
      tif: 'image/tiff',
      tiff: 'image/tiff',
      webp: 'image/webp'
    }[ext] ?? 'application/octet-stream'
  )
}

/**
 * An opened Office file. Parts are parsed on first use and serialized again
 * only when changed, so a save leaves every other part byte for byte.
 */
export class OfficePackage {
  private readonly files: Record<string, Uint8Array>
  private readonly parsed = new Map<string, XMLDocument>()
  private readonly changed = new Set<string>()
  private readonly removed = new Set<string>()
  private readonly pictures = new Map<string, string>()

  constructor(bytes: Uint8Array) {
    this.files = unzipSync(bytes)
  }

  static fromDataUrl(dataUrl: string): OfficePackage {
    return new OfficePackage(bytesOfDataUrl(dataUrl))
  }

  has(path: string): boolean {
    return path in this.files && !this.removed.has(path)
  }

  bytes(path: string): Uint8Array | undefined {
    return this.has(path) ? this.files[path] : undefined
  }

  /** The part at `path`, parsed; null when the file has none. */
  xml(path: string): XMLDocument | null {
    const cached = this.parsed.get(path)

    if (cached) {
      return cached
    }

    const bytes = this.bytes(path)

    if (!bytes) {
      return null
    }

    const doc = new DOMParser().parseFromString(strFromU8(bytes), 'application/xml')

    if (doc.getElementsByTagName('parsererror').length) {
      return null
    }

    this.parsed.set(path, doc)

    return doc
  }

  /** An object URL for a picture in the package, made once; `dispose` lets them go. */
  pictureUrl(path: string): string | undefined {
    const made = this.pictures.get(path)

    if (made) {
      return made
    }

    const bytes = this.bytes(path)

    if (!bytes) {
      return undefined
    }

    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: pictureMime(path) }))
    this.pictures.set(path, url)

    return url
  }

  dispose() {
    for (const url of this.pictures.values()) {
      URL.revokeObjectURL(url)
    }

    this.pictures.clear()
  }

  /** Marks a part changed; it is written again on the next save. */
  touch(path: string) {
    this.changed.add(path)
  }

  remove(path: string) {
    this.removed.add(path)
    this.parsed.delete(path)
  }

  /** Relationships of `part`, by id: each target resolved to a path in the package. */
  rels(part: string): Map<string, { target: string; type: string; external: boolean }> {
    const slash = part.lastIndexOf('/')
    const dir = part.slice(0, slash + 1)
    const doc = this.xml(`${dir}_rels/${part.slice(slash + 1)}.rels`)
    const found = new Map<string, { target: string; type: string; external: boolean }>()

    if (!doc) {
      return found
    }

    for (const rel of Array.from(doc.getElementsByTagNameNS(NS.rel, 'Relationship'))) {
      const external = rel.getAttribute('TargetMode') === 'External'
      const target = rel.getAttribute('Target') ?? ''

      found.set(rel.getAttribute('Id') ?? '', {
        external,
        target: external ? target : resolvePath(dir, target),
        type: rel.getAttribute('Type') ?? ''
      })
    }

    return found
  }

  /** The file with every change, as bytes. */
  save(): Uint8Array {
    const out: Zippable = {}
    const serializer = new XMLSerializer()

    for (const [path, bytes] of Object.entries(this.files)) {
      if (this.removed.has(path)) {
        continue
      }

      const doc = this.changed.has(path) ? this.parsed.get(path) : undefined
      let data = bytes

      if (doc) {
        let text = serializer.serializeToString(doc)

        // XMLSerializer drops the declaration Office expects.
        if (!text.startsWith('<?xml')) {
          text = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${text}`
        }

        // A Uint8Array of this realm: fflate tells files from folders with instanceof.
        data = new Uint8Array(strToU8(text))
      }

      out[path] = [data, { level: 6 }]
    }

    return zipSync(out)
  }
}

/** `target` taken from the folder `dir`, as a relationship names it. */
export function resolvePath(dir: string, target: string): string {
  if (target.startsWith('/')) {
    return target.slice(1)
  }

  const parts = (dir + target).split('/')
  const resolved: string[] = []

  for (const part of parts) {
    if (part === '..') {
      resolved.pop()
    } else if (part !== '.' && part !== '') {
      resolved.push(part)
    }
  }

  return resolved.join('/')
}

const keys = new WeakMap<Element, string>()
let keyed = 0

/** A key for a part of a file that stays the same while the file is edited, for React lists. */
export function keyOf(node: Element): string {
  let key = keys.get(node)

  if (!key) {
    key = `k${++keyed}`
    keys.set(node, key)
  }

  return key
}

/** Child elements of `node` with the local name `name` in namespace `ns`. */
export function children(node: Element, ns: string, name: string): Element[] {
  return Array.from(node.children).filter(
    child => child.namespaceURI === ns && child.localName === name
  )
}

export function child(node: Element | null | undefined, ns: string, name: string): Element | null {
  return node ? (children(node, ns, name)[0] ?? null) : null
}

/** The first descendant with this name, at any depth. */
export function find(node: Element | null | undefined, ns: string, name: string): Element | null {
  return node ? (node.getElementsByTagNameNS(ns, name)[0] ?? null) : null
}

/** An attribute in namespace `ns`, or a plain one. */
export function attr(node: Element | null | undefined, name: string, ns?: string): null | string {
  if (!node) {
    return null
  }

  return ns ? node.getAttributeNS(ns, name) : node.getAttribute(name)
}

/**
 * Sets the text of a run (`w:t` in Word, `a:t` in PowerPoint). In Word a tab
 * or line break in the text is written as its own `w:tab` or `w:br`.
 */
export function setRunText(run: Element, ns: string, text: string) {
  const doc = run.ownerDocument
  const prefix = run.prefix ? `${run.prefix}:` : ''

  // In PowerPoint a line break sits between runs: only the text element is the run's.
  if (ns === NS.a) {
    const keep = children(run, ns, 't')[0] ?? doc.createElementNS(ns, `${prefix}t`)

    for (const extra of children(run, ns, 't').slice(1)) {
      extra.remove()
    }

    if (!keep.parentNode) {
      run.append(keep)
    }

    keep.textContent = text

    return
  }

  // In Word, tabs and line breaks are elements of their own inside the run.
  // The new text goes where the old text was, so a picture after it stays after it.
  const old = Array.from(run.children).filter(
    node => node.namespaceURI === ns && ['br', 'cr', 'tab', 't'].includes(node.localName)
  )

  const fresh: Element[] = []

  for (const part of text.split(/(\t|\n)/)) {
    if (part === '\t') {
      fresh.push(doc.createElementNS(ns, `${prefix}tab`))
    } else if (part === '\n') {
      fresh.push(doc.createElementNS(ns, `${prefix}br`))
    } else if (part) {
      const t = doc.createElementNS(ns, `${prefix}t`)
      t.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:space', 'preserve')
      t.textContent = part
      fresh.push(t)
    }
  }

  // An emptied run keeps one text element, as Word writes it.
  if (!fresh.length) {
    fresh.push(doc.createElementNS(ns, `${prefix}t`))
  }

  if (old[0]) {
    old[0].before(...fresh)
  } else {
    run.append(...fresh)
  }

  for (const node of old) {
    node.remove()
  }
}
