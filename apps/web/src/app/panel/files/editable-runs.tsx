import { type CSSProperties, useEffect, useLayoutEffect, useRef } from 'react'

import type { RunView } from '../../../lib/office/runs'

/** How long typing pauses before a paragraph's text goes back into the file. */
const COMMIT_DELAY = 500

export interface EditableRunsProps {
  runs: RunView[]
  editable: boolean
  /** CSS px per point, for run sizes. */
  pxPerPt: number
  /** Points, for a paragraph whose runs give none. */
  baseSize?: number
  className?: string
  style?: CSSProperties
  /** "paragraph 4", for a comment on text selected here. */
  where?: string
  tag?: 'div' | 'h1' | 'h2' | 'h3' | 'li' | 'p'
  /** One string per run, or one for all when the runs were merged while typing. */
  onCommit: (texts: string[]) => void
  /** Enter: the text before the caret by run, the rest, and the run the caret was in. */
  onSplit?: (texts: string[], run: number, offset: number) => void
  /**
   * Typing began: the text on screen is an edit now, before it goes back
   * into the file, so a new version of the file waits rather than replace it.
   */
  onTyping?: () => void
  /** Typing ended with the text as it was: nothing goes back into the file. */
  onSettled?: () => void
  /** Shift+Enter adds a line break inside the paragraph, as Word allows. */
  breaks?: boolean
  /** Backspace at the very start. */
  onJoin?: () => void
  /** Puts the caret here, at this many characters in, once. */
  focusAt?: null | number
}

function spanStyle(run: RunView, pxPerPt: number): Partial<CSSStyleDeclaration> {
  const decoration = [
    run.underline || run.href ? 'underline' : '',
    run.strike ? 'line-through' : ''
  ]
    .filter(Boolean)
    .join(' ')

  return {
    color: run.color ?? (run.href ? '#0563c1' : ''),
    fontSize: run.size ? `${run.size * pxPerPt}px` : '',
    fontStyle: run.italic ? 'italic' : '',
    fontWeight: run.bold ? '700' : '',
    textDecoration: decoration
  }
}

/** Draws the runs as spans; React leaves the editable node's children alone. */
function draw(node: HTMLElement, runs: RunView[], pxPerPt: number) {
  node.replaceChildren(
    ...runs.map((run, index) => {
      const span = document.createElement('span')
      span.dataset.run = String(index)
      Object.assign(span.style, spanStyle(run, pxPerPt))
      span.textContent = run.text

      return span
    })
  )

  if (!runs.some(run => run.text)) {
    node.append(document.createElement('br'))
  }
}

/** The texts typed, one per run while every run's span is still there. */
export function readTexts(node: HTMLElement, count: number): string[] {
  const spans = Array.from(node.querySelectorAll<HTMLElement>('span[data-run]'))
  const texts = spans.map(span => span.textContent ?? '')
  const all = node.textContent ?? ''

  // Text typed outside the spans, or a span lost, merges the runs.
  return spans.length === count && texts.join('') === all ? texts : [all]
}

/** Characters before the caret, and the run it is in. */
function caret(node: HTMLElement): null | { offset: number; run: number } {
  const selection = window.getSelection()

  if (!selection?.rangeCount || !node.contains(selection.focusNode)) {
    return null
  }

  const range = document.createRange()
  range.setStart(node, 0)
  range.setEnd(selection.focusNode!, selection.focusOffset)
  const offset = range.toString().length

  const element =
    selection.focusNode instanceof Element
      ? selection.focusNode
      : selection.focusNode?.parentElement

  const run = Number(element?.closest<HTMLElement>('span[data-run]')?.dataset.run ?? 0)

  return { offset, run }
}

/** Puts the caret `offset` characters into `node`. */
function placeCaret(node: HTMLElement, offset: number) {
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
  let left = offset
  let text = walker.nextNode()
  const range = document.createRange()

  while (text) {
    const length = text.textContent?.length ?? 0

    if (left <= length) {
      range.setStart(text, left)
      range.collapse(true)

      break
    }

    left -= length
    text = walker.nextNode()
  }

  if (!text) {
    range.selectNodeContents(node)
    range.collapse(false)
  }

  node.focus({ preventScroll: false })
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}

/**
 * A paragraph of a Word or PowerPoint file, edited in place. Each run is a
 * span with its own look; typing changes their text, and the text goes back
 * into the same runs a moment after typing stops and when focus leaves.
 */
export function EditableRuns({
  baseSize,
  breaks = false,
  className,
  editable,
  focusAt = null,
  onCommit,
  onJoin,
  onSettled,
  onSplit,
  onTyping,
  pxPerPt,
  runs,
  style,
  tag = 'p',
  where
}: EditableRunsProps) {
  const node = useRef<HTMLElement>(null)
  const timer = useRef<number>(undefined)
  const shown = useRef('')
  const commitRef = useRef(onCommit)
  commitRef.current = onCommit
  const settledRef = useRef(onSettled)
  settledRef.current = onSettled
  const count = useRef(runs.length)
  count.current = runs.length
  const key = JSON.stringify([runs, pxPerPt])

  // Redrawn when the file's text changes, unless it is being typed in.
  useLayoutEffect(() => {
    const element = node.current

    if (!element || (document.activeElement === element && shown.current)) {
      return
    }

    draw(element, runs, pxPerPt)
    shown.current = key
    // `key` stands for `runs` and `pxPerPt`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  useEffect(() => {
    if (focusAt !== null && node.current) {
      placeCaret(node.current, focusAt)
    }
  }, [focusAt])

  const commit = (element: HTMLElement | null = node.current) => {
    window.clearTimeout(timer.current)
    typed.current = false

    if (!element) {
      return
    }

    const texts = readTexts(element, count.current)

    if (texts.join('') !== runs.map(run => run.text).join('') || texts.length !== runs.length) {
      commitRef.current(texts)
    } else {
      settledRef.current?.()
    }
  }

  // Leaving (another chat, Back) commits what was typed, even with no blur:
  // the paragraph's node still holds the text as it goes.
  const typed = useRef(false)
  const commitLatest = useRef(commit)
  commitLatest.current = commit

  useLayoutEffect(() => {
    const element = node.current

    return () => {
      window.clearTimeout(timer.current)

      if (typed.current) {
        commitLatest.current(element)
      }
    }
  }, [])

  const Tag = tag

  return (
    <Tag
      className={className}
      contentEditable={editable ? 'plaintext-only' : undefined}
      data-where={where}
      onBlur={() => {
        commit()

        if (node.current) {
          draw(node.current, runs, pxPerPt)
        }
      }}
      onInput={() => {
        typed.current = true
        onTyping?.()
        window.clearTimeout(timer.current)
        timer.current = window.setTimeout(commit, COMMIT_DELAY)
      }}
      onKeyDown={event => {
        // Enter that ends an IME composition (Chinese, Japanese, Korean) is not a command.
        if (event.nativeEvent.isComposing) {
          return
        }

        const element = node.current

        if (!element) {
          return
        }

        // A line break inside the paragraph: typed as a newline character the
        // text reads back (Word writes it as a break), or none where the file
        // keeps breaks between runs (PowerPoint).
        if (event.key === 'Enter' && event.shiftKey) {
          event.preventDefault()

          const selection = window.getSelection()

          if (breaks && selection?.rangeCount) {
            // A newline character in the run's own text, not a <br> the
            // browser would add: the text read back keeps it.
            const range = selection.getRangeAt(0)
            const newline = document.createTextNode('\n')

            range.deleteContents()
            range.insertNode(newline)

            // A newline ending the paragraph shows only with something after
            // it; a <br> there (not part of the text) holds the new line.
            const after = document.createRange()
            after.setStartAfter(newline)
            after.setEnd(element, element.childNodes.length)

            if (!after.toString() && element.lastChild?.nodeName !== 'BR') {
              element.append(document.createElement('br'))
            }

            range.setStartAfter(newline)
            range.collapse(true)
            selection.removeAllRanges()
            selection.addRange(range)
            typed.current = true
            onTyping?.()
            window.clearTimeout(timer.current)
            timer.current = window.setTimeout(commit, COMMIT_DELAY)
          }

          return
        }

        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault()
          window.clearTimeout(timer.current)
          // Enter over selected words replaces them, as in Word.
          const selected = window.getSelection()

          if (
            onSplit &&
            selected?.rangeCount &&
            !selected.isCollapsed &&
            element.contains(selected.anchorNode) &&
            element.contains(selected.focusNode)
          ) {
            selected.getRangeAt(0).deleteContents()
            selected.collapseToStart()
          }

          const at = caret(element)

          if (!onSplit || !at) {
            commit()
            element.blur()

            return
          }

          const texts = readTexts(element, count.current)
          let left = at.offset

          const before = texts.map(text => {
            const kept = text.slice(0, Math.max(0, left))
            left -= text.length

            return kept
          })

          // The run the caret is in, and how far into it, from the text itself.
          let run = 0
          let into = at.offset

          while (run < texts.length - 1 && into > texts[run]!.length) {
            into -= texts[run]!.length
            run += 1
          }

          // The paragraph keeps only the text before the caret: when focus
          // moves to the new one, its blur finds nothing more to write.
          if (texts.length === count.current) {
            draw(
              element,
              runs.map((run, index) => ({ ...run, text: before[index] ?? '' })),
              pxPerPt
            )
          } else {
            element.textContent = before.join('')
          }

          onSplit(texts, run, into)
        } else if (event.key === 'Backspace' && onJoin) {
          const at = caret(element)
          const selection = window.getSelection()

          if (at?.offset === 0 && selection?.isCollapsed) {
            event.preventDefault()
            commit()
            onJoin()
          }
        } else if (event.key === 'Escape') {
          element.blur()
        }
      }}
      ref={node as never}
      spellCheck={editable}
      style={{
        ...style,
        fontSize: style?.fontSize ?? (baseSize ? `${baseSize * pxPerPt}px` : undefined)
      }}
      suppressContentEditableWarning
    />
  )
}
