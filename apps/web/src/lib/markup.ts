// Marks drawn on a picture: the model and the drawing, kept apart from the
// editor so they can be tested and exported the same way they are shown.

export type Tool =
  | 'arrow'
  | 'comment'
  | 'crop'
  | 'ellipse'
  | 'highlighter'
  | 'line'
  | 'pen'
  | 'pixelate'
  | 'rect'
  | 'select'
  | 'step'
  | 'text'

export interface Area {
  x: number
  y: number
  w: number
  h: number
}

interface Base {
  id: string
  color: string
}

export type StrokeMark = Base & { kind: 'highlighter' | 'pen'; width: number; points: number[] }

/** A mark drawn between two corners: a line, an arrow, a box, an ellipse, a pixelated area. */
export type ShapeMark = Base & {
  kind: 'arrow' | 'ellipse' | 'line' | 'pixelate' | 'rect'
  width: number
  x1: number
  y1: number
  x2: number
  y2: number
}

export type Mark =
  | StrokeMark
  | ShapeMark
  | (Base & { kind: 'text'; size: number; x: number; y: number; text: string })
  | (Base & { kind: 'step'; size: number; x: number; y: number; n: number })

export const isStroke = (mark: Mark): mark is StrokeMark =>
  mark.kind === 'pen' || mark.kind === 'highlighter'

export const isShape = (mark: Mark): mark is ShapeMark =>
  !isStroke(mark) && mark.kind !== 'text' && mark.kind !== 'step'

export interface Markup {
  marks: Mark[]
  /** The part of the picture kept, or null for all of it. */
  crop: Area | null
}

export const EMPTY: Markup = { crop: null, marks: [] }

/** The rectangle two corners span. */
export function areaOf(x1: number, y1: number, x2: number, y2: number): Area {
  return { h: Math.abs(y2 - y1), w: Math.abs(x2 - x1), x: Math.min(x1, x2), y: Math.min(y1, y2) }
}

/** Text marks measure with the canvas; tests have none, so they estimate. */
function textWidth(ctx: CanvasRenderingContext2D | null, mark: { size: number; text: string }) {
  if (ctx) {
    ctx.font = fontOf(mark.size)

    return Math.max(...mark.text.split('\n').map(line => ctx.measureText(line).width))
  }

  return Math.max(...mark.text.split('\n').map(line => line.length)) * mark.size * 0.55
}

export const fontOf = (size: number) =>
  `600 ${size}px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`

/** A mark's bounds, for selecting and moving it. */
export function boundsOf(mark: Mark, ctx: CanvasRenderingContext2D | null = null): Area {
  switch (mark.kind) {
    case 'pen':
    case 'highlighter': {
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity

      for (let index = 0; index < mark.points.length; index += 2) {
        minX = Math.min(minX, mark.points[index]!)
        maxX = Math.max(maxX, mark.points[index]!)
        minY = Math.min(minY, mark.points[index + 1]!)
        maxY = Math.max(maxY, mark.points[index + 1]!)
      }

      const pad = mark.kind === 'highlighter' ? mark.width * 2 : mark.width / 2

      return { h: maxY - minY + pad * 2, w: maxX - minX + pad * 2, x: minX - pad, y: minY - pad }
    }

    case 'text': {
      const lines = mark.text.split('\n').length

      return { h: mark.size * 1.25 * lines, w: textWidth(ctx, mark), x: mark.x, y: mark.y }
    }

    case 'step':
      return { h: mark.size * 2, w: mark.size * 2, x: mark.x - mark.size, y: mark.y - mark.size }
    default: {
      const area = areaOf(mark.x1, mark.y1, mark.x2, mark.y2)
      const pad = mark.width

      return { h: area.h + pad * 2, w: area.w + pad * 2, x: area.x - pad, y: area.y - pad }
    }
  }
}

/** The topmost mark under a point, with some slack for thin lines. */
export function markAt(
  marks: Mark[],
  x: number,
  y: number,
  slack: number,
  ctx: CanvasRenderingContext2D | null = null
): Mark | null {
  for (let index = marks.length - 1; index >= 0; index--) {
    const box = boundsOf(marks[index]!, ctx)

    if (
      x >= box.x - slack &&
      x <= box.x + box.w + slack &&
      y >= box.y - slack &&
      y <= box.y + box.h + slack
    ) {
      return marks[index]!
    }
  }

  return null
}

/** The mark moved by dx, dy. */
export function moved(mark: Mark, dx: number, dy: number): Mark {
  switch (mark.kind) {
    case 'pen':

    case 'highlighter':
      return { ...mark, points: mark.points.map((value, index) => value + (index % 2 ? dy : dx)) }

    case 'text':

    case 'step':
      return { ...mark, x: mark.x + dx, y: mark.y + dy }

    default:
      return { ...mark, x1: mark.x1 + dx, x2: mark.x2 + dx, y1: mark.y1 + dy, y2: mark.y2 + dy }
  }
}

/** The next number for a step marker. */
export const nextStep = (marks: Mark[]) =>
  marks.reduce((most, mark) => (mark.kind === 'step' ? Math.max(most, mark.n) : most), 0) + 1

function drawArrow(ctx: CanvasRenderingContext2D, mark: ShapeMark) {
  const { x1, x2, y1, y2 } = mark
  const angle = Math.atan2(y2 - y1, x2 - x1)
  const length = Math.hypot(x2 - x1, y2 - y1)
  const head = Math.min(Math.max(mark.width * 4, 14), length * 0.6)
  const spread = Math.PI / 7
  const baseX = x2 - Math.cos(angle) * head * 0.8
  const baseY = y2 - Math.sin(angle) * head * 0.8

  ctx.beginPath()
  ctx.moveTo(x1, y1)
  ctx.lineTo(baseX, baseY)
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(x2, y2)
  ctx.lineTo(x2 - Math.cos(angle - spread) * head, y2 - Math.sin(angle - spread) * head)
  ctx.lineTo(x2 - Math.cos(angle + spread) * head, y2 - Math.sin(angle + spread) * head)
  ctx.closePath()
  ctx.fill()
}

function drawStroke(ctx: CanvasRenderingContext2D, points: number[]) {
  ctx.beginPath()
  ctx.moveTo(points[0]!, points[1]!)

  if (points.length === 2) {
    ctx.lineTo(points[0]! + 0.01, points[1]!)
  }

  // Through the midpoints, so a quick stroke still looks smooth.
  for (let index = 2; index < points.length - 2; index += 2) {
    const midX = (points[index]! + points[index + 2]!) / 2
    const midY = (points[index + 1]! + points[index + 3]!) / 2
    ctx.quadraticCurveTo(points[index]!, points[index + 1]!, midX, midY)
  }

  if (points.length > 2) {
    ctx.lineTo(points[points.length - 2]!, points[points.length - 1]!)
  }

  ctx.stroke()
}

/**
 * Covers an area with large squares of its own colours, so text there can
 * no longer be read. It reads what is drawn so far, marks included.
 */
function drawPixelate(
  ctx: CanvasRenderingContext2D,
  mark: ShapeMark,
  origin: { x: number; y: number }
) {
  const area = areaOf(mark.x1, mark.y1, mark.x2, mark.y2)

  if (area.w < 2 || area.h < 2) {
    return
  }

  const canvas = ctx.canvas
  const block = Math.max(6, Math.round(Math.max(canvas.width, canvas.height) / 60))
  const small = document.createElement('canvas')
  small.width = Math.max(1, Math.ceil(area.w / block))
  small.height = Math.max(1, Math.ceil(area.h / block))
  const smallCtx = small.getContext('2d')

  if (!smallCtx) {
    return
  }

  smallCtx.drawImage(
    canvas,
    area.x - origin.x,
    area.y - origin.y,
    area.w,
    area.h,
    0,
    0,
    small.width,
    small.height
  )
  ctx.save()
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(small, 0, 0, small.width, small.height, area.x, area.y, area.w, area.h)
  ctx.restore()
}

/** Draws one mark. `origin` is the picture's point at the canvas's corner. */
export function drawMark(
  ctx: CanvasRenderingContext2D,
  mark: Mark,
  origin: { x: number; y: number }
) {
  ctx.save()
  ctx.strokeStyle = mark.color
  ctx.fillStyle = mark.color
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  switch (mark.kind) {
    case 'pen':
      ctx.lineWidth = mark.width
      drawStroke(ctx, mark.points)

      break

    case 'highlighter':
      ctx.globalAlpha = 0.4
      ctx.globalCompositeOperation = 'multiply'
      ctx.lineWidth = mark.width * 4
      ctx.lineCap = 'butt'
      drawStroke(ctx, mark.points)

      break

    case 'line':
      ctx.lineWidth = mark.width
      ctx.beginPath()
      ctx.moveTo(mark.x1, mark.y1)
      ctx.lineTo(mark.x2, mark.y2)
      ctx.stroke()

      break

    case 'arrow':
      ctx.lineWidth = mark.width
      drawArrow(ctx, mark)

      break
    case 'rect': {
      const area = areaOf(mark.x1, mark.y1, mark.x2, mark.y2)
      ctx.lineWidth = mark.width
      ctx.beginPath()
      ctx.roundRect(area.x, area.y, area.w, area.h, Math.min(mark.width, area.w / 2, area.h / 2))
      ctx.stroke()

      break
    }

    case 'ellipse': {
      const area = areaOf(mark.x1, mark.y1, mark.x2, mark.y2)
      ctx.lineWidth = mark.width
      ctx.beginPath()
      ctx.ellipse(
        area.x + area.w / 2,
        area.y + area.h / 2,
        area.w / 2,
        area.h / 2,
        0,
        0,
        Math.PI * 2
      )
      ctx.stroke()

      break
    }

    case 'pixelate':
      drawPixelate(ctx, mark, origin)

      break

    case 'text':
      ctx.font = fontOf(mark.size)
      ctx.textBaseline = 'top'
      // A thin halo keeps the words readable on any background.
      ctx.lineWidth = Math.max(2, mark.size / 7)
      ctx.strokeStyle = isLight(mark.color) ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.85)'
      mark.text.split('\n').forEach((line, index) => {
        ctx.strokeText(line, mark.x, mark.y + index * mark.size * 1.25)
        ctx.fillText(line, mark.x, mark.y + index * mark.size * 1.25)
      })

      break

    case 'step':
      ctx.beginPath()
      ctx.arc(mark.x, mark.y, mark.size, 0, Math.PI * 2)
      ctx.fill()
      ctx.lineWidth = Math.max(2, mark.size / 6)
      ctx.strokeStyle = '#ffffff'
      ctx.stroke()
      ctx.fillStyle = isLight(mark.color) ? '#111111' : '#ffffff'
      ctx.font = fontOf(mark.size * 1.1)
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(String(mark.n), mark.x, mark.y + mark.size * 0.06)

      break
  }

  ctx.restore()
}

function isLight(color: string): boolean {
  const match = /^#([0-9a-f]{6})$/i.exec(color)

  if (!match) {
    return false
  }

  const value = parseInt(match[1]!, 16)
  const luminance = 0.299 * (value >> 16) + 0.587 * ((value >> 8) & 255) + 0.114 * (value & 255)

  return luminance > 170
}

/**
 * Draws the picture with its marks on a canvas the size of the part kept.
 * The same drawing is shown and saved.
 */
export function render(
  canvas: HTMLCanvasElement,
  image: CanvasImageSource & { naturalWidth: number; naturalHeight: number },
  markup: Markup,
  extra?: Mark | null,
  ignoreCrop = false
) {
  const crop =
    !ignoreCrop && markup.crop
      ? markup.crop
      : { h: image.naturalHeight, w: image.naturalWidth, x: 0, y: 0 }

  if (canvas.width !== Math.round(crop.w) || canvas.height !== Math.round(crop.h)) {
    canvas.width = Math.round(crop.w)
    canvas.height = Math.round(crop.h)
  }

  const ctx = canvas.getContext('2d')

  if (!ctx) {
    return
  }

  const origin = { x: crop.x, y: crop.y }
  ctx.setTransform(1, 0, 0, 1, -crop.x, -crop.y)
  ctx.clearRect(crop.x, crop.y, crop.w, crop.h)
  ctx.drawImage(image, 0, 0)

  for (const mark of extra ? [...markup.marks, extra] : markup.marks) {
    drawMark(ctx, mark, origin)
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0)
}
