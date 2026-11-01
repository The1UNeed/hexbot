import { ArrowUp, Download, FileText } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { filesRead, filesWrite, type OpenedFile } from '../../lib/api'
import { cn } from '../../lib/cn'
import type { Message } from '../../lib/types'
import { useBots } from '../../stores/bots'
import { useTranscript } from '../../stores/transcripts'
import { useUi } from '../../stores/ui'
import { type FileTab, fileTab, visualsActions } from '../../stores/visuals'
import { errorText } from '../bot-settings/shared'
import { DocumentEditor } from '../panel/document-editor'

import { sendText } from './index'

/** The bot's tools that change a file; when one finishes, an open file is read again. */
export const FILE_TOOLS = new Set(['edit', 'patch', 'write', 'write_file'])

/** A file to open beside the chat: the daemon's path for it, or an object URL this page holds. */
export interface FileTarget {
  mime: string
  name: string
  path?: string
  url?: string
}

const MIMES: Record<string, string> = {
  csv: 'text/csv',
  json: 'application/json',
  md: 'text/markdown',
  pdf: 'application/pdf',
  png: 'image/png',
  txt: 'text/plain'
}

export function mimeOf(name: string): string {
  return MIMES[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream'
}

/** The file's own name: an attachment is kept as `<32-hex id>-<name>`. */
const baseName = (path: string) =>
  (path.split(/[\\/]/).pop() || path).replace(/^[0-9a-f]{32}-(?=.)/, '')

/** The files the bot wrote or edited in a message, once each, in the order it first touched them. */
export function filesOf(message: Pick<Message, 'toolCalls'>): FileTarget[] {
  const seen = new Set<string>()

  return message.toolCalls.flatMap(call => {
    if (!FILE_TOOLS.has(call.name) || call.status !== 'ok') {
      return []
    }

    const args = typeof call.args === 'string' ? parse(call.args) : call.args
    const path = (args as { path?: unknown } | null)?.path

    if (typeof path !== 'string' || !path || seen.has(path)) {
      return []
    }

    seen.add(path)
    const name = baseName(path)

    return [{ mime: mimeOf(name), name, path }]
  })
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** Opens a file in a tab beside the chat, read and saved through the chat's live session. */
export function openFile(sessionId: string, target: FileTarget) {
  visualsActions().open(
    fileTab(target.name, { mime: target.mime, path: target.path, sessionId, url: target.url })
  )
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

function useOpenedFile(tab: FileTab) {
  const { path, sessionId, url } = tab.file
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
  // The version last shown; a later read with another one is the bot's edit.
  const shownVersion = useRef<null | number>(null)

  useEffect(() => {
    if (!path) {
      setFile(
        url
          ? { data_url: url, mime: tab.file.mime, modified: 0, name: tab.title, path: '', size: 0 }
          : null
      )

      return
    }

    let current = true

    filesRead(sessionId, path)
      .then(next => {
        if (!current) {
          return
        }

        if (shownVersion.current !== null && shownVersion.current !== next.modified) {
          setUpdated(true)
        }

        shownVersion.current = next.modified
        setFile(next)
        setError(null)
      })
      .catch((cause: unknown) => current && setError(errorText(cause)))

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
  }, [updated, file?.modified])

  /** The user's own save: its new version is not the bot's edit. */
  const saved = (text: string, modified: number, size: number) => {
    shownVersion.current = modified
    setFile(current => (current ? { ...current, modified, size, text } : current))
  }

  return { error, file, saved, updated, working }
}

/** A data URL the panel can frame or download; PDFs need an object URL to open in a frame. */
function useObjectUrl(dataUrl?: string): string | undefined {
  const [url, setUrl] = useState<string>()

  useEffect(() => {
    if (!dataUrl?.startsWith('data:')) {
      setUrl(dataUrl)

      return
    }

    let made: string | undefined
    void fetch(dataUrl)
      .then(response => response.blob())
      .then(blob => {
        made = URL.createObjectURL(blob)
        setUrl(made)
      })

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
 * it lands. A PDF opens in the viewer; anything else offers a download.
 */
export function FileTabView({ shown, tab }: { shown: boolean; tab: FileTab }) {
  const selected = useUi(state => state.lastSection)

  const botName = useBots(state =>
    selected?.bot ? (state.byName[selected.bot]?.display_name ?? 'The bot') : 'The bot'
  )

  const { error, file, saved, updated, working } = useOpenedFile(tab)
  const objectUrl = useObjectUrl(file?.data_url)
  const name = tab.title
  const path = tab.file.path
  const text = file?.text
  const plain = !DOCUMENT.test(name)
  const mime = file?.mime ?? tab.file.mime

  const ask = async (request: string) => {
    await sendText(
      tab.file.sessionId,
      selected?.section ?? null,
      editRequest(request, name, path, text !== undefined)
    )
  }

  const tools = (
    <QuickTools
      botName={botName}
      disabled={working}
      name={name}
      onSend={ask}
      tools={text === undefined ? [] : plain ? PLAIN_TOOLS : DOCUMENT_TOOLS}
    />
  )

  let body: React.ReactNode

  if (error) {
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
        {updated ? (
          <span className="hex-fade pointer-events-none absolute top-14 right-4 z-10 rounded-full bg-info/12 px-2.5 py-1 text-[length:var(--text-meta)] font-medium text-info">
            Updated by {botName}
          </span>
        ) : null}
        <DocumentEditor
          fileName={name}
          footer={tools}
          inline
          key={path}
          onClose={() => undefined}
          onSave={async next => {
            const result = await filesWrite(tab.file.sessionId, path, next, file.modified)
            saved(next, result.modified, result.size)
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
      <div className="min-h-0 flex-1 overflow-auto p-1">{body}</div>
      {tools}
    </div>
  )
}
