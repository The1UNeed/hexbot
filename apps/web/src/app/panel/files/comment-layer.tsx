import { ArrowUp, MessageSquarePlus } from 'lucide-react'
import { type RefObject, useCallback, useEffect, useRef, useState } from 'react'

import { cn } from '../../../lib/cn'

/** What a comment is about, and where its popover opens inside the file's panel. */
export interface CommentTarget {
  quote?: string
  where?: string
  /** Px from the panel's left edge and top, just under the selection. */
  x: number
  y: number
}

const POPOVER_WIDTH = 288

/** "line 4" or "lines 4–9" of a text field's selection. */
export function linesOf(text: string, start: number, end: number): string {
  const first = text.slice(0, start).split('\n').length
  const last = text.slice(0, Math.max(start, end - 1)).split('\n').length

  return first === last ? `line ${first}` : `lines ${first}–${last}`
}

/** A point under `rect`, inside `box`, for the popover. */
export function pointUnder(
  rect: { bottom: number; left: number },
  box: { left: number; top: number; width: number }
) {
  return {
    x: Math.max(8, Math.min(rect.left - box.left, box.width - POPOVER_WIDTH - 8)),
    y: rect.bottom - box.top + 6
  }
}

/**
 * The selection the user made in a file's panel: text in a field, in an
 * editor, or in a preview. Its `where` comes from the nearest `data-where`
 * (a paragraph, a slide) or, in a text field, from its lines.
 */
export function useTextSelection(
  container: RefObject<HTMLElement | null>,
  enabled: boolean
): [CommentTarget | null, (target: CommentTarget | null) => void] {
  const [target, setTarget] = useState<CommentTarget | null>(null)

  useEffect(() => {
    const node = container.current

    if (!node || !enabled) {
      return
    }

    const read = (event: KeyboardEvent | MouseEvent) => {
      // The popover itself, and views that place their own comments (a
      // sheet's cells, a picture's areas), are not text selections.
      if (
        (event.target as HTMLElement | null)?.closest?.('[data-comment-layer], [data-comment-own]')
      ) {
        return
      }

      // After the browser has moved the selection.
      requestAnimationFrame(() => {
        const box = node.getBoundingClientRect()
        const field = document.activeElement

        if (
          (field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement) &&
          node.contains(field)
        ) {
          const { selectionEnd, selectionStart, value } = field

          const quote =
            selectionStart !== null && selectionEnd !== null
              ? value.slice(selectionStart, selectionEnd)
              : ''

          if (!quote.trim() || field.dataset.comment === 'off') {
            setTarget(null)

            return
          }

          const rect =
            event instanceof MouseEvent
              ? { bottom: event.clientY, left: event.clientX }
              : { bottom: field.getBoundingClientRect().top + 24, left: box.left + 16 }

          setTarget({
            quote,
            where:
              field instanceof HTMLTextAreaElement
                ? linesOf(value, selectionStart!, selectionEnd!)
                : field.closest('[data-where]')?.getAttribute('data-where') || undefined,
            ...pointUnder(rect, box)
          })

          return
        }

        const selection = window.getSelection()

        if (
          !selection ||
          selection.isCollapsed ||
          !selection.rangeCount ||
          !node.contains(selection.anchorNode)
        ) {
          setTarget(null)

          return
        }

        const quote = selection.toString()

        if (!quote.trim()) {
          setTarget(null)

          return
        }

        const anchor =
          selection.anchorNode instanceof Element
            ? selection.anchorNode
            : selection.anchorNode?.parentElement

        const rects = selection.getRangeAt(0).getClientRects()
        const last = rects[rects.length - 1] ?? selection.getRangeAt(0).getBoundingClientRect()

        setTarget({
          quote,
          where: anchor?.closest('[data-where]')?.getAttribute('data-where') || undefined,
          ...pointUnder(last, box)
        })
      })
    }

    node.addEventListener('mouseup', read)
    node.addEventListener('keyup', read)

    return () => {
      node.removeEventListener('mouseup', read)
      node.removeEventListener('keyup', read)
    }
  }, [container, enabled])

  return [target, setTarget]
}

/**
 * The Comment button under a selection; it opens into a field. A comment
 * waits above the chat's composer and goes with the next message.
 */
export function CommentLayer({
  botName,
  onAdd,
  onClose,
  open = false,
  target
}: {
  botName: string
  onAdd: (note: string) => void
  onClose: () => void
  /** Opens straight into the field, as after marking an area of a picture. */
  open?: boolean
  target: CommentTarget | null
}) {
  const [writing, setWriting] = useState(open)
  const [note, setNote] = useState('')
  const field = useRef<HTMLTextAreaElement>(null)
  const layer = useRef<HTMLDivElement>(null)

  // A new selection starts over.
  useEffect(() => {
    setWriting(open)
    setNote('')
  }, [open, target?.quote, target?.where, target?.x, target?.y])

  useEffect(() => {
    if (writing) {
      field.current?.focus({ preventScroll: true })
    }
  }, [writing])

  const add = useCallback(() => {
    if (!note.trim()) {
      return
    }

    onAdd(note.trim())
    setNote('')
    setWriting(false)
    window.getSelection()?.removeAllRanges()
  }, [note, onAdd])

  // A click elsewhere puts the button away, unless a comment is being written.
  useEffect(() => {
    if (!target) {
      return
    }

    const away = (event: PointerEvent) => {
      if (!layer.current?.contains(event.target as Node) && !note.trim()) {
        onClose()
      }
    }

    window.addEventListener('pointerdown', away, true)

    return () => window.removeEventListener('pointerdown', away, true)
  }, [note, onClose, target])

  if (!target) {
    return null
  }

  return (
    <div
      className="absolute z-30"
      data-comment-layer
      ref={layer}
      style={{ left: target.x, top: target.y, width: writing ? POPOVER_WIDTH : undefined }}
    >
      {writing ? (
        <form
          className="hex-glass hex-fade flex flex-col gap-1.5 rounded-[16px] bg-background/90 p-2 shadow-card"
          onSubmit={event => {
            event.preventDefault()
            add()
          }}
        >
          {target.quote || target.where ? (
            <p className="line-clamp-2 px-1 text-[length:var(--text-meta)] text-muted">
              {target.where ? <span className="font-medium">{target.where} </span> : null}
              {target.quote ? `“${target.quote.trim()}”` : null}
            </p>
          ) : null}
          <div className="flex items-end gap-1.5">
            <textarea
              aria-label={`Comment for ${botName}`}
              className="max-h-28 min-h-[30px] min-w-0 flex-1 resize-none bg-transparent px-1 py-1 text-[length:var(--text-secondary)] text-foreground outline-none [field-sizing:content] placeholder:text-muted"
              data-comment="off"
              onChange={event => setNote(event.target.value)}
              onKeyDown={event => {
                // Enter that ends an IME composition (Chinese, Japanese, Korean) is not a command.
                if (event.nativeEvent.isComposing) {
                  return
                }

                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  add()
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  event.stopPropagation()
                  onClose()
                }
              }}
              placeholder={`What should ${botName} change?`}
              ref={field}
              rows={1}
              value={note}
            />
            <button
              aria-label="Add to message"
              className={cn(
                'grid size-[30px] shrink-0 place-items-center rounded-full transition-colors',
                note.trim() ? 'bg-foreground text-background' : 'bg-foreground/[0.06] text-muted'
              )}
              disabled={!note.trim()}
              title="Add to message"
              type="submit"
            >
              <ArrowUp size={15} strokeWidth={2.5} />
            </button>
          </div>
          <p className="px-1 text-[11px] text-muted">Goes with your next message.</p>
        </form>
      ) : (
        <button
          className="hex-glass hex-glass-press hex-focus hex-fade flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[length:var(--text-meta)] font-medium text-foreground shadow-card"
          onClick={() => setWriting(true)}
          // Keep the selection while the button is pressed.
          onMouseDown={event => event.preventDefault()}
          type="button"
        >
          <MessageSquarePlus size={14} />
          Comment
        </button>
      )}
    </div>
  )
}
