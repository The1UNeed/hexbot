// CSV and TSV, read and written the same way by the web and mobile apps.

/**
 * Rows of a CSV or TSV file, as RFC 4180 reads them: a quoted field may hold
 * the delimiter, line breaks and doubled quotes. Blank lines are skipped;
 * a line holding only `""` is a record with one empty field.
 */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  // The row had a quoted field, so even one empty field is a record.
  let wasQuoted = false
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text

  const endRow = () => {
    row.push(field)

    if (row.length > 1 || row[0] !== '' || wasQuoted) {
      rows.push(row)
    }

    row = []
    field = ''
    wasQuoted = false
  }

  for (let i = 0; i < body.length; i++) {
    const char = body[i]!

    if (quoted) {
      if (char !== '"') {
        field += char
      } else if (body[i + 1] === '"') {
        field += '"'
        i++
      } else {
        quoted = false
      }
    } else if (char === '"' && field === '') {
      quoted = true
      wasQuoted = true
    } else if (char === delimiter) {
      row.push(field)
      field = ''
    } else if (char === '\n') {
      endRow()
    } else if (char !== '\r') {
      field += char
    }
  }

  if (field !== '' || row.length || wasQuoted) {
    endRow()
  }

  return rows
}

/**
 * The file for `rows`: a field holding the delimiter, a quote or a line break
 * is quoted. Lines end as the file's did (`\r\n` or `\n`), and a byte-order
 * mark and a final line break stay if the file had them.
 */
export function serializeDelimited(rows: string[][], delimiter: string, like = ''): string {
  const eol = like.includes('\r\n') ? '\r\n' : '\n'
  const bom = like.charCodeAt(0) === 0xfeff ? '﻿' : ''

  const quote = (field: string) =>
    field.includes(delimiter) || /["\r\n]/.test(field) ? `"${field.replace(/"/g, '""')}"` : field

  // A record of one empty field is written `""`, or it would read as a blank line.
  const body = rows
    .map(row => (row.length === 1 && row[0] === '' ? '""' : row.map(quote).join(delimiter)))
    .join(eol)

  const trailing = like === '' || /\r?\n$/.test(like) ? eol : ''

  return bom + body + (rows.length ? trailing : '')
}
