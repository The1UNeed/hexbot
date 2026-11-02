/**
 * The editor's formatting buttons on Markdown text: each takes the text and
 * the selection and returns both changed, so the caret stays where it was.
 * The app formats in place; a phone edits the source with the same tools.
 */

export type Format = 'bold' | 'bullet' | 'h1' | 'h2' | 'h3' | 'italic' | 'ordered'

export interface Selection {
  end: number
  start: number
}

export interface Edit {
  selection: Selection
  text: string
}

/** Wraps the selection in `mark`, or puts the caret between two of them. */
function wrap(text: string, { end, start }: Selection, mark: string): Edit {
  const inner = text.slice(start, end)

  return {
    selection: { end: end + mark.length, start: start + mark.length },
    text: `${text.slice(0, start)}${mark}${inner}${mark}${text.slice(end)}`
  }
}

/** Rewrites each line the selection touches, keeping the selection on them. */
function lines(
  text: string,
  { end, start }: Selection,
  rewrite: (line: string, index: number, all: string[]) => string
): Edit {
  const from = text.lastIndexOf('\n', start - 1) + 1
  const next = text.indexOf('\n', end)
  const to = next < 0 ? text.length : next
  const block = text.slice(from, to).split('\n')
  const changed = block.map((line, index) => rewrite(line, index, block)).join('\n')

  return {
    selection: { end: from + changed.length, start: from },
    text: `${text.slice(0, from)}${changed}${text.slice(to)}`
  }
}

const HEADING = /^#{1,6}\s+/
const BULLET = /^\s*[-*+]\s+/
const ORDERED = /^\s*\d+[.)]\s+/

export function applyFormat(text: string, selection: Selection, format: Format): Edit {
  switch (format) {
    case 'bold':
      return wrap(text, selection, '**')
    case 'italic':
      return wrap(text, selection, '*')
    case 'bullet':
      return lines(text, selection, (line, _index, all) =>
        all.every(item => BULLET.test(item) || !item.trim())
          ? line.replace(BULLET, '')
          : line.trim()
            ? `- ${line.replace(ORDERED, '')}`
            : line
      )
    case 'ordered': {
      let n = 0
      return lines(text, selection, (line, _index, all) =>
        all.every(item => ORDERED.test(item) || !item.trim())
          ? line.replace(ORDERED, '')
          : line.trim()
            ? `${++n}. ${line.replace(BULLET, '').replace(ORDERED, '')}`
            : line
      )
    }
    default: {
      const prefix = `${'#'.repeat(Number(format.slice(1)))} `
      // The same heading again turns it back into a paragraph.
      return lines(text, selection, line =>
        line.startsWith(prefix)
          ? line.slice(prefix.length)
          : `${prefix}${line.replace(HEADING, '')}`
      )
    }
  }
}
