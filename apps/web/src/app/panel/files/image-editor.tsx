import {
  Check,
  Circle,
  Copy,
  Crop,
  Grid3x3,
  Highlighter,
  ImagePlus,
  MessageSquarePlus,
  MousePointer2,
  MoveUpRight,
  Pencil,
  Redo2,
  RotateCcw,
  Slash,
  Square,
  Type,
  Undo2,
  X
} from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { readFileAsDataUrl } from '../../../lib/api'
import { cn } from '../../../lib/cn'
import { mimeOf } from '../../../lib/media'
import type { FileComment } from '../../../stores/file-comments'

import { statusText, useAutosave } from './autosave'
import type { CommentTarget } from './comment-layer'
import { downloadBlob, downloadEntry, FileToolbar, type MenuEntry, toolClass } from './file-toolbar'
import {
  type Area,
  areaOf,
  boundsOf,
  EMPTY,
  isShape,
  isStroke,
  type Mark,
  markAt,
  type Markup,
  moved,
  nextStep,
  render,
  type Tool
} from './markup'

/** Pictures saved back in their own format; others can be marked up and sent, not saved. */
const SAVES = new Set(['image/jpeg', 'image/png', 'image/webp'])

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp'
}

const COLORS = [
  { label: 'Red', value: '#ef4444' },
  { label: 'Orange', value: '#f97316' },
  { label: 'Yellow', value: '#facc15' },
  { label: 'Green', value: '#22c55e' },
  { label: 'Blue', value: '#3b82f6' },
  { label: 'Black', value: '#111111' },
  { label: 'White', value: '#ffffff' }
]

const TOOLS: { icon: ReactNode; key: string; label: string; tool: Tool }[] = [
  { icon: <MousePointer2 size={15} />, key: 'v', label: 'Select and move', tool: 'select' },
  { icon: <Pencil size={15} />, key: 'p', label: 'Pen', tool: 'pen' },
  { icon: <Highlighter size={15} />, key: 'h', label: 'Highlighter', tool: 'highlighter' },
  { icon: <MoveUpRight size={15} />, key: 'a', label: 'Arrow', tool: 'arrow' },
  { icon: <Slash size={15} />, key: 'l', label: 'Line', tool: 'line' },
  { icon: <Square size={15} />, key: 'r', label: 'Rectangle', tool: 'rect' },
  { icon: <Circle size={15} />, key: 'e', label: 'Ellipse', tool: 'ellipse' },
  { icon: <Type size={15} />, key: 't', label: 'Text', tool: 'text' },
  {
    icon: (
      <span className="grid size-[17px] place-items-center rounded-full border-[1.6px] border-current text-[10px] leading-none font-bold">
        1
      </span>
    ),
    key: 'n',
    label: 'Numbered step',
    tool: 'step'
  },
  { icon: <Grid3x3 size={15} />, key: 'b', label: 'Pixelate', tool: 'pixelate' },
  { icon: <Crop size={15} />, key: 'c', label: 'Crop', tool: 'crop' }
]

let markIds = 0

export interface ImageEditorProps {
  name: string
  mime: string
  /** The picture, as a URL this page can draw. */
  src: string
  /** Its version on the daemon; a new one the panel did not write reopens it. */
  version: string
  /** The panel may save it back. */
  editable: boolean
  botName: string
  onSave: (dataUrl: string) => Promise<string>
  flushRef: { current: (() => Promise<boolean>) | null }
  /** Comments waiting on this picture, drawn where they point. */
  comments: FileComment[]
  /** Absent where the chat takes no messages. */
  onComment?: (target: CommentTarget, area: Area) => void
  /** Adds the picture, as marked up, to the chat's next message. */
  onAttach?: (file: File) => void
  /** The editor took on this version of the picture: its saves start from it. */
  onFollow: (version: string) => void
}

/** The picture as it is now, as a file of its own format (or PNG). */
function exportBlob(canvas: HTMLCanvasElement, mime: string): Promise<Blob | null> {
  return new Promise(resolve => canvas.toBlob(resolve, SAVES.has(mime) ? mime : 'image/png', 0.92))
}

/**
 * A picture beside the chat, marked up the way a screenshot tool does it:
 * pen, highlighter, arrows, lines, boxes, ellipses, text, numbered steps,
 * pixelate and crop, with select to move or delete a mark and undo for every
 * step. Save writes it back over the file; Add to message sends it as marked
 * up. Comment marks an area and leaves a comment on it for the bot.
 */
export function ImageEditor({
  botName,
  comments,
  editable,
  flushRef,
  mime,
  name,
  onAttach,
  onComment,
  onFollow,
  onSave,
  src,
  version
}: ImageEditorProps) {
  const [image, setImage] = useState<HTMLImageElement | null>(null)
  const [failed, setFailed] = useState(false)
  const [tool, setTool] = useState<Tool>('arrow')
  const [color, setColor] = useState(COLORS[0]!.value)
  const [size, setSize] = useState(1)
  const [past, setPast] = useState<Markup[]>([])
  const [future, setFuture] = useState<Markup[]>([])
  const [markup, setMarkup] = useState<Markup>(EMPTY)
  const [draft, setDraft] = useState<Mark | null>(null)
  const [selected, setSelected] = useState<null | string>(null)
  const [cropBox, setCropBox] = useState<Area | null>(null)

  const [typing, setTyping] = useState<null | { x: number; y: number; text: string; id?: string }>(
    null
  )

  const [commentBox, setCommentBox] = useState<Area | null>(null)
  const [copied, setCopied] = useState(false)
  // Bumped when the picture's size on screen changes, so boxes over it follow.
  const [layout, setLayout] = useState(0)
  const canvas = useRef<HTMLCanvasElement>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const root = useRef<HTMLDivElement>(null)
  const pointer = useRef<null | { x: number; y: number; mark?: Mark; moving?: Mark }>(null)
  const base = useRef(version)
  // A stroke, a text mark or a crop under way: a new version waits for it too.
  const busy = useRef<() => boolean>(() => false)
  // Saved once since it opened: Restore puts the original back.
  const savedOnce = useRef(false)
  const saves = SAVES.has(mime) && editable

  const save = useAutosave(async () => {
    const node = document.createElement('canvas')

    if (!image) {
      return
    }

    render(node, image, markup)
    const blob = await exportBlob(node, mime)

    if (!blob) {
      throw new Error('The picture could not be saved.')
    }

    base.current = await onSave(await readFileAsDataUrl(blob))
    savedOnce.current = true
  }, flushRef)

  // Opens the picture, and a new version of it that this panel did not write.
  useEffect(() => {
    if (image && (version === base.current || save.dirty())) {
      return
    }

    // A newer version arriving while this one decodes replaces it.
    let live = true
    const next = new Image()

    next.onload = () => {
      // Marks drawn or saved while it decoded stay; their save meets the new
      // version and the panel offers it instead of overwriting it.
      if (!live || save.dirty() || busy.current()) {
        return
      }

      base.current = version
      setImage(next)
      setFailed(false)
      setMarkup(EMPTY)
      setPast([])
      setFuture([])
      onFollow(version)
    }

    next.onerror = () => live && setFailed(true)
    next.src = src

    return () => {
      live = false
    }
    // Only a new version reopens it; its `src` comes with it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version])

  useEffect(() => {
    const node = wrap.current

    if (!node || typeof ResizeObserver === 'undefined') {
      return
    }

    const observer = new ResizeObserver(() => setLayout(value => value + 1))
    observer.observe(node)

    return () => observer.disconnect()
  }, [])

  busy.current = () => pointer.current !== null || typing !== null || cropBox !== null

  const unit = image
    ? Math.max(2, Math.round(Math.max(image.naturalWidth, image.naturalHeight) / 400))
    : 2

  const width = [unit, unit * 2, unit * 4][size]!
  const textSize = [unit * 8, unit * 12, unit * 18][size]!
  const cropping = tool === 'crop'

  const commit = useCallback(
    (next: Markup) => {
      setPast(list => [...list.slice(-99), markup])
      setFuture([])
      setMarkup(next)

      if (saves) {
        save.mark()
      }
    },
    [markup, save, saves]
  )

  const undo = () => {
    const previous = past[past.length - 1]

    if (!previous) {
      return
    }

    setPast(list => list.slice(0, -1))
    setFuture(list => [markup, ...list])
    setMarkup(previous)
    setSelected(null)

    if (saves) {
      save.mark()
    }
  }

  const redo = () => {
    const next = future[0]

    if (!next) {
      return
    }

    setFuture(list => list.slice(1))
    setPast(list => [...list, markup])
    setMarkup(next)

    if (saves) {
      save.mark()
    }
  }

  // The drawing, redrawn on every change; while cropping the whole picture shows.
  useEffect(() => {
    if (!canvas.current || !image) {
      return
    }

    render(canvas.current, image, markup, draft, cropping)
  }, [cropping, draft, image, markup])

  /** The picture's pixel under a pointer. */
  const at = (event: { clientX: number; clientY: number }) => {
    const node = canvas.current!
    const box = node.getBoundingClientRect()
    const origin = cropping || !markup.crop ? { x: 0, y: 0 } : markup.crop

    return {
      x: ((event.clientX - box.left) / box.width) * node.width + origin.x,
      y: ((event.clientY - box.top) / box.height) * node.height + origin.y
    }
  }

  /** A picture area as a box over the canvas, in CSS px of the wrapper. */
  const onScreen = useCallback(
    (area: Area) => {
      const node = canvas.current
      const outer = wrap.current

      if (!node || !outer || !node.width) {
        return null
      }

      const box = node.getBoundingClientRect()
      const frame = outer.getBoundingClientRect()
      const scale = box.width / node.width
      const origin = cropping || !markup.crop ? { x: 0, y: 0 } : markup.crop

      // The wrapper scrolls; its children are placed from its content's corner.
      return {
        height: area.h * scale,
        left: box.left - frame.left + outer.scrollLeft + (area.x - origin.x) * scale,
        top: box.top - frame.top + outer.scrollTop + (area.y - origin.y) * scale,
        width: area.w * scale
      }
    },
    // `layout` changes when the picture's size on screen does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cropping, markup.crop, layout]
  )

  const down = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0 || !image) {
      return
    }

    event.currentTarget.setPointerCapture(event.pointerId)
    // The editor takes the keys (undo, tool letters) without the browser
    // moving focus on its own, which would close a text box as it opens.
    event.preventDefault()
    root.current?.focus({ preventScroll: true })
    const point = at(event)
    const id = `mark-${++markIds}`

    if (typing) {
      finishTyping()

      return
    }

    switch (tool) {
      case 'select': {
        const hit = markAt(markup.marks, point.x, point.y, unit * 4)
        setSelected(hit?.id ?? null)
        pointer.current = { ...point, moving: hit ?? undefined }

        return
      }

      case 'pen':

      case 'highlighter':
        pointer.current = {
          ...point,
          mark: { color, id, kind: tool, points: [point.x, point.y], width }
        }

        break

      case 'text':
        setTyping({ text: '', x: point.x, y: point.y })

        return

      case 'step':
        commit({
          ...markup,
          marks: [
            ...markup.marks,
            {
              color,
              id,
              kind: 'step',
              n: nextStep(markup.marks),
              size: textSize * 0.7,
              x: point.x,
              y: point.y
            }
          ]
        })

        return

      case 'crop':

      case 'comment':
        pointer.current = { ...point }

        break

      default:
        pointer.current = {
          ...point,
          mark: { color, id, kind: tool, width, x1: point.x, x2: point.x, y1: point.y, y2: point.y }
        }
    }

    setDraft(pointer.current.mark ?? null)
  }

  const move = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const start = pointer.current

    if (!start) {
      return
    }

    const point = at(event)

    if (start.moving) {
      const dx = point.x - start.x
      const dy = point.y - start.y

      setMarkup(current => ({
        ...current,
        marks: current.marks.map(mark =>
          mark.id === start.moving!.id ? moved(start.moving!, dx, dy) : mark
        )
      }))

      return
    }

    if (tool === 'crop' || tool === 'comment') {
      const area = areaOf(start.x, start.y, point.x, point.y)

      if (tool === 'crop') {
        setCropBox(area)
      } else {
        setCommentBox(area)
      }

      return
    }

    const mark = start.mark

    if (!mark) {
      return
    }

    const next: Mark = isStroke(mark)
      ? { ...mark, points: [...mark.points, point.x, point.y] }
      : isShape(mark)
        ? { ...mark, x2: point.x, y2: point.y }
        : mark

    start.mark = next
    setDraft(next)
  }

  const up = () => {
    const start = pointer.current
    pointer.current = null

    if (!start) {
      return
    }

    if (start.moving) {
      // A drag is one step to undo: the marks before it go on the stack.
      const before = {
        ...markup,
        marks: markup.marks.map(mark => (mark.id === start.moving!.id ? start.moving! : mark))
      }

      const changed = markup.marks.some(
        mark => mark.id === start.moving!.id && mark !== start.moving
      )

      if (changed) {
        setPast(list => [...list.slice(-99), before])
        setFuture([])

        if (saves) {
          save.mark()
        }
      }

      return
    }

    if (tool === 'comment') {
      if (commentBox && commentBox.w > 4 && commentBox.h > 4 && onComment && wrap.current) {
        const screen = onScreen(commentBox)
        const frame = wrap.current.getBoundingClientRect()
        const panel = wrap.current.closest('[role="tabpanel"]')?.getBoundingClientRect() ?? frame
        const round = (value: number) => Math.round(value)

        onComment(
          {
            // In the picture as it is saved: a crop moves its corner.
            where: `the marked area at ${round(commentBox.x - (markup.crop?.x ?? 0))}, ${round(commentBox.y - (markup.crop?.y ?? 0))} (${round(commentBox.w)}×${round(commentBox.h)} px)`,
            x: Math.max(
              8,
              Math.min((screen?.left ?? 0) + frame.left - panel.left, panel.width - 296)
            ),
            y: (screen ? screen.top + screen.height : 40) + frame.top - panel.top + 6
          },
          commentBox
        )
      }

      setCommentBox(null)

      return
    }

    const mark = start.mark

    setDraft(null)

    if (!mark) {
      return
    }

    // A click with a shape tool draws nothing.
    if (isShape(mark) && Math.hypot(mark.x2 - mark.x1, mark.y2 - mark.y1) < unit * 2) {
      return
    }

    commit({ ...markup, marks: [...markup.marks, mark] })
  }

  const finishTyping = () => {
    if (!typing) {
      return
    }

    const text = typing.text.replace(/\s+$/, '')
    setTyping(null)

    if (typing.id) {
      commit({
        ...markup,
        marks: text
          ? markup.marks.map(mark =>
              mark.id === typing.id && mark.kind === 'text' ? { ...mark, text } : mark
            )
          : markup.marks.filter(mark => mark.id !== typing.id)
      })
    } else if (text) {
      commit({
        ...markup,
        marks: [
          ...markup.marks,
          {
            color,
            id: `mark-${++markIds}`,
            kind: 'text',
            size: textSize,
            text,
            x: typing.x,
            y: typing.y
          }
        ]
      })
    }
  }

  const applyCrop = () => {
    // Both edges inside the picture, so a drag past one keeps only what was selected.
    const x = Math.max(0, cropBox?.x ?? 0)
    const y = Math.max(0, cropBox?.y ?? 0)
    const right = Math.min(image?.naturalWidth ?? 0, (cropBox?.x ?? 0) + (cropBox?.w ?? 0))
    const bottom = Math.min(image?.naturalHeight ?? 0, (cropBox?.y ?? 0) + (cropBox?.h ?? 0))

    if (cropBox && image && right - x > 8 && bottom - y > 8) {
      commit({ ...markup, crop: { h: bottom - y, w: right - x, x, y } })
    }

    setCropBox(null)
    setTool('arrow')
  }

  const removeSelected = () => {
    if (selected) {
      commit({ ...markup, marks: markup.marks.filter(mark => mark.id !== selected) })
      setSelected(null)
    }
  }

  const recolor = (next: string) => {
    setColor(next)

    if (selected) {
      commit({
        ...markup,
        marks: markup.marks.map(mark => (mark.id === selected ? { ...mark, color: next } : mark))
      })
    }
  }

  const keys = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (
      typing ||
      (event.target as HTMLElement).tagName === 'TEXTAREA' ||
      (event.target as HTMLElement).tagName === 'INPUT'
    ) {
      return
    }

    const mod = event.metaKey || event.ctrlKey

    if (mod && event.key.toLowerCase() === 'z') {
      event.preventDefault()

      if (event.shiftKey) {
        redo()
      } else {
        undo()
      }
    } else if (mod && event.key.toLowerCase() === 's' && saves) {
      event.preventDefault()
      void save.flush()
    } else if ((event.key === 'Delete' || event.key === 'Backspace') && selected) {
      event.preventDefault()
      removeSelected()
    } else if (event.key === 'Enter' && cropping) {
      event.preventDefault()
      applyCrop()
    } else if (event.key === 'Escape') {
      setCropBox(null)
      setSelected(null)

      if (cropping) {
        setTool('arrow')
      }
    } else if (!mod && !event.altKey) {
      const match = TOOLS.find(item => item.key === event.key.toLowerCase())

      if (match) {
        setTool(match.tool)
      } else if (event.key.toLowerCase() === 'm' && onComment) {
        setTool('comment')
      }
    }
  }

  const exportNow = async () => {
    if (!image) {
      return null
    }

    const node = document.createElement('canvas')
    render(node, image, markup)

    return exportBlob(node, mime)
  }

  /** The name for a picture exported as `blob`: its own, or its stem with the format written. */
  const nameFor = (blob: Blob) =>
    mimeOf(name) === blob.type
      ? name
      : `${name.replace(/\.[^.]+$/, '')}.${EXTENSIONS[blob.type] ?? 'png'}`

  const menu: MenuEntry[] = [
    {
      icon: <Copy size={14} />,
      label: copied ? 'Copied' : 'Copy image',
      onSelect: () =>
        void exportNow().then(async blob => {
          if (blob && typeof ClipboardItem !== 'undefined') {
            const png =
              blob.type === 'image/png'
                ? blob
                : await new Promise<Blob | null>(resolve => {
                    const node = document.createElement('canvas')
                    render(node, image!, markup)
                    node.toBlob(resolve, 'image/png')
                  })

            if (png) {
              await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            }
          }
        })
    },
    downloadEntry(() => void exportNow().then(blob => blob && downloadBlob(nameFor(blob), blob))),
    {
      disabled: !markup.marks.length && !markup.crop && !savedOnce.current,
      icon: <RotateCcw size={14} />,
      label: 'Restore original',
      onSelect: () => {
        commit(EMPTY)
        setSelected(null)
      }
    }
  ]

  const selectedBox = useMemo(() => {
    const mark = markup.marks.find(item => item.id === selected)

    return mark ? boundsOf(mark, canvas.current?.getContext('2d') ?? null) : null
  }, [markup.marks, selected])

  if (failed) {
    return (
      <p className="m-4 rounded-[12px] bg-foreground/[0.04] px-4 py-3 text-[length:var(--text-secondary)] text-muted">
        {name} could not be opened here.
      </p>
    )
  }

  const button = (
    label: string,
    active: boolean,
    onClick: () => void,
    icon: ReactNode,
    disabled = false,
    shortcut?: string
  ) => (
    <button
      aria-label={label}
      aria-pressed={active}
      className={toolClass}
      disabled={disabled}
      key={label}
      onClick={onClick}
      title={shortcut ? `${label} (${shortcut.toUpperCase()})` : label}
      type="button"
    >
      {icon}
    </button>
  )

  const overlay = (area: Area | null, className: string, children?: ReactNode, key?: string) => {
    const box = area ? onScreen(area) : null

    return box ? (
      <div className={cn('pointer-events-none absolute', className)} key={key} style={box}>
        {children}
      </div>
    ) : null
  }

  const typingBox = typing ? onScreen({ h: textSize, w: 10, x: typing.x, y: typing.y }) : null

  const scale =
    canvas.current && canvas.current.width
      ? canvas.current.getBoundingClientRect().width / canvas.current.width
      : 1

  return (
    <div
      className="flex h-full min-h-0 flex-col outline-none"
      data-comment-own
      onKeyDown={keys}
      ref={root}
      tabIndex={-1}
    >
      <FileToolbar
        menu={menu}
        status={
          saves
            ? save.unsaved && save.status !== 'saving'
              ? 'Unsaved'
              : statusText(save.status)
            : 'Not saved here'
        }
      >
        <div
          aria-label="Markup tools"
          className="flex flex-wrap items-center gap-0.5"
          role="toolbar"
        >
          {TOOLS.map(item =>
            button(
              item.label,
              tool === item.tool,
              () => {
                setTool(item.tool)
                setSelected(null)
              },
              item.icon,
              false,
              item.key
            )
          )}
          {onComment
            ? button(
                'Comment on an area',
                tool === 'comment',
                () => setTool('comment'),
                <MessageSquarePlus size={15} />,
                false,
                'm'
              )
            : null}
        </div>
      </FileToolbar>
      <div className="flex flex-wrap items-center gap-1 px-3 pb-2">
        <div aria-label="Colour" className="flex items-center gap-1" role="radiogroup">
          {COLORS.map(item => (
            <button
              aria-checked={color === item.value}
              aria-label={item.label}
              className={cn(
                'hex-focus size-5 rounded-full border border-foreground/15 transition-transform',
                color === item.value &&
                  'scale-110 ring-2 ring-accent ring-offset-1 ring-offset-background'
              )}
              key={item.value}
              onClick={() => recolor(item.value)}
              role="radio"
              style={{ background: item.value }}
              type="button"
            />
          ))}
        </div>
        <span aria-hidden className="mx-1 h-4 w-px bg-foreground/[0.1]" />
        <div aria-label="Size" className="flex items-center" role="radiogroup">
          {[0, 1, 2].map(value =>
            button(
              ['Thin', 'Medium', 'Thick'][value]!,
              size === value,
              () => setSize(value),
              <span
                className="rounded-full bg-current"
                style={{ height: 3 + value * 3, width: 3 + value * 3 }}
              />
            )
          )}
        </div>
        <span aria-hidden className="mx-1 h-4 w-px bg-foreground/[0.1]" />
        {button('Undo', false, undo, <Undo2 size={15} />, !past.length)}
        {button('Redo', false, redo, <Redo2 size={15} />, !future.length)}
        {selected ? button('Delete mark', false, removeSelected, <X size={15} />) : null}
        <span className="ml-auto flex items-center gap-1">
          {onAttach ? (
            <button
              className="hex-focus flex h-8 items-center gap-1.5 rounded-full bg-foreground/[0.06] px-3 text-[length:var(--text-meta)] font-medium text-foreground hover:bg-foreground/[0.1] disabled:opacity-40"
              disabled={!image}
              onClick={() =>
                void exportNow().then(
                  blob => blob && onAttach(new File([blob], nameFor(blob), { type: blob.type }))
                )
              }
              title={`Add the picture, as marked up, to your message to ${botName}`}
              type="button"
            >
              <ImagePlus size={14} />
              Add to message
            </button>
          ) : null}
          {saves ? (
            <button
              className="hex-focus flex h-8 items-center gap-1.5 rounded-full bg-foreground px-3 text-[length:var(--text-meta)] font-medium text-background hover:opacity-85 disabled:opacity-40"
              disabled={save.status === 'saving' || !save.unsaved}
              onClick={() => void save.flush()}
              title="Save (⌘S)"
              type="button"
            >
              <Check size={14} />
              Save
            </button>
          ) : null}
        </span>
      </div>
      {save.error ? (
        <p
          className="mx-3 mb-2 rounded-[12px] bg-danger/10 px-3 py-2 text-[length:var(--text-meta)] text-danger"
          role="alert"
        >
          {save.error}
        </p>
      ) : null}
      <div className="relative min-h-0 flex-1 overflow-auto px-3 pb-4" ref={wrap}>
        {image ? (
          <canvas
            aria-label={`${name}, ${markup.marks.length} ${markup.marks.length === 1 ? 'mark' : 'marks'}`}
            className={cn(
              'mx-auto block max-w-full touch-none rounded-[8px] shadow-card',
              tool === 'select'
                ? 'cursor-default'
                : tool === 'text'
                  ? 'cursor-text'
                  : 'cursor-crosshair'
            )}
            data-testid="image-canvas"
            onDoubleClick={event => {
              const point = at(event)
              const hit = markAt(markup.marks, point.x, point.y, unit * 2)

              if (hit?.kind === 'text') {
                setTyping({ id: hit.id, text: hit.text, x: hit.x, y: hit.y })
              }
            }}
            onPointerCancel={up}
            onPointerDown={down}
            onPointerMove={move}
            onPointerUp={up}
            ref={canvas}
            role="img"
          />
        ) : (
          <p className="m-4 text-[length:var(--text-secondary)] text-muted">Opening {name}…</p>
        )}
        {overlay(selectedBox, 'rounded-[4px] border border-dashed border-accent')}
        {overlay(commentBox, 'rounded-[4px] border-2 border-dashed border-accent bg-accent/10')}
        {cropping && cropBox ? (
          <>
            {overlay(cropBox, 'border-2 border-white shadow-[0_0_0_9999px_rgba(0,0,0,0.45)]')}
            <div className="sticky bottom-2 z-10 mx-auto mt-2 flex w-fit gap-1.5">
              <button
                className="hex-glass hex-focus rounded-full px-3 py-1.5 text-[length:var(--text-meta)] font-medium"
                onClick={() => setCropBox(null)}
                type="button"
              >
                Cancel
              </button>
              <button
                className="hex-focus rounded-full bg-foreground px-3 py-1.5 text-[length:var(--text-meta)] font-medium text-background"
                onClick={applyCrop}
                type="button"
              >
                Crop
              </button>
            </div>
          </>
        ) : null}
        {comments.map((comment, index) =>
          comment.area
            ? overlay(
                comment.area,
                'rounded-[4px] border-2 border-dashed border-accent',
                <span className="absolute -top-2.5 -left-2.5 grid size-5 place-items-center rounded-full bg-accent text-[11px] font-semibold text-white">
                  {index + 1}
                </span>,
                comment.id
              )
            : null
        )}
        {typing && typingBox ? (
          <textarea
            aria-label="Text"
            autoFocus
            className="absolute z-10 min-w-24 resize-none rounded-[4px] border border-dashed border-accent bg-transparent p-0 outline-none [field-sizing:content]"
            data-comment="off"
            onBlur={finishTyping}
            onChange={event => setTyping({ ...typing, text: event.target.value })}
            onKeyDown={event => {
              // Enter that ends an IME composition (Chinese, Japanese, Korean) is not a command.
              if (event.nativeEvent.isComposing) {
                return
              }

              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                finishTyping()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                setTyping(null)
              }
            }}
            ref={node => node?.focus({ preventScroll: true })}
            style={{
              color,
              font: `600 ${textSize * scale}px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`,
              left: typingBox.left,
              lineHeight: 1.25,
              top: typingBox.top
            }}
            value={typing.text}
          />
        ) : null}
      </div>
    </div>
  )
}
