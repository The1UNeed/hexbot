// Comments the user leaves on a file, and the words that place them, shared
// by the desktop's side panel and the phone's file card. Each comment goes
// with the next message, naming the file as a tag and what it is about, so
// the bot finds the place and edits that file.

/** One comment on a file. */
export interface FileComment {
  id: string
  /** The file's name, as its tab shows it. */
  name: string
  /** Where the daemon keeps it; absent for a file only this page holds. */
  path?: string
  /** Where in the file: "line 12", "B2:C4 on Sheet1", "slide 3", "the marked area at 40, 120". */
  where?: string
  /** The words or values the comment is about, as the user selected them. */
  quote?: string
  note: string
  /** The side tab it was left in, so a picture's marks show on that picture only. */
  tab?: string
  /** The area of a picture it marks, in the picture's pixels, drawn on the picture while it waits. */
  area?: { x: number; y: number; w: number; h: number }
}

const clip = (text: string, most: number) =>
  text.length > most ? `${text.slice(0, most - 1).trimEnd()}…` : text

/**
 * The message the composer sends: what the user typed, then each comment with
 * the file it is on, so the bot finds the place and edits that file.
 */
export function withComments(text: string, comments: FileComment[]): string {
  if (!comments.length) {
    return text
  }

  const lines = comments.map((comment, index) => {
    // A file tag: the chat shows the name, which opens the file, and the bot reads the path.
    const label = comment.name.replace(/[[\]\\]/g, '\\$&')

    const file = comment.path
      ? `[${label}](<${comment.path.replace(/[<>\\]/g, '\\$&')}>)`
      : comment.name

    const where = comment.where ? `, ${comment.where}` : ''

    const quote = comment.quote
      ? `, on "${clip(comment.quote.replace(/\s+/g, ' ').trim(), 400)}"`
      : ''

    return `${index + 1}. ${file}${where}${quote}: ${comment.note}`
  })

  const ask = text.trim() || 'Please work through my comments on these files.'

  return `${ask}\n\nMy comments:\n${lines.join('\n')}\n\nWhere a comment asks for a change, edit the file in place.`
}

/** "line 4" or "lines 4–9" of a text field's selection. */
export function linesOf(text: string, start: number, end: number): string {
  const first = text.slice(0, start).split('\n').length
  const last = text.slice(0, Math.max(start, end - 1)).split('\n').length

  return first === last ? `line ${first}` : `lines ${first}–${last}`
}

/** "A", "Z", "AA": a column's letters. */
export function columnName(index: number): string {
  let name = ''
  let n = index + 1

  while (n > 0) {
    const rest = (n - 1) % 26
    name = String.fromCharCode(65 + rest) + name
    n = Math.floor((n - 1) / 26)
  }

  return name
}

export interface Cell {
  col: number
  row: number
}

export interface Range {
  /** Where the selection started. */
  anchor: Cell
  /** Where it ends, and where the keyboard moves from. */
  focus: Cell
}

/** A range's edges, whichever way it was dragged. */
export const rangeBounds = ({ anchor, focus }: Range) => ({
  bottom: Math.max(anchor.row, focus.row),
  left: Math.min(anchor.col, focus.col),
  right: Math.max(anchor.col, focus.col),
  top: Math.min(anchor.row, focus.row)
})

/** "B2" or "B2:C4". */
export function rangeName(range: Range): string {
  const { bottom, left, right, top } = rangeBounds(range)
  const first = `${columnName(left)}${top + 1}`

  return left === right && top === bottom ? first : `${first}:${columnName(right)}${bottom + 1}`
}

/**
 * Where a comment on part of a picture is, in the picture as it is saved: a
 * crop moves its corner.
 */
export function areaWhere(
  area: { x: number; y: number; w: number; h: number },
  crop: { x: number; y: number } | null
): string {
  const round = Math.round

  return `the marked area at ${round(area.x - (crop?.x ?? 0))}, ${round(area.y - (crop?.y ?? 0))} (${round(area.w)}×${round(area.h)} px)`
}
