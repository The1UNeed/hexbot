import { MessageSquarePlus, Minus, Plus } from 'lucide-react'
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'

import { cn } from '../../../lib/cn'
import { parseDelimited, serializeDelimited } from '../../../lib/delimited'

import type { CommentTarget } from './comment-layer'
import { pointUnder } from './comment-layer'

/** Rows drawn at first; more come on request, so a long file opens quickly. */
const ROW_STEP = 300
/** Columns drawn at most. */
export const MAX_COLUMNS = 60

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

const bounds = ({ anchor, focus }: Range) => ({
  bottom: Math.max(anchor.row, focus.row),
  left: Math.min(anchor.col, focus.col),
  right: Math.max(anchor.col, focus.col),
  top: Math.min(anchor.row, focus.row)
})

/** "B2" or "B2:C4". */
export function rangeName(range: Range): string {
  const { bottom, left, right, top } = bounds(range)
  const first = `${columnName(left)}${top + 1}`

  return left === right && top === bottom ? first : `${first}:${columnName(right)}${bottom + 1}`
}

export interface SheetGridProps {
  /** The values shown, row by row. */
  rows: string[][]
  /** Columns the sheet has, at least as many as its widest row. */
  columns: number
  editable: boolean
  /** The text a cell edits as, such as its formula; its value otherwise. */
  sourceOf?: (cell: Cell) => string
  /** Several cells change at once: an edit, a paste or a clear. */
  onChange: (changes: { cell: Cell; value: string }[]) => void
  /**
   * A cell holds typed text not committed yet: the sheet has an edit, so a
   * new version of the file waits and the edit saves against the one it began on.
   */
  onDraft?: () => void
  onInsertRow?: (at: number) => void
  onDeleteRows?: (from: number, to: number) => void
  onInsertColumn?: (at: number) => void
  onDeleteColumns?: (from: number, to: number) => void
  /** The first row names the columns, as a CSV file's header does. */
  headerRow?: boolean
  /** A comment on the selected cells; absent where the chat takes no messages. */
  /** `open` goes straight to the field, as the bar's button does; a drag offers the button. */
  onComment?: (target: CommentTarget, open: boolean) => void
  /** Added to "B2:C4" in a comment, such as "on Sheet1". */
  place?: string
}

/**
 * A sheet's cells, as a spreadsheet shows them: column letters and row
 * numbers stay in view, a click selects and a drag or Shift extends, the
 * arrows move, typing or Enter edits, Delete clears, and copy and paste use
 * tab-separated text. The bar above edits the selected cell, formula and all.
 */
export function SheetGrid({
  columns,
  editable,
  headerRow = false,
  onChange,
  onComment,
  onDeleteColumns,
  onDeleteRows,
  onDraft,
  onInsertColumn,
  onInsertRow,
  place,
  rows,
  sourceOf
}: SheetGridProps) {
  const [range, setRange] = useState<Range>({
    anchor: { col: 0, row: 0 },
    focus: { col: 0, row: 0 }
  })

  // `inBar`: typed in the bar above the grid, which keeps focus while it is.
  const [editing, setEditing] = useState<null | { cell: Cell; inBar?: boolean; value: string }>(
    null
  )

  const [shownRows, setShownRows] = useState(ROW_STEP)
  const dragging = useRef(false)
  const grid = useRef<HTMLDivElement>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const shownColumns = Math.min(Math.max(columns, 1), MAX_COLUMNS)
  const rowCount = Math.max(rows.length, 1)
  const drawn = Math.min(rowCount, shownRows)

  const valueAt = useCallback((cell: Cell) => rows[cell.row]?.[cell.col] ?? '', [rows])

  const source = useCallback(
    (cell: Cell) => (sourceOf ? sourceOf(cell) : valueAt(cell)),
    [sourceOf, valueAt]
  )

  const { bottom, left, right, top } = bounds(range)
  const focus = range.focus

  const clamp = (cell: Cell): Cell => ({
    col: Math.max(0, Math.min(cell.col, shownColumns - 1)),
    row: Math.max(0, Math.min(cell.row, rowCount - 1))
  })

  const select = (cell: Cell, extend = false) => {
    const next = clamp(cell)
    setRange(current =>
      extend ? { anchor: current.anchor, focus: next } : { anchor: next, focus: next }
    )
  }

  // The focused cell stays in view as the keyboard moves it.
  useEffect(() => {
    const node = grid.current?.querySelector<HTMLElement>(`[data-cell="${focus.row}:${focus.col}"]`)
    node?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [focus.col, focus.row])

  // Escape drops the edit; the blur that moving focus causes must not save it.
  const cancelled = useRef(false)

  // Leaving (another chat, Back) keeps a cell being typed in, as Enter would.
  const leaving = useRef(() => {})
  leaving.current = () => {
    if (editing && !cancelled.current && editing.value !== source(editing.cell)) {
      onChange([{ cell: editing.cell, value: editing.value }])
    }
  }

  useLayoutEffect(() => () => leaving.current(), [])

  const cancel = () => {
    cancelled.current = true
    setEditing(null)
    grid.current?.focus({ preventScroll: true })
  }

  /** A cell's text changed while editing: the sheet holds an edit not saved yet. */
  const draft = (cell: Cell, value: string, inBar = false) => {
    setEditing({ cell, inBar, value })
    onDraft?.()
  }

  const commit = (move?: Cell) => {
    if (cancelled.current) {
      cancelled.current = false
      setEditing(null)

      return
    }

    if (editing && editing.value !== source(editing.cell)) {
      onChange([{ cell: editing.cell, value: editing.value }])
    }

    setEditing(null)

    if (move) {
      select(move)
    }

    grid.current?.focus({ preventScroll: true })
  }

  const startEdit = (initial?: string, cell: Cell = focus) => {
    if (!editable) {
      return
    }

    cancelled.current = false
    setEditing({ cell, value: initial ?? source(cell) })

    // Typing over a cell is an edit already.
    if (initial !== undefined && initial !== source(cell)) {
      onDraft?.()
    }
  }

  // Tab-separated, quoted where a cell holds a tab, a line break or a quote,
  // so a copy pastes back into the same cells.
  const selectedText = () => {
    const rows: string[][] = []

    for (let row = top; row <= bottom; row++) {
      const cells: string[] = []

      for (let col = left; col <= right; col++) {
        cells.push(valueAt({ col, row }))
      }

      rows.push(cells)
    }

    return serializeDelimited(rows, '\t').replace(/\n$/, '')
  }

  const comment = (open = true) => {
    if (!onComment || !wrap.current) {
      return
    }

    const box = wrap.current.getBoundingClientRect()

    const corner = grid.current
      ?.querySelector<HTMLElement>(`[data-cell="${bottom}:${left}"]`)
      ?.getBoundingClientRect()

    const where = `${rangeName(range)}${place ? ` ${place}` : ''}`
    const quote = selectedText()

    onComment(
      {
        quote: quote.length > 600 ? `${quote.slice(0, 599)}…` : quote,
        where,
        ...pointUnder(corner ?? { bottom: box.top + 80, left: box.left + 16 }, box)
      },
      open
    )
  }

  const keys = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (editing) {
      return
    }

    const mod = event.metaKey || event.ctrlKey

    const step: Record<string, Cell> = {
      ArrowDown: { col: 0, row: 1 },
      ArrowLeft: { col: -1, row: 0 },
      ArrowRight: { col: 1, row: 0 },
      ArrowUp: { col: 0, row: -1 }
    }

    if (step[event.key]) {
      event.preventDefault()
      const by = step[event.key]!
      select({ col: focus.col + by.col, row: focus.row + by.row }, event.shiftKey)
    } else if (event.key === 'Tab') {
      event.preventDefault()
      select({ col: focus.col + (event.shiftKey ? -1 : 1), row: focus.row })
    } else if (event.key === 'Enter' || event.key === 'F2') {
      event.preventDefault()
      startEdit()
    } else if ((event.key === 'Delete' || event.key === 'Backspace') && editable) {
      event.preventDefault()
      const changes: { cell: Cell; value: string }[] = []

      for (let row = top; row <= bottom; row++) {
        for (let col = left; col <= right; col++) {
          if (valueAt({ col, row }) !== '' || source({ col, row }) !== '') {
            changes.push({ cell: { col, row }, value: '' })
          }
        }
      }

      if (changes.length) {
        onChange(changes)
      }
    } else if (mod && event.key.toLowerCase() === 'a') {
      event.preventDefault()
      setRange({ anchor: { col: 0, row: 0 }, focus: { col: shownColumns - 1, row: rowCount - 1 } })
    } else if (event.key.length === 1 && !mod && !event.altKey && editable) {
      event.preventDefault()
      startEdit(event.key)
    }
  }

  // Copy and paste as tab-separated text, the way spreadsheets trade cells.
  useEffect(() => {
    const node = grid.current

    if (!node) {
      return
    }

    const copy = (event: ClipboardEvent) => {
      if (editing) {
        return
      }

      event.preventDefault()
      event.clipboardData?.setData('text/plain', selectedText())
    }

    const paste = (event: ClipboardEvent) => {
      if (editing || !editable) {
        return
      }

      const text = event.clipboardData?.getData('text/plain')

      if (!text) {
        return
      }

      event.preventDefault()
      const changes: { cell: Cell; value: string }[] = []

      // A paste may widen the sheet, up to the columns it can show.
      // Empty rows stay rows; only the line break after the last one goes.
      parseDelimited(text.replace(/\r?\n$/, ''), '\t', true).forEach((line, r) =>
        line.forEach((value, c) => {
          const cell = { col: left + c, row: top + r }

          if (cell.col < MAX_COLUMNS) {
            changes.push({ cell, value })
          }
        })
      )

      onChange(changes)
    }

    node.addEventListener('copy', copy)
    node.addEventListener('paste', paste)

    return () => {
      node.removeEventListener('copy', copy)
      node.removeEventListener('paste', paste)
    }
  })

  // A drag across cells offers a comment on them, as selecting text does.
  const dragged = useRef(comment)

  dragged.current = () => {
    if (top !== bottom || left !== right) {
      comment(false)
    }
  }

  useEffect(() => {
    const up = () => {
      if (dragging.current) {
        dragging.current = false
        dragged.current()
      }
    }

    window.addEventListener('pointerup', up)

    return () => window.removeEventListener('pointerup', up)
  }, [])

  const header = useMemo(
    () => Array.from({ length: shownColumns }, (_, index) => columnName(index)),
    [shownColumns]
  )

  const barValue =
    editing && editing.cell.row === focus.row && editing.cell.col === focus.col
      ? editing.value
      : source(focus)

  const small =
    'hex-focus grid size-7 place-items-center rounded-[8px] text-muted hover:bg-foreground/[0.06] hover:text-foreground disabled:pointer-events-none disabled:opacity-40'

  return (
    <div className="relative flex h-full min-h-0 flex-col" data-comment-own ref={wrap}>
      <div className="flex items-center gap-1.5 px-3 pb-2">
        <span className="min-w-12 rounded-[8px] bg-foreground/[0.05] px-2 py-1 text-center font-mono text-[12px] text-muted tabular-nums">
          {rangeName(range)}
        </span>
        <input
          aria-label="Cell contents"
          className="min-w-0 flex-1 rounded-[8px] bg-foreground/[0.04] px-2 py-1 font-mono text-[12px] text-foreground outline-none focus:bg-foreground/[0.07] disabled:opacity-60"
          data-comment="off"
          disabled={!editable}
          onBlur={() => editing && commit()}
          onChange={event => {
            cancelled.current = false
            draft(focus, event.target.value, true)
          }}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              event.preventDefault()
              commit({ col: focus.col, row: focus.row + 1 })
            } else if (event.key === 'Escape') {
              cancel()
            }
          }}
          value={barValue}
        />
        {onInsertRow ? (
          <span className="flex items-center">
            <button
              aria-label="Insert row below"
              className={small}
              disabled={!editable}
              onClick={() => onInsertRow(bottom + 1)}
              title="Insert row below"
              type="button"
            >
              <Plus size={14} />
            </button>
            <button
              aria-label={top === bottom ? 'Delete row' : 'Delete rows'}
              className={small}
              disabled={!editable || !rows.length}
              onClick={() => {
                onDeleteRows?.(top, bottom)
                select({ col: focus.col, row: top })
              }}
              title={top === bottom ? 'Delete row' : 'Delete rows'}
              type="button"
            >
              <Minus size={14} />
            </button>
          </span>
        ) : null}
        {onComment ? (
          <button
            aria-label={`Comment on ${rangeName(range)}`}
            className={small}
            onClick={() => comment()}
            title="Comment on the selected cells"
            type="button"
          >
            <MessageSquarePlus size={14} />
          </button>
        ) : null}
      </div>
      <div
        aria-colcount={shownColumns}
        aria-label="Cells"
        aria-multiselectable
        aria-rowcount={rowCount}
        className="hex-focus min-h-0 flex-1 overflow-auto outline-none"
        onKeyDown={keys}
        ref={grid}
        role="grid"
        tabIndex={0}
      >
        <table className="border-separate border-spacing-0 text-[12.5px] select-none">
          <thead>
            <tr>
              <th className="sticky top-0 left-0 z-20 h-7 min-w-10 border-r border-b border-foreground/[0.08] bg-background" />
              {header.map((name, col) => (
                <th
                  className={cn(
                    'group sticky top-0 z-10 h-7 border-r border-b border-foreground/[0.08] bg-background px-2 text-center font-medium text-muted',
                    col >= left && col <= right && 'font-semibold text-accent'
                  )}
                  key={name}
                  onClick={event =>
                    setRange(current => ({
                      anchor: event.shiftKey ? current.anchor : { col, row: 0 },
                      focus: { col, row: rowCount - 1 }
                    }))
                  }
                  scope="col"
                >
                  <span className="flex items-center justify-center gap-0.5">
                    {name}
                    {onInsertColumn && editable ? (
                      <span className="hidden group-hover:flex">
                        <button
                          aria-label={`Insert column after ${name}`}
                          className="grid size-4 place-items-center rounded text-muted hover:text-foreground"
                          onClick={event => {
                            event.stopPropagation()
                            onInsertColumn(col + 1)
                          }}
                          title="Insert column after"
                          type="button"
                        >
                          <Plus size={11} />
                        </button>
                        <button
                          aria-label={`Delete column ${name}`}
                          className="grid size-4 place-items-center rounded text-muted hover:text-foreground"
                          onClick={event => {
                            event.stopPropagation()
                            onDeleteColumns?.(col, col)
                          }}
                          title="Delete column"
                          type="button"
                        >
                          <Minus size={11} />
                        </button>
                      </span>
                    ) : null}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: drawn }, (_, row) => (
              <tr key={row}>
                <th
                  className={cn(
                    'sticky left-0 z-10 h-7 border-r border-b border-foreground/[0.08] bg-background px-2 text-right font-normal text-muted tabular-nums',
                    row >= top && row <= bottom && 'font-semibold text-accent'
                  )}
                  onClick={event =>
                    setRange(current => ({
                      anchor: event.shiftKey ? current.anchor : { col: 0, row },
                      focus: { col: shownColumns - 1, row }
                    }))
                  }
                  scope="row"
                >
                  {row + 1}
                </th>
                {header.map((_, col) => {
                  const inside = row >= top && row <= bottom && col >= left && col <= right
                  const focused = row === focus.row && col === focus.col

                  const isEditing =
                    editing?.cell.row === row && editing.cell.col === col && !editing.inBar

                  const value = valueAt({ col, row })
                  const numeric = value !== '' && !Number.isNaN(Number(value))

                  return (
                    <td
                      aria-selected={inside}
                      className={cn(
                        'relative h-7 max-w-[280px] min-w-[72px] border-r border-b border-foreground/[0.06] px-2 whitespace-nowrap',
                        headerRow && row === 0 && 'bg-foreground/[0.03] font-semibold',
                        numeric && 'text-right tabular-nums',
                        inside && !focused && 'bg-accent/[0.08]',
                        focused && 'outline-2 -outline-offset-2 outline-accent'
                      )}
                      data-cell={`${row}:${col}`}
                      key={col}
                      onDoubleClick={() => {
                        select({ col, row })
                        startEdit(source({ col, row }), { col, row })
                      }}
                      onPointerDown={event => {
                        if (event.button !== 0 || isEditing) {
                          return
                        }

                        if (editing) {
                          commit()
                        }

                        dragging.current = true
                        select({ col, row }, event.shiftKey)
                        grid.current?.focus({ preventScroll: true })
                      }}
                      onPointerEnter={() => {
                        if (dragging.current) {
                          select({ col, row }, true)
                        }
                      }}
                      role="gridcell"
                    >
                      {isEditing ? (
                        <input
                          aria-label={`Edit ${columnName(col)}${row + 1}`}
                          autoFocus
                          className="absolute inset-0 w-full min-w-[120px] bg-background px-2 text-foreground outline-2 -outline-offset-2 outline-accent"
                          data-comment="off"
                          onBlur={() => commit()}
                          onChange={event => draft({ col, row }, event.target.value)}
                          onKeyDown={event => {
                            if (event.key === 'Enter') {
                              event.preventDefault()
                              commit({ col, row: row + 1 })
                            } else if (event.key === 'Tab') {
                              event.preventDefault()
                              commit({ col: col + (event.shiftKey ? -1 : 1), row })
                            } else if (event.key === 'Escape') {
                              event.preventDefault()
                              cancel()
                            }
                          }}
                          value={editing.value}
                        />
                      ) : (
                        <span className="block truncate">{value}</span>
                      )}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {drawn < rowCount || columns > MAX_COLUMNS ? (
          <div className="flex items-center gap-2 px-3 py-3 text-[length:var(--text-meta)] text-muted">
            <span>
              Showing {drawn.toLocaleString()} of {rowCount.toLocaleString()} rows
              {columns > MAX_COLUMNS ? ` and ${MAX_COLUMNS} of ${columns} columns` : ''}.
            </span>
            {drawn < rowCount ? (
              <button
                className="hex-focus rounded-full bg-foreground/[0.06] px-2.5 py-1 font-medium text-foreground hover:bg-foreground/[0.1]"
                onClick={() => setShownRows(count => count + ROW_STEP * 3)}
                type="button"
              >
                Show more
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}
