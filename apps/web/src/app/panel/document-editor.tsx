import Placeholder from '@tiptap/extension-placeholder'
import { Markdown } from '@tiptap/markdown'
import { type Editor, EditorContent, useEditor, useEditorState } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import {
  Bold,
  Code,
  Copy,
  Download,
  FileText,
  Italic,
  List,
  ListOrdered,
  MoreHorizontal,
  X
} from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { Menu } from '../../components/ui/menu'
import { cn } from '../../lib/cn'
import { errorText } from '../bot-settings/shared'

/** How long typing must pause before the file is saved. */
const SAVE_DELAY = 800

type SaveState = 'error' | 'idle' | 'saved' | 'saving'

const words = (text: string) => (text.match(/[\p{L}\p{N}]+/gu) ?? []).join(' ')

/**
 * Whether the formatted view would lose part of the file: a table, or words
 * (an image's address, raw HTML) the editor drops when it writes it back.
 * Such a file is edited as source only.
 */
export function loses(original: string, formatted: string): boolean {
  return /^\s*\|.*\|\s*$/m.test(original) || words(original) !== words(formatted)
}

export interface DocumentEditorProps {
  /** What the file is, above it and not part of it. */
  about: ReactNode
  /** Characters the file may hold; the daemon refuses more. */
  cap?: number
  /** The file name, for downloads and the PDF title. */
  fileName: string
  onClose: () => void
  onSave: (text: string) => Promise<void>
  title: string
  value: string
}

const toolClass =
  'hex-focus grid h-8 min-w-8 place-items-center rounded-[9px] px-1.5 text-[13px] font-semibold text-muted transition-colors duration-[var(--hex-motion-fast)] hover:bg-foreground/[0.06] hover:text-foreground disabled:pointer-events-none disabled:opacity-40 aria-pressed:bg-foreground/[0.08] aria-pressed:text-foreground'

function Tool({
  active,
  children,
  disabled,
  label,
  onClick
}: {
  active: boolean
  children: ReactNode
  disabled: boolean
  label: string
  onClick: () => void
}) {
  return (
    <button
      aria-label={label}
      aria-pressed={active}
      className={toolClass}
      disabled={disabled}
      onClick={onClick}
      // Keep the selection in the editor while the toolbar is used.
      onMouseDown={event => event.preventDefault()}
      title={label}
      type="button"
    >
      {children}
    </button>
  )
}

function Toolbar({ disabled, editor }: { disabled: boolean; editor: Editor }) {
  const state = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      bold: current.isActive('bold'),
      bullet: current.isActive('bulletList'),
      h1: current.isActive('heading', { level: 1 }),
      h2: current.isActive('heading', { level: 2 }),
      h3: current.isActive('heading', { level: 3 }),
      italic: current.isActive('italic'),
      ordered: current.isActive('orderedList')
    })
  })

  const chain = () => editor.chain().focus()
  const divider = <span aria-hidden className="mx-1.5 h-4 w-px bg-foreground/[0.1]" />

  return (
    <div aria-label="Formatting" className="flex items-center gap-0.5" role="toolbar">
      <Tool
        active={state.bold}
        disabled={disabled}
        label="Bold"
        onClick={() => chain().toggleBold().run()}
      >
        <Bold size={15} strokeWidth={2.4} />
      </Tool>
      <Tool
        active={state.italic}
        disabled={disabled}
        label="Italic"
        onClick={() => chain().toggleItalic().run()}
      >
        <Italic size={15} />
      </Tool>
      {divider}
      {([1, 2, 3] as const).map(level => (
        <Tool
          active={state[`h${level}`]}
          disabled={disabled}
          key={level}
          label={`Heading ${level}`}
          onClick={() => chain().toggleHeading({ level }).run()}
        >
          H{level}
        </Tool>
      ))}
      {divider}
      <Tool
        active={state.bullet}
        disabled={disabled}
        label="Bulleted list"
        onClick={() => chain().toggleBulletList().run()}
      >
        <List size={16} />
      </Tool>
      <Tool
        active={state.ordered}
        disabled={disabled}
        label="Numbered list"
        onClick={() => chain().toggleOrderedList().run()}
      >
        <ListOrdered size={16} />
      </Tool>
    </div>
  )
}

function download(name: string, text: string) {
  const link = document.createElement('a')
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }))

  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"]/g,
    char => ({ '"': '&quot;', '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char]!
  )

/**
 * Prints the formatted file from a frame of its own, so the system print
 * dialog offers it alone; Save as PDF is one of its choices on every system.
 */
function printDocument(title: string, html: string) {
  const frame = document.createElement('iframe')

  frame.setAttribute('aria-hidden', 'true')
  frame.style.cssText = 'position:fixed;width:0;height:0;border:0;opacity:0'
  document.body.append(frame)

  const page = frame.contentDocument

  if (!page || !frame.contentWindow) {
    frame.remove()

    return
  }

  page.open()
  page.write(
    `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>
      body{font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#111;max-width:42rem;margin:2.5rem auto;padding:0 1.5rem}
      h1{font-size:1.9em;margin:1.2em 0 .4em}h2{font-size:1.4em;margin:1.1em 0 .4em}h3{font-size:1.15em;margin:1em 0 .3em}
      p,ul,ol,blockquote{margin:.6em 0}ul,ol{padding-left:1.4em}blockquote{border-left:2px solid #ccc;margin-left:0;padding-left:1em;color:#555}
      code{font-family:ui-monospace,Menlo,monospace;font-size:.9em}pre{background:#f4f4f4;padding:.8em;border-radius:6px;white-space:pre-wrap}
    </style></head><body>${html}</body></html>`
  )
  page.close()
  frame.contentWindow.focus()
  frame.contentWindow.print()
  // Printing blocks until the dialog closes in most browsers; give the rest a moment.
  setTimeout(() => frame.remove(), 1000)
}

/**
 * A soul or memory file, full window: formatted, edited in place with a few
 * tools, and saved a moment after typing stops and when it closes. The menu
 * shows the Markdown source, copies it, or saves it as Markdown or PDF.
 */
export function DocumentEditor({
  about,
  cap,
  fileName,
  onClose,
  onSave,
  title,
  value
}: DocumentEditorProps) {
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [error, setError] = useState<null | string>(null)
  const [length, setLength] = useState(value.length)
  const [copied, setCopied] = useState(false)
  // Set by typing in either view; opening or switching views alone saves nothing.
  const edited = useRef(false)
  const saved = useRef(value)
  const timer = useRef<number>(undefined)

  const editor = useEditor({
    autofocus: 'end',
    content: value,
    contentType: 'markdown',
    editorProps: { attributes: { 'aria-label': title, class: 'hex-document outline-none' } },
    extensions: [
      StarterKit.configure({ underline: false }),
      Markdown,
      Placeholder.configure({ placeholder: 'Nothing written yet. Start typing.' })
    ],
    immediatelyRender: true,
    onUpdate: ({ editor: updated, transaction }) => {
      // Focusing sends an update too; only a changed document is an edit.
      if (!transaction.docChanged) {
        return
      }

      edited.current = true
      setLength(updated.getMarkdown().length)
      schedule()
    }
  })

  // Computed once, as the file opens: a file the formatted view would damage opens as source.
  const [sourceOnly] = useState(() => loses(value, editor.getMarkdown()))
  const [source, setSource] = useState<null | string>(sourceOnly ? value : null)
  // The source text as it was shown, to tell whether switching back needs to reload the editor.
  const shownSource = useRef(source)

  // Until something is edited, the file is its own text, not the editor's rewrite of it.
  const current = useCallback(
    () => (source !== null ? source : edited.current ? editor.getMarkdown() : saved.current),
    [editor, source]
  )

  const write = useCallback(async () => {
    const text = current()

    if (!edited.current || text === saved.current) {
      return true
    }

    setSaveState('saving')

    try {
      await onSave(text)
      saved.current = text
      setError(null)
      setSaveState('saved')

      return true
    } catch (cause) {
      setError(errorText(cause))
      setSaveState('error')

      return false
    }
  }, [current, onSave])

  // Saves run one after another, each reading the draft when its turn comes, so an
  // earlier save cannot land after a later one.
  const queue = useRef(Promise.resolve(true))
  const writeRef = useRef(write)
  writeRef.current = write

  /** Saves an edit; false when the daemon refused it, so closing keeps the draft. */
  const save = useCallback(() => {
    window.clearTimeout(timer.current)
    queue.current = queue.current.then(() => writeRef.current())

    return queue.current
  }, [])

  const saveRef = useRef(save)

  function schedule() {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => void saveRef.current(), SAVE_DELAY)
  }

  // The bot may change the file while it is open; an untouched editor follows.
  useEffect(() => {
    if (value === saved.current || edited.current) {
      return
    }

    if (source !== null) {
      setSource(value)
      shownSource.current = value
    } else {
      editor.commands.setContent(value, { contentType: 'markdown', emitUpdate: false })
    }

    saved.current = value
    setLength(value.length)
  }, [editor, source, value])

  const close = useCallback(async () => {
    if (await saveRef.current()) {
      onClose()
    }
  }, [onClose])

  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault()
        void close()
      } else if (event.key === 's' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        void saveRef.current()
      }
    }

    window.addEventListener('keydown', keys)

    return () => window.removeEventListener('keydown', keys)
  }, [close])

  useEffect(() => () => window.clearTimeout(timer.current), [])

  const toggleSource = () => {
    if (source === null) {
      const text = current()
      shownSource.current = text
      setSource(text)

      return
    }

    if (source !== shownSource.current) {
      editor.commands.setContent(source, { contentType: 'markdown', emitUpdate: false })
    }

    setSource(null)
  }

  const copy = async () => {
    await navigator.clipboard.writeText(current())
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const item = (icon: ReactNode, label: string) => (
    <span className="flex items-center gap-2.5">
      <span className="text-muted">{icon}</span>
      {label}
    </span>
  )

  const over = cap !== undefined && length > cap

  const status = copied
    ? 'Copied'
    : saveState === 'saving'
      ? 'Saving…'
      : saveState === 'saved'
        ? 'Saved'
        : ''

  return createPortal(
    <div
      aria-label={title}
      aria-modal="true"
      className="hex-fade fixed inset-0 z-50 flex flex-col bg-background"
      data-testid="document-editor"
      role="dialog"
    >
      <header className="hex-drag grid h-12 shrink-0 grid-cols-[1fr_auto_1fr] items-center border-b border-foreground/[0.07] px-3">
        <span className="truncate pl-[72px] text-[length:var(--text-secondary)] font-medium text-muted">
          {title}
        </span>
        <div className="hex-no-drag">
          <Toolbar disabled={source !== null} editor={editor} />
        </div>
        <div className="hex-no-drag flex items-center justify-end gap-1">
          {cap !== undefined ? (
            <span
              className={cn(
                'mr-1 text-[length:var(--text-meta)] tabular-nums',
                over ? 'text-danger' : 'text-muted'
              )}
            >
              {length.toLocaleString()} / {cap.toLocaleString()}
            </span>
          ) : null}
          <span aria-live="polite" className="mr-1 text-[length:var(--text-meta)] text-muted">
            {status}
          </span>
          <Menu
            items={[
              {
                label: item(
                  source === null ? <Code size={14} /> : <FileText size={14} />,
                  source === null ? 'View source' : 'View formatted'
                ),
                disabled: sourceOnly,
                onSelect: toggleSource
              },
              { label: '', separator: true },
              { label: item(<Copy size={14} />, 'Copy'), onSelect: () => void copy() },
              {
                label: item(<Download size={14} />, 'Download'),
                onSelect: () => download(fileName, current())
              },
              {
                label: item(<FileText size={14} />, 'Download as PDF'),
                onSelect: () => {
                  if (source !== null) {
                    editor.commands.setContent(source, {
                      contentType: 'markdown',
                      emitUpdate: false
                    })
                  }

                  printDocument(title, editor.getHTML())
                }
              }
            ]}
            trigger={
              <button aria-label="More" className={toolClass} type="button">
                <MoreHorizontal size={16} />
              </button>
            }
          />
          <button
            aria-label="Close"
            className={toolClass}
            onClick={() => void close()}
            type="button"
          >
            <X size={16} />
          </button>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[46rem] px-8 pt-10 pb-24">
          <blockquote className="mb-9 border-l-2 border-foreground/15 pl-4 text-[length:var(--text-secondary)] leading-relaxed text-foreground/75 italic">
            {about}
          </blockquote>
          {error ? (
            <p
              className="mb-5 rounded-[12px] bg-danger/10 px-3.5 py-2.5 text-[length:var(--text-secondary)] text-danger"
              role="alert"
            >
              {error}
            </p>
          ) : null}
          {sourceOnly ? (
            <p className="mb-5 text-[length:var(--text-secondary)] text-muted">
              This file has a table, image or HTML that the formatted view would drop, so it opens
              as Markdown.
            </p>
          ) : null}
          {source !== null ? (
            <textarea
              aria-label={`${title} source`}
              className="min-h-[60vh] w-full resize-none bg-transparent font-mono text-[13px] leading-relaxed text-foreground outline-none"
              onChange={event => {
                edited.current = true
                setSource(event.target.value)
                setLength(event.target.value.length)
                schedule()
              }}
              spellCheck={false}
              value={source}
            />
          ) : (
            <EditorContent editor={editor} />
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
