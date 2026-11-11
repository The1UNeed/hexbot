import {
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
  type RefObject,
  type UIEventHandler,
  useCallback,
  useState
} from 'react'

import { cn } from '../../lib/cn'
import { useHeight } from '../../lib/use-height'

/** How far a bare edge fades while there is more to scroll to, in px. */
const BARE_FADE = 48

/**
 * The lengths `.hex-fade-mask` reads, in px: where the top fade starts being
 * see-through (`topFrom`) and where each edge's content is whole again.
 */
export function fadeLengths({
  bottom,
  top,
  topFrom = 0
}: {
  bottom: number
  top: number
  topFrom?: number
}): CSSProperties {
  return {
    '--hex-fade-bottom': `${bottom}px`,
    '--hex-fade-top': `${top}px`,
    '--hex-fade-top-from': `${topFrom}px`
  } as CSSProperties
}

export interface ScrollAreaProps {
  children: ReactNode
  /** The outer box: give it its size here (`flex-1`, `h-full`). */
  className?: string
  /**
   * Glass controls that float over the top of the content: a header. The
   * content runs underneath, padded so its first line starts clear of them.
   */
  top?: ReactNode
  /** Glass controls that float over the bottom of the content: a composer, a footer. */
  bottom?: ReactNode
  /** Space between floating controls and the first or last line, in px. */
  gap?: number
  /** The top controls are the window's drag handle, as every header is. */
  drag?: boolean
  /**
   * The top controls are bare text, such as a window's title, not glass: the
   * content is gone before it reaches them, so the text stays readable.
   */
  hold?: boolean
  onScroll?: UIEventHandler<HTMLDivElement>
  /** The scrolling element itself: padding, `overflow-auto` for both axes. */
  viewportClassName?: string
  /** Attributes for the scrolling element, such as `role="log"` and its label. */
  viewportProps?: Omit<HTMLAttributes<HTMLDivElement>, 'className' | 'onScroll' | 'style'>
  viewportRef?: RefObject<HTMLDivElement | null>
}

/**
 * The one scrolling surface. Nothing scrolls into a line: content runs the
 * full height of its card, controls float over it as glass (`top`,
 * `bottom`), and where content meets an edge it fades out (`.hex-fade-mask`),
 * so whatever is really behind it shows through. Under floating controls the
 * fade spans them; on a bare edge it shows only while there is more to
 * scroll to. The viewport pads and scroll-pads itself by the controls'
 * measured height, so the first and last lines, keyboard focus and search
 * jumps all land clear of the glass.
 */
export function ScrollArea({
  bottom,
  children,
  className,
  drag = true,
  gap = 8,
  hold = false,
  onScroll,
  top,
  viewportClassName,
  viewportProps,
  viewportRef
}: ScrollAreaProps) {
  // How much content lies past each edge, up to a full fade: a scroller that
  // overflows by a few pixels fades only that much, not a full fade's worth.
  const [edges, setEdges] = useState({ bottom: 0, most: BARE_FADE, top: 0 })
  const [topBox, topHeight] = useHeight<HTMLDivElement>()
  const [bottomBox, bottomHeight] = useHeight<HTMLDivElement>()

  const measure = useCallback((node: HTMLElement) => {
    // A small box fades at most a fifth of its height, so it is not mostly fade.
    const most = Math.round(Math.min(BARE_FADE, node.clientHeight / 5))
    const above = Math.round(Math.min(most, Math.max(0, node.scrollTop)))

    const below = Math.round(
      Math.min(most, Math.max(0, node.scrollHeight - node.scrollTop - node.clientHeight))
    )

    setEdges(current =>
      current.top === above && current.bottom === below && current.most === most
        ? current
        : { bottom: below, most, top: above }
    )
  }, [])

  // The viewport and everything in it resize: a page switch, a field that
  // grows, a message that arrives.
  const viewport = useCallback(
    (node: HTMLDivElement | null) => {
      if (viewportRef) {
        viewportRef.current = node
      }

      if (!node || typeof ResizeObserver === 'undefined') {
        return () => undefined
      }

      const resize = new ResizeObserver(() => measure(node))

      const watch = () => {
        resize.disconnect()
        resize.observe(node)

        for (const child of node.children) {
          resize.observe(child)
        }
      }

      watch()
      const mutation = new MutationObserver(watch)
      mutation.observe(node, { childList: true })

      return () => {
        resize.disconnect()
        mutation.disconnect()

        if (viewportRef) {
          viewportRef.current = null
        }
      }
    },
    [measure, viewportRef]
  )

  const padTop = top ? topHeight + gap : undefined
  const padBottom = bottom ? bottomHeight + gap : undefined

  // Under floating chrome the content fades out across the chrome and is
  // whole where the chrome ends; behind bare text (`hold`) it is gone before
  // the text and fades back a little below it. A bare edge fades only while
  // there is more to scroll to.
  const topFrom = top && hold ? Math.max(0, topHeight - 8) : 0
  const fadeTop = top ? topHeight + (hold && edges.top ? 24 : gap) : edges.top
  const fadeBottom = bottom ? bottomHeight + gap : edges.bottom
  const fade = fadeLengths({ bottom: fadeBottom, top: fadeTop, topFrom })

  return (
    <div className={cn('relative flex min-h-0 min-w-0 flex-col', className)}>
      {/* The chrome comes first, so it reads and tabs before the content it
          floats over; it is absolute and above it, so nothing moves. */}
      {top ? (
        <div
          className={cn('hex-chrome absolute inset-x-0 top-0 z-20', drag && 'hex-drag')}
          ref={topBox}
        >
          {top}
        </div>
      ) : null}
      <div
        {...viewportProps}
        className={cn('hex-fade-mask min-h-0 flex-1 overflow-y-auto', viewportClassName)}
        onScroll={event => {
          measure(event.currentTarget)
          onScroll?.(event)
        }}
        ref={viewport}
        style={{
          ...fade,
          // A pixel in from each edge, so content drawn on its own layer (a
          // bot's moving face) cannot leak past the card's rounded clip. Behind
          // bare text the content is already invisible; clipped there too, so
          // what cannot be seen cannot be clicked.
          clipPath: `inset(${Math.max(1, topFrom)}px 0 1px 0)`,
          paddingBottom: padBottom,
          paddingTop: padTop,
          // Focus, the caret and search jumps land where the content is whole.
          scrollPaddingBottom: bottom ? padBottom : edges.most,
          scrollPaddingTop: top ? fadeTop : edges.most
        }}
      >
        {children}
      </div>
      {bottom ? (
        <div className="hex-chrome absolute inset-x-0 bottom-0 z-20" ref={bottomBox}>
          {bottom}
        </div>
      ) : null}
    </div>
  )
}
