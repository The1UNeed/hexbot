import { JsonRpcGatewayError } from '@hermes/shared'
import { Download, FileText } from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'

import { ScrollArea } from '../../components/ui/scroll-area'
import { filesRead, filesWrite, filesWriteBytes, type OpenedFile } from '../../lib/api'
import { cn } from '../../lib/cn'
import type { Area } from '../../lib/markup'
import { useBots } from '../../stores/bots'
import { fileCommentsActions, useChatComments } from '../../stores/file-comments'
import { useLiveSessionId } from '../../stores/sections'
import { useTranscript } from '../../stores/transcripts'
import { useUi } from '../../stores/ui'
import { type FileTab, fileTab, visualsActions } from '../../stores/visuals'
import { errorText } from '../bot-settings/shared'
import { DocumentEditor } from '../panel/document-editor'
import { CommentLayer, type CommentTarget, useTextSelection } from '../panel/files/comment-layer'
import { CsvView, type SheetMode } from '../panel/files/csv-view'
import { downloadBlob, downloadEntry, FileToolbar, ViewSwitch } from '../panel/files/file-toolbar'
import { ImageEditor } from '../panel/files/image-editor'
import { DocxView, officeKind, PptxView, XlsxView } from '../panel/files/office-view'

import type { FileTarget } from './shared-files'

/** The bot's tools that change a file; when one finishes, an open file is read again. */
export const FILE_TOOLS = new Set(['edit', 'patch', 'write', 'write_file'])

export { filesOf, type FileTarget, mimeOf, SHARE_FILE_TOOL } from './shared-files'

/**
 * Opens a file in a tab beside the chat, read and saved through the chat's live
 * session. `askable` is false where the user cannot write (a thread between bots).
 */
export function openFile(
  sessionId: string,
  target: FileTarget,
  askable = true,
  sectionId?: null | string
) {
  visualsActions().open(
    fileTab(target.name, {
      askable,
      mime: target.mime,
      path: target.path,
      sectionId: sectionId ?? undefined,
      sessionId,
      url: target.url
    })
  )
}

/** The chat's current live session: a daemon restart gives it a new one. */
function useFileSession(tab: FileTab): string {
  return useLiveSessionId(tab.file.sectionId ?? null) ?? tab.file.sessionId
}

/** Each open file's save, by tab, so closing a tab can save it first. */
const flushes = new Map<string, () => Promise<boolean>>()

/**
 * Closes side tabs, saving each open file first. A file whose edit does not
 * save stays open and is shown, with the editor saying why; nothing is lost.
 */
export async function closeTabs(toolIds: string[]) {
  for (const toolId of toolIds) {
    const flush = flushes.get(toolId)

    // A visual has nothing to save and closes at once.
    if (!flush || (await flush())) {
      visualsActions().close(toolId)
    } else {
      visualsActions().activate(toolId)
    }
  }
}

/** Formatted as a document; any other text opens as plain text. */
const DOCUMENT = /\.(md|markdown|txt)$/i
/** Shown as a page, with its source a click away. */
const PAGE = /\.(html?|svg)$/i
/** Shown as a table. */
const DELIMITED = /\.(csv|tsv)$/i

/**
 * Saves every open file's edit, as a message is about to go, so the bot reads
 * what is on screen. A file whose edit does not save is shown, and false.
 */
export async function flushOpenFiles(): Promise<boolean> {
  for (const [toolId, flush] of flushes) {
    if (!(await flush())) {
      visualsActions().activate(toolId)

      return false
    }
  }

  return true
}

function useOpenedFile(tab: FileTab, sessionId: string) {
  const { path, url } = tab.file
  const transcript = useTranscript(sessionId)
  const working = Boolean(transcript?.streamingMessageId)

  // Each finished edit the bot makes reads the file again, so its changes appear as they land.
  const edits = useMemo(
    () =>
      (transcript?.messages ?? []).reduce(
        (count, message) =>
          count +
          message.toolCalls.filter(call => FILE_TOOLS.has(call.name) && call.status === 'ok')
            .length,
        0
      ),
    [transcript?.messages]
  )

  const [file, setFile] = useState<null | OpenedFile>(null)
  const [error, setError] = useState<null | string>(null)
  const [updated, setUpdated] = useState(false)
  // The bot changed a text file shown in the editor so it can no longer be
  // edited here (too large, or no longer text). The editor, and any edit in it,
  // stays until the user loads the new version.
  const [outgrown, setOutgrown] = useState(false)
  const editable = useRef(false)
  // The version last shown; a later read with another one is the bot's edit.
  const shownVersion = useRef<null | string>(null)
  // Counts the user's own saves: a read that started before one is older than
  // what the daemon holds now, and its answer is dropped.
  const saves = useRef(0)

  useEffect(() => {
    if (!path) {
      setFile(
        url
          ? {
              data_url: url,
              mime: tab.file.mime,
              modified: 0,
              name: tab.title,
              path: '',
              size: 0,
              version: ''
            }
          : null
      )

      return
    }

    let current = true
    const started = saves.current
    const fresh = () => current && started === saves.current

    filesRead(sessionId, path)
      .then(next => {
        if (!fresh()) {
          return
        }

        if (editable.current && next.text === undefined) {
          setOutgrown(true)

          return
        }

        if (shownVersion.current !== null && shownVersion.current !== next.version) {
          setUpdated(true)
        }

        shownVersion.current = next.version
        editable.current = next.text !== undefined
        setFile(next)
        setError(null)
      })
      .catch((cause: unknown) => fresh() && setError(errorText(cause)))

    return () => {
      current = false
    }
  }, [edits, path, sessionId, tab.file.mime, tab.title, url, working])

  useEffect(() => {
    if (!updated) {
      return
    }

    const timer = window.setTimeout(() => setUpdated(false), 2500)

    return () => window.clearTimeout(timer)
  }, [updated, file?.version])

  /** The user's own save: its new version is not the bot's edit. */
  const saved = (text: string, version: string, modified: number, size: number) => {
    saves.current += 1
    shownVersion.current = version
    setFile(current => (current ? { ...current, modified, size, text, version } : current))
  }

  /** A version read on purpose (the user chose it), shown without the "Updated" flag. */
  const adopt = (next: OpenedFile) => {
    saves.current += 1
    shownVersion.current = next.version
    editable.current = next.text !== undefined
    setOutgrown(false)
    setFile(next)
  }

  /** The user's own save of a picture or Office file, whole. */
  const savedBytes = (dataUrl: string, version: string, modified: number, size: number) => {
    saves.current += 1
    shownVersion.current = version
    setFile(current =>
      current ? { ...current, data_url: dataUrl, modified, size, version } : current
    )
  }

  return { adopt, error, file, outgrown, saved, savedBytes, updated, working }
}

/**
 * A base64 data URL as a Blob, decoded here: the app's CSP lets the page fetch
 * only http(s) and websockets, so `fetch('data:…')` is refused in Electron.
 */
export function blobFromDataUrl(dataUrl: string): Blob | null {
  const match = /^data:([^;,]*)(?:;[^,]*)?;base64,(.*)$/s.exec(dataUrl)

  if (!match) {
    return null
  }

  const binary = atob(match[2]!)
  const bytes = new Uint8Array(binary.length)

  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index)
  }

  return new Blob([bytes], { type: match[1] || 'application/octet-stream' })
}

/** An object URL the panel can frame or download; PDFs need one to open in a frame. */
function useObjectUrl(dataUrl?: string): string | undefined {
  const [url, setUrl] = useState<string>()

  useEffect(() => {
    if (!dataUrl?.startsWith('data:')) {
      setUrl(dataUrl)

      return
    }

    const blob = blobFromDataUrl(dataUrl)
    const made = blob ? URL.createObjectURL(blob) : undefined
    setUrl(made)

    return () => {
      if (made) {
        URL.revokeObjectURL(made)
      }
    }
  }, [dataUrl])

  return url
}

/** A web page or SVG file as it looks, in a frame that runs none of its scripts. */
function PagePreview({ name, text }: { name: string; text: string }) {
  const svg = /\.svg$/i.test(name)

  const url = useMemo(
    () => URL.createObjectURL(new Blob([text], { type: svg ? 'image/svg+xml' : 'text/html' })),
    [svg, text]
  )

  useEffect(() => () => URL.revokeObjectURL(url), [url])

  return svg ? (
    <img
      alt={name}
      className="mx-auto max-h-full max-w-full rounded-[12px] bg-white p-2"
      src={url}
    />
  ) : (
    <iframe
      className="h-full min-h-[60vh] w-full rounded-[12px] bg-white"
      sandbox=""
      src={url}
      title={name}
    />
  )
}

/**
 * A file beside the chat, shown and edited the way its kind wants: text in
 * the editor; CSV and TSV as a table; web pages and SVG rendered with their
 * source a click away; pictures marked up; Word, Excel and PowerPoint files
 * as pages, sheets and slides with their text edited in place. Each edit
 * saves a moment later, against the version it started from, so it never
 * overwrites the bot's. Selecting text, cells or an area of a picture leaves
 * a comment that goes with the next message. PDFs, video and audio show or
 * play; anything else offers a download.
 */
export function FileTabView({ shown, tab }: { shown: boolean; tab: FileTab }) {
  const selected = useUi(state => state.lastSection)

  const botName = useBots(state =>
    selected?.bot ? (state.byName[selected.bot]?.display_name ?? 'The bot') : 'The bot'
  )

  const sessionId = useFileSession(tab)
  const { adopt, error, file, outgrown, saved, savedBytes, updated } = useOpenedFile(tab, sessionId)
  const objectUrl = useObjectUrl(file?.data_url)
  // The version the editor's text is based on. A refresh moves it only when the
  // editor takes the new text; while it holds an unsaved edit, a save names the
  // version that edit started from, so it cannot overwrite the bot's change.
  const latest = useRef(file)
  latest.current = file
  // Versions are content hashes, so the bot rewriting the file unchanged keeps it.
  const base = useRef<null | string>(null)

  if (base.current === null && file) {
    base.current = file.version
  }

  // The editor's save: a message to the bot waits for the edit on screen to land first.
  const flush = useRef<(() => Promise<boolean>) | null>(null)
  // Set when a save was refused because the bot changed the file. The edit stays
  // in the editor until the user chooses the bot's version, which mounts a fresh
  // editor; the old one's last save is then ignored.
  const [conflict, setConflict] = useState(false)
  const [loadError, setLoadError] = useState<null | string>(null)
  const [edition, setEdition] = useState(0)
  const editionRef = useRef(0)
  const [sheetMode, setSheetMode] = useState<SheetMode>('table')
  const [pageMode, setPageMode] = useState<'preview' | 'source'>('preview')

  // Comments go to the chat the file was opened from.
  const askable = tab.file.askable !== false
  const chat = tab.file.sectionId ?? selected?.section ?? sessionId
  const panel = useRef<HTMLDivElement>(null)
  const [target, setTarget] = useTextSelection(panel, askable && shown)
  const [commentOpen, setCommentOpen] = useState(false)
  const [commentArea, setCommentArea] = useState<Area | null>(null)
  const name = tab.title
  const path = tab.file.path
  const text = file?.text
  const plain = !DOCUMENT.test(name)
  const mime = file?.mime ?? tab.file.mime

  const fileComments = useChatComments(chat).filter(comment => comment.tab === tab.toolId)

  const openComment = (next: CommentTarget, open: boolean, area: Area | null = null) => {
    setCommentArea(area)
    setCommentOpen(open)
    setTarget(next)
  }

  const closeComment = () => {
    setTarget(null)
    setCommentArea(null)
  }

  const comment = askable
    ? (next: CommentTarget, open: boolean) => openComment(next, open)
    : undefined

  // Reads the file as it is now (the change may not have come from the bot's
  // steps), then shows it in a fresh editor. If the read fails, the edit stays.
  const loadTheirs = async () => {
    if (!path) {
      return
    }

    try {
      const current = await filesRead(sessionId, path)
      editionRef.current += 1
      base.current = current.version
      adopt(current)
      setConflict(false)
      setLoadError(null)
      setEdition(editionRef.current)
    } catch (cause) {
      setLoadError(errorText(cause))
    }
  }

  useEffect(() => {
    flushes.set(tab.toolId, () => flush.current?.() ?? Promise.resolve(true))

    return () => {
      flushes.delete(tab.toolId)
    }
  }, [tab.toolId])

  const refused = (cause: unknown): never => {
    if (cause instanceof JsonRpcGatewayError && cause.code === 4209) {
      setConflict(true)

      throw new Error(
        `${botName} changed this file while you edited it, so your edit was not saved.`
      )
    }

    throw cause
  }

  // The editor this render shows. One the user replaced with the bot's
  // version saves nothing, not even the edit it held when it went.
  const mine = edition

  /** An editor took on the file as it is now, at this version (or the latest read). */
  const follow = (version?: string) => {
    base.current = version ?? latest.current?.version ?? base.current
  }

  /** Saves the text on screen, against the version it started from. */
  const saveText = async (next: string) => {
    if (!path || !file || mine !== editionRef.current) {
      return
    }

    const own = editionRef.current

    try {
      const result = await filesWrite(sessionId, path, next, base.current ?? file.version)

      if (own !== editionRef.current) {
        return
      }

      base.current = result.version
      saved(next, result.version, result.modified, result.size)
    } catch (cause) {
      refused(cause)
    }
  }

  /** Saves a picture or Office file whole; answers its new version. */
  const saveBytes = async (dataUrl: string): Promise<string> => {
    if (!path || !file) {
      throw new Error('This file cannot be saved here.')
    }

    if (mine !== editionRef.current) {
      return base.current ?? file.version
    }

    try {
      const result = await filesWriteBytes(sessionId, path, dataUrl, base.current ?? file.version)
      base.current = result.version
      savedBytes(dataUrl, result.version, result.modified, result.size)

      return result.version
    } catch (cause) {
      return refused(cause)
    }
  }

  const banner =
    conflict || outgrown ? (
      <div className="mx-3 mt-2 flex items-center gap-2 rounded-[12px] bg-foreground/[0.05] px-3 py-2 text-[length:var(--text-meta)]">
        <span className="min-w-0 flex-1 text-muted">
          {loadError ??
            (outgrown
              ? `${botName} changed this file, and it can no longer be edited here. Copy your edit if you want to keep it.`
              : 'Copy your edit if you want to keep it.')}
        </span>
        <button
          className="hex-focus shrink-0 rounded-full bg-foreground px-2.5 py-1 font-medium text-background"
          onClick={() => void loadTheirs()}
          type="button"
        >
          Load {botName}'s version
        </button>
      </div>
    ) : null

  const editor = (label?: ReactNode) =>
    text !== undefined && path && file ? (
      <DocumentEditor
        fileName={name}
        flushRef={flush}
        inline
        key={`${path}:${edition}`}
        label={label}
        onClose={() => undefined}
        onFollow={() => follow()}
        onSave={saveText}
        plain={plain}
        title={name}
        value={text}
      />
    ) : null

  // Another view of the file opens once the edit on screen is saved; one that
  // does not save stays, saying why.
  const switchView = (show: () => void) =>
    void (flush.current?.() ?? Promise.resolve(true)).then(ok => ok && show())

  let body: ReactNode
  // Content with its own bar fills the panel; the rest scrolls in a plain one.
  let own = true

  if (error && !file) {
    own = false
    body = (
      <p
        className="m-4 rounded-[12px] bg-danger/10 px-3.5 py-2.5 text-[length:var(--text-secondary)] text-danger"
        role="alert"
      >
        {error}
      </p>
    )
  } else if (!file) {
    own = false
    body = <p className="m-4 text-[length:var(--text-secondary)] text-muted">Opening {name}…</p>
  } else if (text !== undefined && path) {
    if (DELIMITED.test(name)) {
      const switcher = (
        <ViewSwitch
          onChange={mode => switchView(() => setSheetMode(mode))}
          options={[
            { label: 'Table', value: 'table' },
            { label: 'Text', value: 'text' }
          ]}
          value={sheetMode}
        />
      )

      body =
        sheetMode === 'table' ? (
          <CsvView
            delimiter={/\.tsv$/i.test(name) ? '\t' : ','}
            editable
            flushRef={flush}
            key={`${path}:${edition}`}
            name={name}
            onComment={comment}
            onFollow={() => follow()}
            onMode={setSheetMode}
            onSave={saveText}
            text={text}
          />
        ) : (
          editor(switcher)
        )
    } else if (PAGE.test(name)) {
      const switcher = (
        <ViewSwitch
          onChange={mode => switchView(() => setPageMode(mode))}
          options={[
            { label: 'Preview', value: 'preview' },
            { label: 'Source', value: 'source' }
          ]}
          value={pageMode}
        />
      )

      body =
        pageMode === 'preview' ? (
          <div className="flex h-full min-h-0 flex-col">
            <FileToolbar
              menu={[downloadEntry(() => downloadBlob(name, new Blob([text], { type: mime })))]}
            >
              {switcher}
            </FileToolbar>
            <div className="min-h-0 flex-1 overflow-auto px-3 pb-3">
              <PagePreview name={name} text={text} />
            </div>
          </div>
        ) : (
          editor(switcher)
        )
    } else {
      body = editor()
    }
  } else if (file.data_url && officeKind(name, mime)) {
    const kind = officeKind(name, mime)

    const props = {
      editable: Boolean(path),
      file: { ...file, data_url: file.data_url },
      flushRef: flush,
      name,
      onComment: comment,
      onFollow: follow,
      onSave: saveBytes
    }

    body =
      kind === 'docx' ? (
        <DocxView key={`${path}:${edition}`} {...props} />
      ) : kind === 'xlsx' ? (
        <XlsxView key={`${path}:${edition}`} {...props} />
      ) : (
        <PptxView key={`${path}:${edition}`} {...props} />
      )
  } else if (mime.startsWith('image/') && mime !== 'image/svg+xml' && file.data_url) {
    body = (
      <ImageEditor
        botName={botName}
        comments={fileComments}
        editable={Boolean(path)}
        flushRef={flush}
        key={`${path ?? tab.toolId}:${edition}`}
        mime={mime}
        name={name}
        onAttach={askable && chat ? next => fileCommentsActions().attach(chat, next) : undefined}
        onComment={askable ? (next, area) => openComment(next, true, area) : undefined}
        onFollow={follow}
        onSave={saveBytes}
        // The picture and its version come together, from the same read.
        src={file.data_url}
        version={file.version}
      />
    )
  } else if (mime === 'application/pdf' && objectUrl) {
    own = false
    body = <iframe className="h-full w-full rounded-[12px] bg-white" src={objectUrl} title={name} />
  } else if (mime.startsWith('video/') && objectUrl) {
    own = false
    body = (
      <video
        aria-label={name}
        className="mx-auto max-h-full max-w-full rounded-[12px] bg-black"
        controls
        playsInline
        src={objectUrl}
      />
    )
  } else if (mime.startsWith('audio/') && objectUrl) {
    own = false
    body = (
      <div className="grid h-full place-items-center p-4">
        <audio aria-label={name} className="w-full max-w-md" controls src={objectUrl} />
      </div>
    )
  } else {
    own = false
    body = (
      <div className="m-4 grid place-items-center gap-3 rounded-[16px] bg-foreground/[0.04] px-5 py-10 text-center">
        <FileText className="text-muted" size={22} />
        <p className="text-[length:var(--text-secondary)] text-muted">
          No preview for this file. {botName} can still read it.
        </p>
        {objectUrl ? (
          <a
            className="hex-focus inline-flex items-center gap-1.5 rounded-full bg-foreground/[0.06] px-3 py-1.5 text-[length:var(--text-secondary)] font-medium hover:bg-foreground/[0.1]"
            download={name}
            href={objectUrl}
          >
            <Download size={14} />
            Download
          </a>
        ) : null}
      </div>
    )
  }

  return (
    <div
      aria-labelledby={`visual-tab-${tab.toolId}`}
      className={cn('relative h-full min-h-0 flex-col', shown ? 'flex' : 'hidden')}
      id={`visual-tabpanel-${tab.toolId}`}
      ref={panel}
      role="tabpanel"
    >
      {error && file ? (
        <p
          className="mx-3 mt-2 rounded-[12px] bg-danger/10 px-3 py-2 text-[length:var(--text-meta)] text-danger"
          role="alert"
        >
          {error}
        </p>
      ) : null}
      {banner}
      {updated ? (
        <span className="hex-fade pointer-events-none absolute top-14 right-4 z-10 rounded-full bg-info/12 px-2.5 py-1 text-[length:var(--text-meta)] font-medium text-info">
          Updated by {botName}
        </span>
      ) : null}
      {own ? (
        <div className="flex min-h-0 flex-1 flex-col">{body}</div>
      ) : (
        <ScrollArea className="flex-1" viewportClassName="overflow-auto p-1">
          {body}
        </ScrollArea>
      )}
      {askable && chat ? (
        <CommentLayer
          botName={botName}
          onAdd={note => {
            fileCommentsActions().add(chat, {
              area: commentArea ?? undefined,
              name,
              note,
              // As the daemon resolved it, so the message's file tag opens it.
              path: file?.path || path,
              quote: target?.quote,
              tab: tab.toolId,
              where: target?.where
            })
            closeComment()
          }}
          onClose={closeComment}
          open={commentOpen}
          target={target}
        />
      ) : null}
    </div>
  )
}
