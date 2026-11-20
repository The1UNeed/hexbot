import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { ScrollArea } from '../../../components/ui/scroll-area'
import type { OpenedFile } from '../../../lib/api'
import { cn } from '../../../lib/cn'
import {
  type DocxBlock,
  type DocxParagraph,
  joinParagraph,
  readDocx,
  setParagraphText,
  splitParagraph
} from '../../../lib/office/docx'
import { dataUrlOf, keyOf, OfficePackage } from '../../../lib/office/package'
import {
  type PptxParagraph,
  type PptxShape,
  type PptxSlide,
  readPptx,
  setSlideText
} from '../../../lib/office/pptx'
import { cellLocked, cellSource, readXlsx, setCells } from '../../../lib/office/xlsx'
import { blobFromDataUrl } from '../../conversation/file-tab'

import { statusText, useAutosave } from './autosave'
import type { CommentTarget } from './comment-layer'
import { EditableRuns } from './editable-runs'
import { downloadBlob, downloadEntry, FileToolbar, ToolbarLabel } from './file-toolbar'
import { SheetGrid } from './sheet-grid'

export const WORD = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
export const EXCEL = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
export const POWERPOINT =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation'

/** The kind of Office file a name and type are, if the panel opens it. */
export function officeKind(name: string, mime: string): 'docx' | 'pptx' | 'xlsx' | null {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()

  if (mime === WORD || ext === 'docx') {
    return 'docx'
  }

  if (mime === EXCEL || ext === 'xlsx') {
    return 'xlsx'
  }

  if (mime === POWERPOINT || ext === 'pptx') {
    return 'pptx'
  }

  return null
}

export interface OfficeViewProps {
  file: OpenedFile & { data_url: string }
  name: string
  /** The panel may save it: the chat's file, not one only this page holds. */
  editable: boolean
  /** Writes the file; answers its new version. */
  onSave: (dataUrl: string) => Promise<string>
  flushRef: { current: (() => Promise<boolean>) | null }
  onComment?: (target: CommentTarget, open: boolean) => void
  /** The view took on this version of the file: its saves start from it. */
  onFollow: (version: string) => void
}

/**
 * The opened package, edited in place and saved a moment after each edit.
 * A new version of the file (the bot's edit) replaces it, unless an edit is
 * still waiting to save; that save is then refused and the panel says so.
 */
function useOfficePackage(
  { editable, file, flushRef, onFollow, onSave }: OfficeViewProps,
  mime: string
) {
  const base = useRef(file.version)
  const [pkg, setPkg] = useState<null | OfficePackage>(null)
  const [failed, setFailed] = useState(false)
  const [revision, setRevision] = useState(0)

  const save = useAutosave(async () => {
    if (!pkg) {
      return
    }

    base.current = await onSave(dataUrlOf(pkg.save(), mime))
  }, flushRef)

  const open = useCallback((dataUrl: string) => {
    try {
      setPkg(OfficePackage.fromDataUrl(dataUrl))
      setFailed(false)
    } catch {
      setFailed(true)
    }
  }, [])

  // First open, and each version the panel did not write itself.
  useEffect(() => {
    if (pkg && (file.version === base.current || save.dirty())) {
      return
    }

    base.current = file.version
    open(file.data_url)
    onFollow(file.version)
    // Only a new version reopens the file.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.version])

  useEffect(() => () => pkg?.dispose(), [pkg])

  const changed = useCallback(() => {
    setRevision(value => value + 1)

    if (editable) {
      save.schedule()
    }
  }, [editable, save])

  const download = () => {
    const blob = pkg
      ? new Blob([pkg.save() as BlobPart], { type: mime })
      : blobFromDataUrl(file.data_url)

    if (blob) {
      downloadBlob(file.name, blob)
    }
  }

  return { changed, download, failed, pkg, revision, save }
}

function Unreadable({ name }: { name: string }) {
  return (
    <p className="m-4 rounded-[12px] bg-foreground/[0.04] px-4 py-3 text-[length:var(--text-secondary)] text-muted">
      {name} could not be opened here. Download it to open it in its own app.
    </p>
  )
}

function SaveError({ error }: { error: null | string }) {
  return error ? (
    <p
      className="mx-3 mb-2 rounded-[12px] bg-danger/10 px-3 py-2 text-[length:var(--text-meta)] text-danger"
      role="alert"
    >
      {error}
    </p>
  ) : null
}

/* ------------------------------------------------------------------ Word */

const HEADING_SIZES = [0, 22, 17, 14]

/**
 * A Word file as a page: paragraphs, headings, lists, tables and pictures.
 * Text is edited in place; Enter starts a new paragraph and Backspace at the
 * start of one joins it to the one before.
 */
export function DocxView(props: OfficeViewProps) {
  const { changed, download, failed, pkg, revision, save } = useOfficePackage(props, WORD)
  const [focus, setFocus] = useState<null | { element: Element; offset: number }>(null)
  const [width, setWidth] = useState(0)
  const area = useRef<HTMLDivElement>(null)

  const doc = useMemo(
    () => (pkg ? readDocx(pkg) : null),
    // `revision` changes when the package does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pkg, revision]
  )

  // The page is measured once it is drawn.
  const opened = doc !== null

  useEffect(() => {
    const node = area.current

    if (!node) {
      return
    }

    setWidth(node.clientWidth)

    if (typeof ResizeObserver === 'undefined') {
      return
    }

    const observer = new ResizeObserver(() => setWidth(node.clientWidth))
    observer.observe(node)

    return () => observer.disconnect()
  }, [opened])

  if (failed) {
    return <Unreadable name={props.name} />
  }

  const page = doc?.page ?? { margin: 96, width: 816 }
  // The page keeps its proportions and shrinks to the panel.
  const zoom = width ? Math.min(1, (width - 24) / page.width) : 1

  const paragraph = (block: DocxParagraph, siblings: DocxParagraph[]) => {
    const index = siblings.indexOf(block)
    const text = block.views.map(view => view.text).join('')
    const tag = block.heading ? (`h${block.heading}` as 'h1') : block.list ? 'li' : 'p'

    return (
      <div className="flex flex-col" key={keyOf(block.element)}>
        {block.pictures.map(src => (
          <img alt="" className="my-2 max-w-full" key={src} src={src} />
        ))}
        {block.pictures.length && !text ? null : (
          <EditableRuns
            baseSize={block.title ? 26 : block.heading ? HEADING_SIZES[block.heading] : 11}
            breaks
            className={cn(
              'min-h-[1.4em] leading-[1.45] whitespace-pre-wrap outline-none focus:bg-[#0563c1]/[0.04]',
              block.heading ? 'mt-4 mb-1 font-semibold text-[#1f3864]' : 'my-1.5',
              block.list && 'list-item',
              block.list?.ordered ? 'list-decimal' : block.list ? 'list-disc' : ''
            )}
            editable={props.editable}
            focusAt={focus?.element === block.element ? focus.offset : null}
            onCommit={texts => {
              if (pkg) {
                setParagraphText(pkg, block, texts)
                changed()
              }
            }}
            onJoin={
              index > 0
                ? () => {
                    if (!pkg) {
                      return
                    }

                    const previous = siblings[index - 1]!
                    const offset = joinParagraph(pkg, previous, block)
                    setFocus({ element: previous.element, offset })
                    changed()
                  }
                : undefined
            }
            onSplit={(before, after, run) => {
              if (!pkg) {
                return
              }

              const next = splitParagraph(pkg, block, before, after, run)
              setFocus({ element: next, offset: 0 })
              changed()
            }}
            onTyping={save.mark}
            pxPerPt={4 / 3}
            runs={block.views}
            style={{
              marginLeft: block.list ? `${1.5 + block.list.level * 1.5}em` : undefined,
              textAlign: block.align
            }}
            tag={tag}
            where={block.where}
          />
        )}
      </div>
    )
  }

  const blocks = (list: DocxBlock[]) =>
    list.map((block, index) =>
      block.kind === 'paragraph' ? (
        // Backspace joins a paragraph only to one right before it, not across a table.
        paragraph(
          block,
          list[index - 1]?.kind === 'paragraph'
            ? [list[index - 1] as DocxParagraph, block]
            : [block]
        )
      ) : (
        <table className="my-3 w-full border-collapse text-[14px]" key={keyOf(block.element)}>
          <tbody>
            {block.rows.map((row, r) => (
              <tr key={r}>
                {row.map((cell, c) => (
                  <td className="border border-[#bfbfbf] px-2 py-1 align-top" key={c}>
                    {cell.map(item => paragraph(item, cell))}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )
    )

  return (
    <ScrollArea
      className="flex-1"
      drag={false}
      top={
        <FileToolbar menu={[downloadEntry(download)]} status={statusText(save.status)}>
          <ToolbarLabel>Word document{props.editable ? '' : ' · read only'}</ToolbarLabel>
        </FileToolbar>
      }
      viewportClassName="px-3 pb-8"
    >
      <SaveError error={save.error} />
      <div className="w-full" ref={area}>
        {doc ? (
          <div
            className="mx-auto bg-white text-[#1a1a1a] shadow-card"
            data-testid="docx-page"
            style={{
              fontFamily: 'Calibri, Carlito, "Segoe UI", system-ui, sans-serif',
              minHeight: page.width * 1.29,
              padding: `${page.margin * 0.75}px ${page.margin}px`,
              width: page.width,
              zoom
            }}
          >
            {blocks(doc.blocks)}
          </div>
        ) : pkg ? (
          <Unreadable name={props.name} />
        ) : (
          <p className="m-4 text-[length:var(--text-secondary)] text-muted">
            Opening {props.name}…
          </p>
        )}
      </div>
    </ScrollArea>
  )
}

/* ----------------------------------------------------------------- Excel */

/**
 * An Excel file's sheets as a grid, one tab per sheet. Cells are edited in
 * place, formulas as formulas; their style stays as it was.
 */
export function XlsxView(props: OfficeViewProps) {
  const { changed, download, failed, pkg, revision, save } = useOfficePackage(props, EXCEL)
  const [sheetIndex, setSheetIndex] = useState(0)
  const [locked, setLocked] = useState<null | string>(null)

  const book = useMemo(
    () => (pkg ? readXlsx(pkg) : null),

    [pkg]
  )

  if (failed) {
    return <Unreadable name={props.name} />
  }

  const sheet = book?.sheets[Math.min(sheetIndex, (book?.sheets.length ?? 1) - 1)]

  return (
    <div className="flex h-full min-h-0 flex-col">
      <FileToolbar menu={[downloadEntry(download)]} status={statusText(save.status)}>
        <ToolbarLabel>Excel workbook{props.editable ? '' : ' · read only'}</ToolbarLabel>
      </FileToolbar>
      <SaveError error={save.error ?? locked} />
      {sheet && pkg ? (
        <>
          <div className="min-h-0 flex-1" data-revision={revision}>
            <SheetGrid
              columns={sheet.columns}
              editable={props.editable}
              key={sheet.path}
              onChange={changes => {
                const blocked = changes
                  .map(change => cellLocked(pkg, sheet, change.cell.row, change.cell.col))
                  .find(Boolean)

                if (blocked) {
                  setLocked(blocked)

                  return
                }

                setLocked(null)
                setCells(
                  pkg,
                  sheet,
                  changes.map(change => ({ ...change.cell, value: change.value }))
                )
                changed()
              }}
              onComment={props.onComment}
              onDraft={props.editable ? save.mark : undefined}
              place={book.sheets.length > 1 ? `on ${sheet.name}` : undefined}
              rows={sheet.rows}
              sourceOf={cell => cellSource(pkg, sheet, cell.row, cell.col)}
            />
          </div>
          {book.sheets.length > 1 ? (
            <div
              aria-label="Sheets"
              className="flex gap-1 overflow-x-auto px-3 py-2"
              role="tablist"
            >
              {book.sheets.map((item, index) => (
                <button
                  aria-selected={item === sheet}
                  className={cn(
                    'hex-focus shrink-0 rounded-full px-3 py-1 text-[length:var(--text-meta)] font-medium',
                    item === sheet
                      ? 'bg-foreground text-background'
                      : 'bg-foreground/[0.05] text-muted hover:text-foreground'
                  )}
                  key={item.path}
                  onClick={() => setSheetIndex(index)}
                  role="tab"
                  type="button"
                >
                  {item.name}
                </button>
              ))}
            </div>
          ) : null}
        </>
      ) : pkg ? (
        <Unreadable name={props.name} />
      ) : (
        <p className="m-4 text-[length:var(--text-secondary)] text-muted">Opening {props.name}…</p>
      )}
    </div>
  )
}

/* ------------------------------------------------------------ PowerPoint */

function ShapeText({
  editable,
  onCommit,
  onTyping,
  paragraphs,
  pxPerPt,
  where
}: {
  editable: boolean
  onCommit: (paragraph: PptxParagraph, texts: string[]) => void
  onTyping: () => void
  paragraphs: PptxParagraph[]
  pxPerPt: number
  where: string
}) {
  return (
    <>
      {paragraphs.map(paragraph => (
        <EditableRuns
          baseSize={paragraph.size}
          className={cn(
            'min-h-[1em] leading-[1.2] whitespace-pre-wrap outline-none focus:bg-black/[0.04]',
            paragraph.bullet && 'list-item list-disc'
          )}
          editable={editable}
          key={keyOf(paragraph.element)}
          onCommit={texts => onCommit(paragraph, texts)}
          onTyping={onTyping}
          pxPerPt={pxPerPt}
          runs={paragraph.views}
          style={{
            marginLeft:
              paragraph.bullet || paragraph.level ? `${1.1 + paragraph.level}em` : undefined,
            textAlign: paragraph.align
          }}
          tag="div"
          where={where}
        />
      ))}
    </>
  )
}

function Slide({
  editable,
  height,
  onCommit,
  onTyping,
  slide,
  scale,
  width
}: {
  editable: boolean
  height: number
  onCommit: (slide: PptxSlide, paragraph: PptxParagraph, texts: string[]) => void
  onTyping: () => void
  slide: PptxSlide
  /** CSS px per EMU. */
  scale: number
  width: number
}) {
  const pxPerPt = 12700 * scale
  const where = `slide ${slide.index + 1}`

  const shape = (item: PptxShape) => {
    const box = {
      height: item.h * scale,
      left: item.x * scale,
      top: item.y * scale,
      transform: item.rotation ? `rotate(${item.rotation}deg)` : undefined,
      width: item.w * scale
    }

    if (item.kind === 'picture') {
      return item.src ? (
        <img alt="" className="absolute object-fill" key={item.id} src={item.src} style={box} />
      ) : null
    }

    if (item.kind === 'frame') {
      return (
        <div
          className="absolute grid place-items-center rounded border border-dashed border-black/20 text-[11px] text-black/40"
          key={item.id}
          style={box}
        >
          {item.label}
        </div>
      )
    }

    if (item.kind === 'table') {
      const total = (item.columns ?? []).reduce((sum, value) => sum + value, 0) || 1

      return (
        <table
          className="absolute border-collapse"
          key={item.id}
          style={{ ...box, height: undefined }}
        >
          <tbody>
            {item.cells?.map((row, r) => (
              <tr key={r}>
                {row.map((cell, c) => (
                  <td
                    className="border border-black/25 px-1 align-top"
                    key={c}
                    style={{ width: `${((item.columns?.[c] ?? 0) / total) * 100}%` }}
                  >
                    <ShapeText
                      editable={editable}
                      onCommit={(paragraph, texts) => onCommit(slide, paragraph, texts)}
                      onTyping={onTyping}
                      paragraphs={cell}
                      pxPerPt={pxPerPt}
                      where={where}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )
    }

    const inset = item.inset ?? { b: 45720, l: 91440, r: 91440, t: 45720 }

    return (
      <div
        className={cn(
          'absolute flex flex-col overflow-visible',
          item.anchor === 'middle'
            ? 'justify-center'
            : item.anchor === 'bottom'
              ? 'justify-end'
              : 'justify-start'
        )}
        key={item.id}
        style={{
          ...box,
          background: item.fill,
          border: item.line ? `${Math.max(1, 12700 * scale)}px solid ${item.line}` : undefined,
          borderRadius:
            item.round === 'ellipse'
              ? '50%'
              : item.round === 'rounded'
                ? 8 * scale * 12700
                : undefined,
          padding: `${inset.t * scale}px ${inset.r * scale}px ${inset.b * scale}px ${inset.l * scale}px`
        }}
      >
        <ShapeText
          editable={editable}
          onCommit={(paragraph, texts) => onCommit(slide, paragraph, texts)}
          onTyping={onTyping}
          paragraphs={item.paragraphs ?? []}
          pxPerPt={pxPerPt}
          where={where}
        />
      </div>
    )
  }

  return (
    <figure className="flex flex-col gap-1.5" data-where={where}>
      <figcaption className="text-[length:var(--text-meta)] text-muted tabular-nums">
        {slide.index + 1}
      </figcaption>
      <div
        className="relative overflow-hidden rounded-[6px] text-black shadow-card"
        data-testid="pptx-slide"
        style={{
          background: slide.background,
          fontFamily: 'Calibri, Carlito, "Segoe UI", system-ui, sans-serif',
          height: height * scale,
          width: width * scale
        }}
      >
        {slide.shapes.map(shape)}
      </div>
    </figure>
  )
}

/**
 * A PowerPoint file's slides, one under another, each scaled to the panel.
 * Text in boxes, shapes and tables is edited in place.
 */
export function PptxView(props: OfficeViewProps) {
  const { changed, download, failed, pkg, revision, save } = useOfficePackage(props, POWERPOINT)
  const [width, setWidth] = useState(0)
  const area = useRef<HTMLDivElement>(null)

  const deck = useMemo(
    () => (pkg ? readPptx(pkg) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pkg, revision]
  )

  // The slides are measured once they are drawn.
  const opened = deck !== null

  useEffect(() => {
    const node = area.current

    if (!node) {
      return
    }

    setWidth(node.clientWidth)

    if (typeof ResizeObserver === 'undefined') {
      return
    }

    const observer = new ResizeObserver(() => setWidth(node.clientWidth))
    observer.observe(node)

    return () => observer.disconnect()
  }, [opened])

  if (failed) {
    return <Unreadable name={props.name} />
  }

  const scale = deck && width ? width / deck.width : 0

  return (
    <ScrollArea
      className="flex-1"
      drag={false}
      top={
        <FileToolbar menu={[downloadEntry(download)]} status={statusText(save.status)}>
          <ToolbarLabel>
            {deck
              ? `${deck.slides.length} ${deck.slides.length === 1 ? 'slide' : 'slides'}`
              : 'Presentation'}
            {props.editable ? '' : ' · read only'}
          </ToolbarLabel>
        </FileToolbar>
      }
      viewportClassName="px-4 pb-8"
    >
      <SaveError error={save.error} />
      <div className="flex w-full flex-col gap-5" ref={area}>
        {deck && scale ? (
          deck.slides.map(slide => (
            <Slide
              editable={props.editable}
              height={deck.height}
              key={slide.path}
              onCommit={(item, paragraph, texts) => {
                if (pkg) {
                  setSlideText(pkg, item, paragraph, texts)
                  changed()
                }
              }}
              onTyping={save.mark}
              scale={scale}
              slide={slide}
              width={deck.width}
            />
          ))
        ) : pkg && !deck ? (
          <Unreadable name={props.name} />
        ) : (
          <p className="m-4 text-[length:var(--text-secondary)] text-muted">
            Opening {props.name}…
          </p>
        )}
      </div>
    </ScrollArea>
  )
}
