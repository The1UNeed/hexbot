// An Excel file as the panel shows it: each sheet's cells as text, numbers
// and dates formatted the simple way. An edit changes only the cells it
// names; their style stays, and Excel recalculates formulas when it opens.

import { attr, child, children, find, NS, type OfficePackage } from './package'

const S = NS.s
const WORKBOOK = 'xl/workbook.xml'

export interface XlsxSheet {
  name: string
  path: string
  /** Shown values, row by row. */
  rows: string[][]
  columns: number
}

export interface XlsxWorkbook {
  sheets: XlsxSheet[]
}

/** Columns read at most; a sheet wider than this shows its first ones. */
const MAX_COLUMNS = 200

/** 0 for "A", 26 for "AA". */
export function columnIndex(letters: string): number {
  let index = 0

  for (const char of letters.toUpperCase()) {
    index = index * 26 + (char.charCodeAt(0) - 64)
  }

  return index - 1
}

function columnLetters(index: number): string {
  let name = ''
  let n = index + 1

  while (n > 0) {
    const rest = (n - 1) % 26
    name = String.fromCharCode(65 + rest) + name
    n = Math.floor((n - 1) / 26)
  }

  return name
}

export const cellRef = (row: number, col: number) => `${columnLetters(col)}${row + 1}`

function parseRef(ref: string): null | { col: number; row: number } {
  const match = /^([A-Z]+)(\d+)$/i.exec(ref)

  return match ? { col: columnIndex(match[1]!), row: Number(match[2]) - 1 } : null
}

/** The text of a shared or inline string, without its phonetic guide. */
function stringText(node: Element): string {
  const plain = child(node, S, 't')

  if (plain) {
    return plain.textContent ?? ''
  }

  return children(node, S, 'r')
    .map(run => child(run, S, 't')?.textContent ?? '')
    .join('')
}

const DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47])

interface Styles {
  /** By style index: how its numbers show. */
  kind: ('date' | 'number' | 'percent' | 'text')[]
  /** The workbook counts days from 1904, as some Mac workbooks do. */
  date1904: boolean
}

function readStyles(pkg: OfficePackage): Styles {
  const doc = pkg.xml('xl/styles.xml')
  const flag = attr(find(pkg.xml(WORKBOOK)?.documentElement, S, 'workbookPr'), 'date1904')
  const date1904 = flag === '1' || flag === 'true'

  if (!doc) {
    return { date1904, kind: [] }
  }

  const custom = new Map<number, string>()

  for (const format of Array.from(doc.getElementsByTagNameNS(S, 'numFmt'))) {
    custom.set(Number(attr(format, 'numFmtId')), attr(format, 'formatCode') ?? '')
  }

  const xfs = find(doc.documentElement, S, 'cellXfs')

  const kind = (xfs ? children(xfs, S, 'xf') : []).map(xf => {
    const id = Number(attr(xf, 'numFmtId') ?? 0)
    // Quoted text and colours in a format code are not date parts.
    const code = (custom.get(id) ?? '').replace(/"[^"]*"|\[[^\]]*\]/g, '')

    if (DATE_FORMATS.has(id) || (custom.has(id) && /[dmyhs]/i.test(code) && !/[#0]/.test(code))) {
      return 'date' as const
    }

    // Text format: what is typed stays text, leading zeros and all.
    if (id === 49 || (custom.has(id) && code.trim() === '@')) {
      return 'text' as const
    }

    if (id === 9 || id === 10 || code.includes('%')) {
      return 'percent' as const
    }

    return 'number' as const
  })

  return { date1904, kind }
}

/** Day 0 of Unix time as Excel counts days: from 1900, or from 1904 in a workbook set to it. */
const unixDay = (date1904: boolean) => (date1904 ? 24107 : 25569)

/** Excel's day number as a date, `2024-03-01` or `2024-03-01 14:30`. */
export function serialToDate(serial: number, date1904 = false): string {
  const ms = Math.round((serial - unixDay(date1904)) * 86400 * 1000)
  const date = new Date(ms)
  const day = date.toISOString().slice(0, 10)
  const time = date.toISOString().slice(11, 16)

  return serial % 1 === 0 || time === '00:00' ? day : `${day} ${time}`
}

/** A date typed as `2024-03-01` (with an optional time) as Excel's day number. */
export function dateToSerial(text: string, date1904 = false): null | number {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/.exec(text.trim())

  if (!match) {
    return null
  }

  const ms = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4] ?? 0),
    Number(match[5] ?? 0)
  )

  return Number.isNaN(ms) ? null : ms / 86400000 + unixDay(date1904)
}

const formatNumber = (value: number) =>
  Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(12)))

interface Context {
  shared: string[]
  styles: Styles
}

function context(pkg: OfficePackage): Context {
  const doc = pkg.xml('xl/sharedStrings.xml')
  const shared = doc ? Array.from(doc.getElementsByTagNameNS(S, 'si')).map(stringText) : []

  return { shared, styles: readStyles(pkg) }
}

/** The value a cell shows. */
function shownValue(cell: Element, ctx: Context): string {
  const type = attr(cell, 't')
  const value = child(cell, S, 'v')?.textContent ?? ''

  if (type === 's') {
    return ctx.shared[Number(value)] ?? ''
  }

  if (type === 'inlineStr') {
    const inline = child(cell, S, 'is')

    return inline ? stringText(inline) : ''
  }

  if (type === 'b') {
    return value === '1' ? 'TRUE' : value === '0' ? 'FALSE' : value
  }

  if (type === 'str' || type === 'e') {
    return value
  }

  const formula = child(cell, S, 'f')?.textContent

  // A formula the panel wrote has no value until Excel calculates it.
  if (value === '') {
    return formula ? `=${formula}` : ''
  }

  const number = Number(value)

  if (Number.isNaN(number)) {
    return value
  }

  const kind = ctx.styles.kind[Number(attr(cell, 's') ?? 0)]

  if (kind === 'date') {
    return serialToDate(number, ctx.styles.date1904)
  }

  if (kind === 'percent') {
    return `${formatNumber(number * 100)}%`
  }

  return formatNumber(number)
}

function readSheet(
  pkg: OfficePackage,
  path: string,
  ctx: Context
): Pick<XlsxSheet, 'columns' | 'rows'> {
  const doc = pkg.xml(path)
  const data = find(doc?.documentElement, S, 'sheetData')
  const rows: string[][] = []
  let columns = 0

  if (!data) {
    return { columns: 0, rows }
  }

  let implicitRow = 0

  for (const row of children(data, S, 'row')) {
    const index = attr(row, 'r') ? Number(attr(row, 'r')) - 1 : implicitRow
    implicitRow = index + 1
    const values: string[] = []
    let implicitCol = 0

    for (const cell of children(row, S, 'c')) {
      const ref = parseRef(attr(cell, 'r') ?? '')
      const col = ref ? ref.col : implicitCol
      implicitCol = col + 1

      if (col >= MAX_COLUMNS) {
        continue
      }

      const shown = shownValue(cell, ctx)

      if (shown !== '') {
        while (values.length < col) {
          values.push('')
        }

        values[col] = shown
      }
    }

    if (values.length) {
      while (rows.length < index) {
        rows.push([])
      }

      rows[index] = values
      columns = Math.max(columns, values.length)
    }
  }

  return { columns, rows }
}

export function readXlsx(pkg: OfficePackage): XlsxWorkbook | null {
  const doc = pkg.xml(WORKBOOK)

  if (!doc) {
    return null
  }

  const rels = pkg.rels(WORKBOOK)
  const ctx = context(pkg)

  const sheets = Array.from(doc.getElementsByTagNameNS(S, 'sheet'))
    .map(sheet => {
      const rel = rels.get(attr(sheet, 'id', NS.r) ?? '')

      return rel && pkg.has(rel.target)
        ? { name: attr(sheet, 'name') ?? 'Sheet', path: rel.target }
        : null
    })
    .filter((sheet): sheet is { name: string; path: string } => sheet !== null)
    .map(sheet => ({ ...sheet, ...readSheet(pkg, sheet.path, ctx) }))

  return { sheets }
}

function cellAt(pkg: OfficePackage, path: string, row: number, col: number): Element | null {
  const data = find(pkg.xml(path)?.documentElement, S, 'sheetData')

  const rowNode = data
    ? children(data, S, 'row').find(node => Number(attr(node, 'r')) === row + 1)
    : undefined

  const ref = cellRef(row, col)

  return rowNode ? (children(rowNode, S, 'c').find(cell => attr(cell, 'r') === ref) ?? null) : null
}

/** What a cell edits as: `=` and its formula, or the value it shows. */
export function cellSource(pkg: OfficePackage, sheet: XlsxSheet, row: number, col: number): string {
  const cell = cellAt(pkg, sheet.path, row, col)
  const formula = cell ? child(cell, S, 'f') : null

  if (formula?.textContent) {
    return `=${formula.textContent}`
  }

  // A plain number edits as stored, every digit, not as shown.
  const stored = child(cell, S, 'v')?.textContent

  if (
    cell &&
    stored &&
    !attr(cell, 't') &&
    readStyles(pkg).kind[Number(attr(cell, 's') ?? 0)] === 'number'
  ) {
    return stored
  }

  return sheet.rows[row]?.[col] ?? ''
}

/** The cell's element, made in its place (rows and cells in order) if missing. */
function ensureCell(doc: XMLDocument, data: Element, row: number, col: number): Element {
  const prefix = data.prefix ? `${data.prefix}:` : ''
  const rows = children(data, S, 'row')
  let rowNode = rows.find(node => Number(attr(node, 'r')) === row + 1)

  if (!rowNode) {
    rowNode = doc.createElementNS(S, `${prefix}row`)
    rowNode.setAttribute('r', String(row + 1))
    const after = rows.find(node => Number(attr(node, 'r')) > row + 1)
    data.insertBefore(rowNode, after ?? null)
  }

  const ref = cellRef(row, col)
  const cells = children(rowNode, S, 'c')
  let cell = cells.find(node => attr(node, 'r') === ref)

  if (!cell) {
    cell = doc.createElementNS(S, `${prefix}c`)
    cell.setAttribute('r', ref)
    const after = cells.find(node => columnIndex((attr(node, 'r') ?? '').replace(/\d+/g, '')) > col)
    rowNode.insertBefore(cell, after ?? null)
    // A new cell in a styled row takes the row's style.
    const style = attr(rowNode, 's')

    if (style && attr(rowNode, 'customFormat') === '1') {
      cell.setAttribute('s', style)
    }
  }

  return cell
}

/**
 * Cells changed: Excel recalculates on open, so formulas that read them show
 * new results. When formulas themselves changed, its calculation order goes
 * too, and Excel rebuilds it.
 */
function cellsChanged(pkg: OfficePackage, formulas: boolean) {
  const workbook = pkg.xml(WORKBOOK)

  if (workbook) {
    const root = workbook.documentElement
    let calc = child(root, S, 'calcPr')

    if (!calc) {
      calc = workbook.createElementNS(S, `${root.prefix ? `${root.prefix}:` : ''}calcPr`)

      const before = [
        'oleSize',
        'customWorkbookViews',
        'pivotCaches',
        'smartTagPr',
        'smartTagTypes',
        'webPublishing',
        'fileRecoveryPr',
        'webPublishObjects',
        'extLst'
      ]
        .map(name => child(root, S, name))
        .find(Boolean)

      root.insertBefore(calc, before ?? null)
    }

    calc.setAttribute('fullCalcOnLoad', '1')
    pkg.touch(WORKBOOK)
  }

  const chain = 'xl/calcChain.xml'

  if (formulas && pkg.has(chain)) {
    pkg.remove(chain)
    const types = pkg.xml('[Content_Types].xml')

    for (const override of Array.from(types?.documentElement.children ?? [])) {
      if (override.getAttribute('PartName') === `/${chain}`) {
        override.remove()
        pkg.touch('[Content_Types].xml')
      }
    }

    const rels = pkg.xml('xl/_rels/workbook.xml.rels')

    for (const rel of Array.from(rels?.documentElement.children ?? [])) {
      if ((rel.getAttribute('Target') ?? '').endsWith('calcChain.xml')) {
        rel.remove()
        pkg.touch('xl/_rels/workbook.xml.rels')
      }
    }
  }
}

/** Why a cell cannot be edited here, or null. */
export function cellLocked(
  pkg: OfficePackage,
  sheet: XlsxSheet,
  row: number,
  col: number
): null | string {
  const formula = child(cellAt(pkg, sheet.path, row, col), S, 'f')

  if (formula && attr(formula, 't') === 'shared' && attr(formula, 'ref')) {
    return 'Other cells share this formula. Ask the bot to change it.'
  }

  // An array formula owns every cell of its range, not only the first.
  const arrays = Array.from(pkg.xml(sheet.path)?.getElementsByTagNameNS(S, 'f') ?? []).filter(
    node => attr(node, 't') === 'array' && attr(node, 'ref')
  )

  for (const array of arrays) {
    const [from, to = from] = (attr(array, 'ref') ?? '').split(':').map(parseRef)

    if (
      from &&
      to &&
      row >= Math.min(from.row, to.row) &&
      row <= Math.max(from.row, to.row) &&
      col >= Math.min(from.col, to.col) &&
      col <= Math.max(from.col, to.col)
    ) {
      return 'This cell is part of an array formula. Ask the bot to change it.'
    }
  }

  if (formula && attr(formula, 't') === 'array') {
    return 'This cell holds an array formula. Ask the bot to change it.'
  }

  return null
}

/**
 * Sets cells as typed: `=…` is a formula, a number is a number, a date
 * typed as 2024-03-01 in a date cell is a date, and anything else is text.
 * An empty value clears the cell and keeps its style.
 */
export function setCells(
  pkg: OfficePackage,
  sheet: XlsxSheet,
  changes: { col: number; row: number; value: string }[]
) {
  const doc = pkg.xml(sheet.path)
  const data = find(doc?.documentElement, S, 'sheetData')

  if (!doc || !data) {
    return
  }

  // Rows and cells the file numbers by position get their reference written,
  // the way the reader counts them, so an edit finds them.
  let rowAt = 0

  for (const rowNode of children(data, S, 'row')) {
    const index = attr(rowNode, 'r') ? Number(attr(rowNode, 'r')) - 1 : rowAt
    rowNode.setAttribute('r', String(index + 1))
    rowAt = index + 1
    let colAt = 0

    for (const cell of children(rowNode, S, 'c')) {
      const ref = parseRef(attr(cell, 'r') ?? '')
      const col = ref ? ref.col : colAt
      cell.setAttribute('r', cellRef(index, col))
      colAt = col + 1
    }
  }

  const styles = readStyles(pkg)
  let formulas = false

  for (const { col, row, value } of changes) {
    const cell = ensureCell(doc, data, row, col)
    const prefix = cell.prefix ? `${cell.prefix}:` : ''

    for (const old of Array.from(cell.children)) {
      if (old.localName === 'f') {
        formulas = true
      }

      if (['f', 'v', 'is'].includes(old.localName)) {
        old.remove()
      }
    }

    cell.removeAttribute('t')
    const text = value
    const kind = styles.kind[Number(attr(cell, 's') ?? 0)]
    const date = kind === 'date' ? dateToSerial(text, styles.date1904) : null

    // A percent cell shows 25% for 0.25, and takes 30% back the same way.
    const percent =
      kind === 'percent' ? /^\s*(-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*%\s*$/i.exec(text) : null

    if (text === '') {
      continue
    }

    if (kind !== 'text' && text.startsWith('=') && text.length > 1) {
      const formula = doc.createElementNS(S, `${prefix}f`)
      formula.textContent = text.slice(1)
      cell.append(formula)
      formulas = true
    } else if (
      kind !== 'text' &&
      (date !== null || percent || /^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(text.trim()))
    ) {
      const number = doc.createElementNS(S, `${prefix}v`)
      number.textContent = String(
        date ?? (percent ? Number(percent[1]) / 100 : Number(text.trim()))
      )
      cell.append(number)
    } else {
      cell.setAttribute('t', 'inlineStr')
      const inline = doc.createElementNS(S, `${prefix}is`)
      const t = doc.createElementNS(S, `${prefix}t`)
      t.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:space', 'preserve')
      t.textContent = text
      inline.append(t)
      cell.append(inline)
    }
  }

  // The sheet's stated size covers the new cells.
  const dimension = child(doc.documentElement, S, 'dimension')

  if (dimension) {
    let maxRow = 0
    let maxCol = 0

    for (const rowNode of children(data, S, 'row')) {
      for (const cell of children(rowNode, S, 'c')) {
        const ref = parseRef(attr(cell, 'r') ?? '')

        if (ref) {
          maxRow = Math.max(maxRow, ref.row)
          maxCol = Math.max(maxCol, ref.col)
        }
      }
    }

    dimension.setAttribute('ref', `A1:${cellRef(maxRow, maxCol)}`)
  }

  pkg.touch(sheet.path)

  cellsChanged(pkg, formulas)

  Object.assign(sheet, readSheet(pkg, sheet.path, context(pkg)))
}
