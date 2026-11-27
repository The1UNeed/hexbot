// What the phone's file card can change in a file, kept apart from the card
// so it can be tested: which editor a file gets, edits to a table, the steps
// of a picture's markup, and what a refused save means.

import { parseDelimited, serializeDelimited } from '../../../web/src/lib/delimited'
import { type Range, rangeBounds } from '../../../web/src/lib/file-comments'
import { extensionOf } from '../../../web/src/lib/file-kinds'
import { type Area, EMPTY, type Markup } from '../../../web/src/lib/markup'
import type { OpenedFile } from './files'

/** How the card edits a file: text as it is, Markdown formatted or as text, a table, a picture. */
export type Editor = 'image' | 'markdown' | 'table' | 'text'

/** Pictures the daemon takes back whole; any other is marked up only to send. */
const SAVES = new Set(['image/jpeg', 'image/png', 'image/webp'])

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp'
}

/** The editor a file opens in, or null for one the card only shows. */
export function editorOf(file: OpenedFile): Editor | null {
  const ext = extensionOf(file.name)

  if (file.text !== undefined) {
    if (ext === 'csv' || ext === 'tsv') return 'table'
    return ext === 'md' || ext === 'markdown' ? 'markdown' : 'text'
  }

  // An SVG is a page that can run code; it stays a picture shown elsewhere.
  if (file.data_url && file.mime.startsWith('image/') && file.mime !== 'image/svg+xml') {
    return 'image'
  }

  return null
}

/** The picture can be saved back over its file: a PNG, JPEG or WebP. */
export const savesPicture = (mime: string) => SAVES.has(mime)

/** The format a marked-up picture is written in: its own, or PNG. */
export const pictureMime = (mime: string) => (SAVES.has(mime) ? mime : 'image/png')

/** The name a marked-up picture goes by: its own, or its stem with the format written. */
export function pictureName(name: string, mime: string): string {
  const written = pictureMime(mime)
  return written === mime ? name : `${name.replace(/\.[^.]+$/, '')}.${EXTENSIONS[written]}`
}

/** The delimiter a table's file uses. */
export const delimiterOf = (name: string) => (extensionOf(name) === 'tsv' ? '\t' : ',')

/** A table's rows, every one of them: the card shows fewer, and saves them all. */
export const rowsOf = (text: string, name: string) => parseDelimited(text, delimiterOf(name))

/** The file for `rows`, with the line endings, byte-order mark and last line break `like` had. */
export const tableText = (rows: string[][], name: string, like: string) =>
  serializeDelimited(rows, delimiterOf(name), like)

/** `rows` with one cell set, the row widened to reach it. */
export function setCell(rows: string[][], row: number, col: number, value: string): string[][] {
  const next = rows.slice()
  while (next.length <= row) next.push([''])
  const cells = next[row]!.slice()
  while (cells.length <= col) cells.push('')
  cells[col] = value
  next[row] = cells
  return next
}

/** `rows` with an empty row added at the end, as wide as the widest. */
export function addRow(rows: string[][]): string[][] {
  const columns = rows.reduce((most, row) => Math.max(most, row.length), 1)
  return [...rows, Array.from({ length: columns }, () => '')]
}

/** The values in a range, a row a line and tab-separated, as a comment quotes them. */
export function rangeQuote(rows: string[][], range: Range): string {
  const { bottom, left, right, top } = rangeBounds(range)
  return rows
    .slice(top, bottom + 1)
    .map(row => Array.from({ length: right - left + 1 }, (_, i) => row[left + i] ?? '').join('\t'))
    .join('\n')
}

/** The marks on a picture and the steps undo and redo walk. */
export interface Steps {
  past: Markup[]
  now: Markup
  future: Markup[]
}

/** Undo goes back this many steps at most. */
const STEPS = 100

export const freshSteps = (): Steps => ({ future: [], now: EMPTY, past: [] })

/** A new step; redo forgets what was undone. */
export const step = (steps: Steps, next: Markup): Steps => ({
  future: [],
  now: next,
  past: [...steps.past.slice(-(STEPS - 1)), steps.now]
})

export const undo = (steps: Steps): Steps =>
  steps.past.length
    ? {
        future: [steps.now, ...steps.future],
        now: steps.past[steps.past.length - 1]!,
        past: steps.past.slice(0, -1)
      }
    : steps

export const redo = (steps: Steps): Steps =>
  steps.future.length
    ? { future: steps.future.slice(1), now: steps.future[0]!, past: [...steps.past, steps.now] }
    : steps

/**
 * The part of a `width` × `height` picture a crop keeps: both edges inside
 * it, so a drag past one keeps only what was selected. Null for a sliver.
 */
export function cropWithin(area: Area, width: number, height: number): Area | null {
  const x = Math.max(0, area.x)
  const y = Math.max(0, area.y)
  const right = Math.min(width, area.x + area.w)
  const bottom = Math.min(height, area.y + area.h)
  return right - x > 8 && bottom - y > 8 ? { h: bottom - y, w: right - x, x, y } : null
}

/** Line widths and text sizes for the three sizes, scaled to the picture, as the desktop's. */
export function markSizes(width: number, height: number, size: number) {
  const unit = Math.max(2, Math.round(Math.max(width, height) / 400))
  return {
    line: [unit, unit * 2, unit * 4][size] ?? unit * 2,
    text: [unit * 8, unit * 12, unit * 18][size] ?? unit * 12,
    unit
  }
}

/** A refused save: the file changed since the card read it, or another reason, in words. */
export function saveFailure(e: unknown): { conflict: boolean; message: string } {
  const code = (e as { code?: number } | null)?.code
  if (code === 4209) return { conflict: true, message: '' }
  return { conflict: false, message: e instanceof Error ? e.message : String(e) }
}

/** What a save wrote: a text file's text, or a picture whole. */
export type SavedContents = { text: string } | { data_url: string }

/** The file as the card last saved it, for Share: what was written replaces what was read. */
export function asSaved(file: OpenedFile, saved: SavedContents | null): OpenedFile {
  if (!saved) return file
  return 'text' in saved
    ? { ...file, data_url: undefined, mediaUrl: undefined, text: saved.text }
    : { ...file, data_url: saved.data_url, mediaUrl: undefined, text: undefined }
}
