/**
 * The plugins table's cells and its keys. A grant is a box: filled with a
 * tick when the bots have it, a dash when only some do, empty otherwise.
 */

import { Check, Minus, TriangleAlert } from 'lucide-react'
import { memo, useState } from 'react'

import { cn } from '../../../lib/cn'

export type BoxState = 'off' | 'on' | 'some'

/** Shape says the state; the account's colour repeats which account it comes from. */
export function Box({
  changed,
  color,
  state,
  waiting
}: {
  /** Staged and not applied yet. */
  changed?: boolean
  color: string
  state: BoxState
  /** Held through a sign-in that stopped working. */
  waiting?: boolean
}) {
  const soft = state === 'some' || (waiting && state === 'on')

  return (
    <span
      aria-hidden
      className={cn(
        'relative grid size-5 shrink-0 place-items-center rounded-[6px] transition-[background-color,box-shadow,scale] duration-[var(--hex-motion-fast)] ease-[var(--hex-ease-out)]',
        state === 'off' &&
          'shadow-[inset_0_0_0_1.5px_color-mix(in_srgb,var(--hex-text)_55%,transparent)]'
      )}
      style={
        soft
          ? {
              backgroundColor: `color-mix(in srgb, ${color} 20%, transparent)`,
              boxShadow: `inset 0 0 0 1.5px ${color}`
            }
          : state === 'on'
            ? { backgroundColor: color }
            : undefined
      }
    >
      {changed ? (
        // A dot at the corner, so a staged box is never mistaken for the focused one.
        <span className="hex-tick absolute -top-[5px] -right-[5px] size-[9px] rounded-full bg-foreground ring-2 ring-background" />
      ) : null}
      {/* A mark the user just made springs in; the ones the page opened with are simply there. */}
      {waiting && state !== 'off' ? (
        <TriangleAlert size={11} strokeWidth={2.5} />
      ) : state === 'on' ? (
        <Check className={cn('text-background', changed && 'hex-tick')} size={13} strokeWidth={3.2} />
      ) : state === 'some' ? (
        <Minus className={cn(changed && 'hex-tick')} size={12} strokeWidth={3.2} />
      ) : null}
    </span>
  )
}

export interface GrantCellProps {
  /** Nothing can be given here now: a plugin still to set up, or a sign-in to renew. */
  blocked: boolean
  changed: boolean
  /** The column, which the grid's keys and the table's click handler read. */
  col: string
  color: string
  /** How many of the row's bots have it once the staged changes apply. */
  held: number
  /** "Gmail for 48 Sales bots". */
  label: string
  /** The row, which the table's click handler reads. */
  row: string
  size: number
  /** True for the one cell the Tab key reaches. */
  tab: boolean
  waiting: boolean
}

/**
 * One cell: a checkbox for one bot or a group of them. It takes no handler:
 * the table listens once for all of them and reads `data-row` and `data-col`,
 * so a change repaints only the cells it touched.
 */
export const GrantCell = memo(function GrantCell({
  blocked,
  changed,
  col,
  color,
  held,
  label,
  row,
  size,
  tab,
  waiting
}: GrantCellProps) {
  const state: BoxState = held === size ? 'on' : held ? 'some' : 'off'
  const stuck = blocked && !held

  const said = stuck
    ? waiting
      ? 'needs a new sign-in first'
      : 'not set up for this bot yet'
    : waiting
      ? 'waiting for a new sign-in'
      : state === 'some'
        ? `${held} of ${size} ${held === 1 ? 'has' : 'have'} it`
        : undefined

  return (
    <button
      aria-checked={state === 'on' ? true : state === 'some' ? 'mixed' : false}
      aria-disabled={stuck || undefined}
      aria-label={[label, said, changed ? 'not applied yet' : undefined].filter(Boolean).join(', ')}
      className={cn(
        'hex-focus grid h-9 w-full min-w-9 place-items-center rounded-[8px] transition-colors focus-visible:bg-foreground/[0.08] focus-visible:outline-foreground!',
        stuck ? 'cursor-not-allowed opacity-60' : 'hover:bg-foreground/[0.06] [&:active>span]:scale-[0.86]'
      )}
      data-cell={`${row}/${col}`}
      data-col={col}
      data-grant={stuck ? undefined : ''}
      data-row={row}
      role="checkbox"
      tabIndex={tab ? 0 : -1}
      title={said}
      type="button"
    >
      <Box changed={changed} color={color} state={state} waiting={waiting} />
    </button>
  )
})

/**
 * A grid's keys: the arrows move between cells, Home and End run along a
 * row. Cells carry `data-cell` (their own id) and `data-col` (their column).
 * Only one cell is in the tab order: the one last focused.
 */
export function useGrid(reset: string) {
  const [focus, setFocus] = useState<{ cell: string; reset: string } | null>(null)
  // A cell that left the grid cannot hold the tab stop.
  const active = focus?.reset === reset ? focus.cell : null

  return {
    props: {
      onFocus: (event: React.FocusEvent<HTMLElement>) => {
        const cell = (event.target as HTMLElement).closest<HTMLElement>('[data-cell]')?.dataset.cell

        if (cell && cell !== active) {
          setFocus({ cell, reset })
        }
      },
      onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
        const cell = (event.target as HTMLElement).closest<HTMLElement>('[data-col]')
        const row = cell?.closest('tr')

        if (!cell || !row || event.altKey || event.ctrlKey || event.metaKey) {
          return
        }

        const along = [...row.querySelectorAll<HTMLElement>('[data-col]')]

        const down = [
          ...event.currentTarget.querySelectorAll<HTMLElement>(
            `[data-col="${CSS.escape(cell.dataset.col!)}"]`
          )
        ]

        const next = {
          ArrowDown: down[down.indexOf(cell) + 1],
          ArrowLeft: along[along.indexOf(cell) - 1],
          ArrowRight: along[along.indexOf(cell) + 1],
          ArrowUp: down[down.indexOf(cell) - 1],
          End: along[along.length - 1],
          Home: along[0]
        }[event.key]

        if (next) {
          event.preventDefault()
          next.focus()
          // The container's scroll padding keeps it clear of the pinned names and headings.
          next.scrollIntoView({ block: 'nearest', inline: 'nearest' })
        }
      }
    },
    /** The tab stop: the cell last focused, or `first` before any was. */
    tab: (cell: string, first = false) => (active ? active === cell : first)
  }
}
