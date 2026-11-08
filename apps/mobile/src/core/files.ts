import { extensionOf } from '../../../web/src/lib/file-kinds'

/** What `hexbot.files.read` answers: text for a text file, a data URL for anything else. */
export interface OpenedFile {
  data_url?: string
  mime: string
  name: string
  size?: number
  text?: string
  /** A hash of the contents; a changed file has another. */
  version?: string
}

/** How a file's preview shows it. */
export type Preview =
  | { kind: 'table'; rows: string[][]; total: number; columns: number }
  | { kind: 'markdown'; text: string }
  | { kind: 'text'; text: string; more: boolean }
  | { kind: 'image' | 'video' | 'audio' | 'pdf' }
  | { kind: 'none' }

/** Rows a table preview shows at most; a phone gains nothing from more. */
export const TABLE_ROWS = 500
/** Columns a table preview shows at most. */
export const TABLE_COLUMNS = 40
/** Cells a table preview draws at most, so a wide file still opens quickly. */
export const TABLE_CELLS = 10_000
/** Characters a text preview shows; one Text this long still lays out quickly. */
export const TEXT_CHARS = 60_000

/**
 * The preview a file gets: a table for CSV and TSV, Markdown formatted, any
 * other text as it is, and pictures, video, audio and PDFs shown or played.
 */
export function previewOf(file: OpenedFile): Preview {
  const ext = extensionOf(file.name)
  if (file.text !== undefined) {
    if (ext === 'csv' || ext === 'tsv') {
      const rows = parseDelimited(file.text, ext === 'tsv' ? '\t' : ',')
      if (rows.length) {
        // A loop, not a spread: a tall file has more rows than a call takes arguments.
        const columns = rows.reduce((most, row) => Math.max(most, row.length), 0)
        const shown = Math.min(columns, TABLE_COLUMNS)
        return {
          kind: 'table',
          rows: rows
            .slice(0, Math.min(TABLE_ROWS, Math.floor(TABLE_CELLS / shown)))
            .map(row => row.slice(0, shown)),
          total: rows.length,
          columns
        }
      }
    }
    if (ext === 'md' || ext === 'markdown') return { kind: 'markdown', text: file.text }
    return {
      kind: 'text',
      text: file.text.slice(0, TEXT_CHARS),
      more: file.text.length > TEXT_CHARS
    }
  }
  if (!file.data_url) return { kind: 'none' }
  if (file.mime === 'application/pdf' || ext === 'pdf') return { kind: 'pdf' }
  if (file.mime.startsWith('image/') && file.mime !== 'image/svg+xml') return { kind: 'image' }
  if (file.mime.startsWith('video/')) return { kind: 'video' }
  if (file.mime.startsWith('audio/')) return { kind: 'audio' }
  return { kind: 'none' }
}

/**
 * Rows of a CSV or TSV file, as RFC 4180 reads them: a quoted field may hold
 * the delimiter, line breaks and doubled quotes. Blank lines are skipped.
 */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text

  const endRow = () => {
    row.push(field)
    if (row.length > 1 || row[0] !== '') rows.push(row)
    row = []
    field = ''
  }

  for (let i = 0; i < body.length; i++) {
    const char = body[i]!
    if (quoted) {
      if (char !== '"') field += char
      else if (body[i + 1] === '"') {
        field += '"'
        i++
      } else quoted = false
    } else if (char === '"' && field === '') quoted = true
    else if (char === delimiter) {
      row.push(field)
      field = ''
    } else if (char === '\n') endRow()
    else if (char !== '\r') field += char
  }
  if (field !== '' || row.length) endRow()
  return rows
}

/** "microduck-parts-list", "csv": the name cut before its extension, so the extension always shows. */
export function splitName(name: string): { stem: string; ext: string } {
  const ext = extensionOf(name)
  return ext ? { stem: name.slice(0, -(ext.length + 1)), ext } : { stem: name, ext: '' }
}
