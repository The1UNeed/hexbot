'use dom'

// The picture being marked up on the phone's file card, drawn by the
// desktop's own renderer so what shows is what is saved. It runs in a web
// view (an Expo DOM component) and keeps no marks of its own: the card holds
// them, with undo, and this draws them and reports each finished gesture.

import type { DOMProps } from 'expo/dom'
import { type PointerEvent, useEffect, useRef, useState } from 'react'

import {
  type Area,
  areaOf,
  boundsOf,
  isShape,
  isStroke,
  type Mark,
  markAt,
  type Markup,
  moved,
  render,
  type Tool
} from '../../web/src/lib/markup'

export interface MarkupCanvasProps {
  /** Changes when another picture, or another version of it, is to be drawn. */
  pictureKey: string
  /** The picture as a data URL, asked for once per key: a prop would go over with every change. */
  getPicture: () => Promise<string>
  markup: Markup
  tool: Tool
  color: string
  /** Line width, in the picture's pixels. */
  line: number
  /** Text size, in the picture's pixels; a step's circle is most of it. */
  text: number
  /** The number the next step takes. */
  next: number
  /** The mark Move picked, outlined. */
  selected: string | null
  /** A crop or comment area waiting to be confirmed, outlined. */
  pending: Area | null
  /** Comments waiting on this picture, outlined where they point. */
  comments: Area[]
  background: string
  accent: string
  /** Asks for the picture as marked up, by a new number each time. */
  exportId: number
  exportMime: string
  onReady: (width: number, height: number) => Promise<void> | void
  onMark: (mark: Mark) => Promise<void> | void
  onMove: (id: string, dx: number, dy: number) => Promise<void> | void
  onSelect: (id: string | null) => Promise<void> | void
  /** A crop or comment area dragged out. */
  onArea: (area: Area) => Promise<void> | void
  /** Where text goes. */
  onTap: (x: number, y: number) => Promise<void> | void
  onExported: (id: number, dataUrl: string) => Promise<void> | void
  onFailed: () => Promise<void> | void
  dom?: DOMProps
}

let made = 0

/** On the phone the page is this canvas alone, in its own web view. */
const inWebView = () =>
  typeof (window as { ReactNativeWebView?: unknown }).ReactNativeWebView !== 'undefined'

export default function MarkupCanvas(props: MarkupCanvasProps) {
  const {
    accent,
    background,
    color,
    comments,
    exportId,
    exportMime,
    getPicture,
    line,
    markup,
    next,
    pending,
    pictureKey,
    selected,
    text,
    tool
  } = props
  const latest = useRef(props)
  latest.current = props
  const canvas = useRef<HTMLCanvasElement>(null)
  const [image, setImage] = useState<HTMLImageElement | null>(null)
  // A gesture under way: the mark it draws, the mark it moves, or the area it spans.
  const pointer = useRef<null | {
    x: number
    y: number
    mark?: Mark
    moving?: Mark
    area?: Area
    dx?: number
    dy?: number
  }>(null)
  const [, redraw] = useState(0)
  const showCrop = tool === 'crop'

  useEffect(() => {
    if (inWebView()) Object.assign(document.body.style, { margin: '0', overflow: 'hidden' })
  }, [])

  useEffect(() => {
    let live = true
    setImage(null)
    void Promise.resolve(getPicture()).then(
      src => {
        const next = new Image()
        next.onload = () => {
          if (!live) return
          setImage(next)
          void latest.current.onReady(next.naturalWidth, next.naturalHeight)
        }
        next.onerror = () => live && void latest.current.onFailed()
        next.src = src
      },
      () => live && void latest.current.onFailed()
    )
    return () => {
      live = false
    }
    // The key says when the picture changed; the function is new every render.
  }, [pictureKey])

  // The marks as shown: a move under way shows where it is going.
  const start = pointer.current
  const shown: Markup =
    start?.moving && (start.dx || start.dy)
      ? {
          ...markup,
          marks: markup.marks.map(mark =>
            mark.id === start.moving!.id ? moved(start.moving!, start.dx!, start.dy!) : mark
          )
        }
      : markup

  useEffect(() => {
    const node = canvas.current
    if (!node || !image) return
    render(node, image, shown, pointer.current?.mark, showCrop)
    const ctx = node.getContext('2d')
    if (!ctx) return
    const crop = showCrop || !markup.crop ? { x: 0, y: 0 } : markup.crop
    const rect = node.getBoundingClientRect()
    const scale = rect.width ? node.width / rect.width : 1
    const outline = (area: Area, tone: string, dashed: boolean) => {
      ctx.save()
      ctx.setTransform(1, 0, 0, 1, -crop.x, -crop.y)
      ctx.strokeStyle = tone
      ctx.lineWidth = 2 * scale
      if (dashed) ctx.setLineDash([6 * scale, 4 * scale])
      ctx.strokeRect(area.x, area.y, area.w, area.h)
      ctx.restore()
    }
    for (const area of comments) outline(area, accent, false)
    if (showCrop && markup.crop) outline(markup.crop, '#ffffff', true)
    const box = pointer.current?.area ?? pending
    if (box) outline(box, tool === 'crop' ? '#ffffff' : accent, true)
    const picked = shown.marks.find(mark => mark.id === selected)
    if (picked) outline(boundsOf(picked, ctx), accent, true)
  })

  useEffect(() => {
    if (!exportId || !image) return
    const node = document.createElement('canvas')
    render(node, image, markup)
    void latest.current.onExported(exportId, node.toDataURL(exportMime, 0.92))
    // Only a new number asks; the marks are read as they are then.
  }, [exportId, image])

  /** The picture's pixel under a touch. */
  const at = (event: PointerEvent<HTMLCanvasElement>) => {
    const node = event.currentTarget
    const rect = node.getBoundingClientRect()
    const crop = showCrop || !markup.crop ? { x: 0, y: 0 } : markup.crop
    return {
      x: ((event.clientX - rect.left) * node.width) / rect.width + crop.x,
      y: ((event.clientY - rect.top) * node.height) / rect.height + crop.y
    }
  }

  const slack = () => {
    const node = canvas.current
    const rect = node?.getBoundingClientRect()
    // A fingertip's width, in the picture's pixels.
    return node && rect?.width ? (16 * node.width) / rect.width : 16
  }

  const down = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!image || pointer.current) return
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
    const point = at(event)
    const id = `phone-mark-${Date.now().toString(36)}-${++made}`
    switch (tool) {
      case 'select': {
        const hit = markAt(markup.marks, point.x, point.y, slack())
        void latest.current.onSelect(hit?.id ?? null)
        pointer.current = { ...point, moving: hit ?? undefined }
        return
      }
      case 'text':
        void latest.current.onTap(point.x, point.y)
        return
      case 'step':
        void latest.current.onMark({
          color,
          id,
          kind: 'step',
          n: next,
          size: text * 0.7,
          x: point.x,
          y: point.y
        })
        return
      case 'crop':
      case 'comment':
        pointer.current = { ...point, area: areaOf(point.x, point.y, point.x, point.y) }
        break
      case 'pen':
      case 'highlighter':
        pointer.current = {
          ...point,
          mark: { color, id, kind: tool, points: [point.x, point.y], width: line }
        }
        break
      default:
        pointer.current = {
          ...point,
          mark: {
            color,
            id,
            kind: tool,
            width: line,
            x1: point.x,
            x2: point.x,
            y1: point.y,
            y2: point.y
          }
        }
    }
    redraw(n => n + 1)
  }

  const move = (event: PointerEvent<HTMLCanvasElement>) => {
    const start = pointer.current
    if (!start) return
    const point = at(event)
    if (start.moving) {
      start.dx = point.x - start.x
      start.dy = point.y - start.y
    } else if (start.area) {
      start.area = areaOf(start.x, start.y, point.x, point.y)
    } else if (start.mark) {
      const mark = start.mark
      start.mark = isStroke(mark)
        ? { ...mark, points: [...mark.points, point.x, point.y] }
        : isShape(mark)
          ? { ...mark, x2: point.x, y2: point.y }
          : mark
    }
    redraw(n => n + 1)
  }

  const up = () => {
    const start = pointer.current
    pointer.current = null
    if (!start) return
    if (start.moving && (start.dx || start.dy)) {
      void latest.current.onMove(start.moving.id, start.dx ?? 0, start.dy ?? 0)
    } else if (start.area && start.area.w > 4 && start.area.h > 4) {
      void latest.current.onArea(start.area)
    } else if (start.mark) {
      const mark = start.mark
      // A tap with a shape tool draws nothing; a tap with the pen leaves a dot.
      const empty = isShape(mark) && Math.hypot(mark.x2 - mark.x1, mark.y2 - mark.y1) < 3
      if (!empty) void latest.current.onMark(mark)
    }
    redraw(n => n + 1)
  }

  return (
    <div
      style={{
        alignItems: 'center',
        background,
        boxSizing: 'border-box',
        display: 'flex',
        // Fills the card's box in a browser, and the whole page in the phone's web view.
        inset: 0,
        justifyContent: 'center',
        overflow: 'hidden',
        padding: 8,
        position: 'absolute'
      }}
    >
      {image ? (
        <canvas
          aria-label="Picture being marked up"
          data-testid="markup-canvas"
          onPointerCancel={up}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          ref={canvas}
          style={{
            display: 'block',
            maxHeight: '100%',
            maxWidth: '100%',
            objectFit: 'contain',
            touchAction: 'none',
            userSelect: 'none'
          }}
        />
      ) : null}
    </div>
  )
}
