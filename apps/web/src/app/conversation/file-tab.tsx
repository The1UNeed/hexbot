import { JsonRpcGatewayError } from '@hermes/shared'
import { ArrowUp, Download, FileText } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { filesRead, filesWrite, type OpenedFile } from '../../lib/api'
import { cn } from '../../lib/cn'
import { useBots } from '../../stores/bots'
import { useLiveSessionId } from '../../stores/sections'
import { useTranscript } from '../../stores/transcripts'
import { useUi } from '../../stores/ui'
import { type FileTab, fileTab, visualsActions } from '../../stores/visuals'
import { errorText } from '../bot-settings/shared'
import { DocumentEditor } from '../panel/document-editor'

import type { FileTarget } from './shared-files'

import { sendText } from './index'

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

interface Quick {
  label: string
  /** What the message asks, before the file is named. */
  ask: string
}

const DOCUMENT_TOOLS: Quick[] = [
  { ask: 'Polish the writing in', label: 'Polish' },
  { ask: 'Shorten', label: 'Shorten' },
  { ask: 'Expand', label: 'Make longer' },
  { ask: 'Fix the spelling and grammar in', label: 'Fix mistakes' }
]

const PLAIN_TOOLS: Quick[] = [
  { ask: 'Fix the bugs in', label: 'Fix bugs' },
  { ask: 'Add short, helpful comments to', label: 'Add comments' },
  { ask: 'Tidy up the formatting of', label: 'Tidy up' }
]

/** The message a quick tool or the ask field sends, naming the file so the bot edits that one. */
export function editRequest(ask: string, name: string, path?: string, editable = true): string {
  if (!path) {
    return `${ask}\n\nThis is about ${name}.`
  }

  return editable ? `${ask}\n\nEdit the file in place: \`${path}\`` : `${ask}\n\nFile: \`${path}\``
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

  return { adopt, error, file, outgrown, saved, updated, working }
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

function QuickTools({
  botName,
  disabled,
  name,
  onSend,
  tools
}: {
  botName: string
  disabled: boolean
  /** The file, named in each quick tool's message. */
  name: string
  onSend: (ask: string) => Promise<void>
  tools: Quick[]
}) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const off = disabled || sending

  const send = async (ask: string) => {
    if (!ask.trim() || off) {
      return
    }

    setSending(true)

    try {
      await onSend(ask.trim())
      setText('')
    } catch {
      // Not sent: the request stays in the field, and the editor shows why.
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="shrink-0 border-t border-foreground/[0.07] px-3 pt-2.5 pb-3">
      {tools.length ? (
        <div aria-label="Quick tools" className="mb-2 flex flex-wrap gap-1.5" role="group">
          {tools.map(tool => (
            <button
              className="hex-focus rounded-full bg-foreground/[0.05] px-2.5 py-1 text-[length:var(--text-meta)] font-medium text-foreground transition-colors duration-[var(--hex-motion-fast)] hover:bg-foreground/[0.09] disabled:opacity-40"
              disabled={off}
              key={tool.label}
              onClick={() => void send(`${tool.ask} ${name}.`)}
              type="button"
            >
              {tool.label}
            </button>
          ))}
        </div>
      ) : null}
      <form
        className="flex items-center gap-1.5 rounded-full bg-foreground/[0.05] py-1 pr-1 pl-3.5"
        onSubmit={event => {
          event.preventDefault()
          void send(text)
        }}
      >
        <input
          aria-label={`Ask ${botName} about this file`}
          className="min-w-0 flex-1 bg-transparent text-[length:var(--text-secondary)] text-foreground outline-none placeholder:text-muted disabled:opacity-50"
          disabled={off}
          onChange={event => setText(event.target.value)}
          placeholder={disabled ? `${botName} is working…` : `Ask ${botName} to change this`}
          value={text}
        />
        <button
          aria-label={`Ask ${botName}`}
          className={cn(
            'grid size-7 shrink-0 place-items-center rounded-full transition-colors',
            text.trim() && !off ? 'bg-foreground text-background' : 'text-muted'
          )}
          disabled={!text.trim() || off}
          type="submit"
        >
          <ArrowUp size={14} strokeWidth={2.5} />
        </button>
      </form>
    </div>
  )
}

/**
 * A file beside the chat. Text opens in the editor, saved as it is typed; the
 * quick tools ask the bot to change it, and each edit the bot makes shows as
 * it lands. A PDF opens in the viewer, a picture, video or audio file shows or
 * plays; anything else offers a download.
 */
export function FileTabView({ shown, tab }: { shown: boolean; tab: FileTab }) {
  const selected = useUi(state => state.lastSection)

  const botName = useBots(state =>
    selected?.bot ? (state.byName[selected.bot]?.display_name ?? 'The bot') : 'The bot'
  )

  const sessionId = useFileSession(tab)
  const { adopt, error, file, outgrown, saved, updated, working } = useOpenedFile(tab, sessionId)
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

  // The editor's save: a request to the bot waits for the edit on screen to land first.
  const flush = useRef<(() => Promise<boolean>) | null>(null)
  // Set when a save was refused because the bot changed the file. The edit stays
  // in the editor until the user chooses the bot's version, which mounts a fresh
  // editor; the old one's last save is then ignored.
  const [conflict, setConflict] = useState(false)
  const [loadError, setLoadError] = useState<null | string>(null)
  const [edition, setEdition] = useState(0)
  const editionRef = useRef(0)

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

  const name = tab.title
  const path = tab.file.path
  const text = file?.text
  const plain = !DOCUMENT.test(name)
  const mime = file?.mime ?? tab.file.mime

  const ask = async (request: string) => {
    if (flush.current && !(await flush.current())) {
      // The editor says why the edit did not save; nothing is sent on stale text.
      throw new Error('the edit on screen did not save')
    }

    await sendText(
      sessionId,
      tab.file.sectionId ?? selected?.section ?? null,
      editRequest(request, name, path, text !== undefined)
    )
  }

  const tools =
    tab.file.askable === false ? null : (
      <QuickTools
        botName={botName}
        disabled={working}
        name={name}
        onSend={ask}
        tools={text === undefined ? [] : plain ? PLAIN_TOOLS : DOCUMENT_TOOLS}
      />
    )

  let body: React.ReactNode

  if (error && !file) {
    body = (
      <p
        className="m-4 rounded-[12px] bg-danger/10 px-3.5 py-2.5 text-[length:var(--text-secondary)] text-danger"
        role="alert"
      >
        {error}
      </p>
    )
  } else if (!file) {
    body = <p className="m-4 text-[length:var(--text-secondary)] text-muted">Opening {name}…</p>
  } else if (text !== undefined && path) {
    return (
      <div
        aria-labelledby={`visual-tab-${tab.toolId}`}
        className={cn('relative h-full min-h-0 flex-col', shown ? 'flex' : 'hidden')}
        id={`visual-tabpanel-${tab.toolId}`}
        role="tabpanel"
      >
        {error ? (
          <p
            className="mx-3 mt-2 rounded-[12px] bg-danger/10 px-3 py-2 text-[length:var(--text-meta)] text-danger"
            role="alert"
          >
            {error}
          </p>
        ) : null}
        {conflict || outgrown ? (
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
        ) : null}
        {updated ? (
          <span className="hex-fade pointer-events-none absolute top-14 right-4 z-10 rounded-full bg-info/12 px-2.5 py-1 text-[length:var(--text-meta)] font-medium text-info">
            Updated by {botName}
          </span>
        ) : null}
        <DocumentEditor
          fileName={name}
          flushRef={flush}
          footer={tools}
          inline
          key={`${path}:${edition}`}
          onClose={() => undefined}
          onFollow={() => {
            base.current = latest.current?.version ?? base.current
          }}
          onSave={async next => {
            // An editor the user replaced with the bot's version saves nothing.
            if (edition !== editionRef.current) {
              return
            }

            try {
              const result = await filesWrite(sessionId, path, next, base.current ?? file.version)

              base.current = result.version
              saved(next, result.version, result.modified, result.size)
            } catch (cause) {
              if (cause instanceof JsonRpcGatewayError && cause.code === 4209) {
                setConflict(true)

                throw new Error(
                  `${botName} changed this file while you typed, so your edit was not saved.`
                )
              }

              throw cause
            }
          }}
          plain={plain}
          title={name}
          value={text}
        />
      </div>
    )
  } else if (mime === 'application/pdf' && objectUrl) {
    body = <iframe className="h-full w-full rounded-[12px] bg-white" src={objectUrl} title={name} />
  } else if (mime.startsWith('image/') && objectUrl) {
    body = (
      <img
        alt={name}
        className="mx-auto max-h-full max-w-full rounded-[12px] object-contain"
        src={objectUrl}
      />
    )
  } else if (mime.startsWith('video/') && objectUrl) {
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
    body = (
      <div className="grid h-full place-items-center p-4">
        <audio aria-label={name} className="w-full max-w-md" controls src={objectUrl} />
      </div>
    )
  } else {
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
      className={cn('h-full min-h-0 flex-col', shown ? 'flex' : 'hidden')}
      id={`visual-tabpanel-${tab.toolId}`}
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
      <div className="min-h-0 flex-1 overflow-auto p-1">{body}</div>
      {tools}
    </div>
  )
}
