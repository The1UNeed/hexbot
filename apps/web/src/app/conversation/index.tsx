import { useNavigate, useParams } from '@tanstack/react-router'
import { Check, Copy, File, MoreHorizontal, PanelRight, RotateCcw, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { Avatar } from '../../components/ui/avatar'
import { Button } from '../../components/ui/button'
import { Chip } from '../../components/ui/chip'
import { Dialog } from '../../components/ui/dialog'
import { Input } from '../../components/ui/input'
import { Menu } from '../../components/ui/menu'
import { StatusDot } from '../../components/ui/status-dot'
import {
  approvalRespond,
  attachFile,
  promptSubmit,
  sessionInterrupt,
  setSectionModel
} from '../../lib/api'
import { avatarSrc } from '../../lib/avatar-builder'
import { getBridge } from '../../lib/bridge'
import { cn } from '../../lib/cn'
import { toMillis } from '../../lib/time'
import type {
  ApprovalChoice,
  ApprovalRequest,
  Attachment,
  Bot,
  BotStatus,
  ClarifyRequest
} from '../../lib/types'
import { useBot } from '../../stores/bots'
import { draftsActions } from '../../stores/drafts'
import {
  liveSectionsOf,
  sectionsActions,
  sectionStatusOf,
  useLiveSessionId,
  useSection,
  useSections
} from '../../stores/sections'
import { useSettings } from '../../stores/settings'
import { transcriptActions, type TranscriptMessage, useTranscript } from '../../stores/transcripts'
import { uiActions, useUi } from '../../stores/ui'

import { ClarifyCard } from './clarify-card'
import { composerFieldClass, ComposerShell } from './composer'
import { RoomConversation } from './room'
import { WorkStatus } from './work-status'

const avatarData = (bot?: Bot) => avatarSrc(bot?.avatar)

const dayKey = (time: number) => new Date(toMillis(time)).toDateString()

/** "Today 9:13 PM", "Yesterday 4:02 PM", or "12 Aug 2:10 PM". */
export function dayLabel(time: number, now = Date.now()): string {
  const date = new Date(toMillis(time))
  const clock = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(date)
  const today = new Date(now)
  const yesterday = new Date(now - 86_400_000)

  if (date.toDateString() === today.toDateString()) {
    return `Today ${clock}`
  }

  if (date.toDateString() === yesterday.toDateString()) {
    return `Yesterday ${clock}`
  }

  const day = new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
    ...(date.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' })
  }).format(date)

  return `${day} ${clock}`
}

export function DaySeparator({ time }: { time: number }) {
  return (
    <div className="py-3 text-center text-[length:var(--text-meta)] text-muted">
      {dayLabel(time)}
    </div>
  )
}

/** Small icon buttons that appear beside a bubble on hover. */
export function BubbleActions({
  actions
}: {
  actions: { icon: React.ReactNode; label: string; onClick: () => void }[]
}) {
  return (
    <span className="mt-0.5 flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
      {actions.map(action => (
        <button
          aria-label={action.label}
          className="grid size-7 place-items-center rounded-full text-muted transition-colors hover:bg-surface-2 hover:text-foreground"
          key={action.label}
          onClick={action.onClick}
          title={action.label}
          type="button"
        >
          {action.icon}
        </button>
      ))}
    </span>
  )
}

/** Grey for bots. Humans get the inverse (`userBubbleClass`), like Grok Bot. */
export const bubbleClass =
  'hex-bubble min-w-0 max-w-full rounded-bubble bg-surface-2 px-3.5 py-2 leading-[1.5] break-words'
export const userBubbleClass = cn(bubbleClass, 'bg-foreground text-background')

/** The transcript column: full width with a slim gutter, capped only on very wide windows. */
export const transcriptClass = 'mx-auto max-w-5xl px-3 py-2'

function CodeBlock({ children, className }: { children?: React.ReactNode; className?: string }) {
  const language = /language-([^ ]+)/.exec(className ?? '')?.[1]
  const text = String(children ?? '').replace(/\n$/, '')

  if (!className) {
    return (
      <code className="rounded-[5px] bg-foreground/8 px-1.5 py-0.5 font-mono text-[0.9em]">
        {children}
      </code>
    )
  }

  return (
    <div className="my-3 overflow-hidden rounded-panel bg-background/70">
      <div className="flex items-center justify-between px-3 py-1.5 text-[length:var(--text-meta)] text-muted">
        <span>{language ?? 'code'}</span>
        <button
          aria-label="Copy code"
          className="grid size-6 place-items-center rounded-full hover:bg-surface-2 hover:text-foreground"
          onClick={() => void navigator.clipboard.writeText(text)}
          type="button"
        >
          <Copy size={12} />
        </button>
      </div>
      <pre className="overflow-auto px-3 pb-3 font-mono text-[length:var(--text-secondary)] leading-relaxed">
        <code>{text}</code>
      </pre>
    </div>
  )
}

export function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      components={{
        a: props => (
          <a
            className="underline decoration-foreground/30 underline-offset-2 hover:decoration-foreground"
            rel="noreferrer"
            target="_blank"
            {...props}
          />
        ),
        code: CodeBlock,
        table: props => (
          <div className="overflow-x-auto">
            <table className="my-3 w-full border-collapse" {...props} />
          </div>
        ),
        td: props => <td className="border border-border p-2" {...props} />,
        th: props => <th className="border border-border bg-surface-2 p-2 text-left" {...props} />
      }}
      remarkPlugins={[remarkGfm]}
    >
      {text}
    </ReactMarkdown>
  )
}

function Attachments({
  attachments,
  onImage
}: {
  attachments: Attachment[]
  onImage: (source: string) => void
}) {
  if (!attachments.length) {
    return null
  }

  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {attachments.map(item =>
        item.kind === 'image' && item.dataUrl ? (
          <button key={item.id} onClick={() => onImage(item.dataUrl!)} type="button">
            <img
              alt={item.name}
              className="max-h-64 rounded-panel object-contain"
              src={item.dataUrl}
            />
          </button>
        ) : (
          <Chip key={item.id}>
            <File size={12} />
            {item.name}
            <span>{Math.ceil(item.size / 1024)} KB</span>
          </Chip>
        )
      )}
    </div>
  )
}

/**
 * A Stopped card built from the bot's `status_detail` for a section opened
 * after the incident fired (the live event only reaches open transcripts).
 * Null once the transcript carries its own error row.
 */
export function stoppedCardFor(
  bot: Bot | undefined,
  sectionId: null | string,
  messages: TranscriptMessage[]
): null | TranscriptMessage {
  const detail = bot?.status === 'stopped' ? bot.status_detail : null

  if (!detail || !sectionId || detail.section_id !== sectionId) {
    return null
  }

  if (messages.some(message => message.error)) {
    return null
  }

  return {
    attachments: [],
    createdAt: detail.since,
    error: detail.text,
    errorDetail: {
      connector: detail.action?.kind === 'fix_connector' ? detail.action.connector : null
    },
    id: `status-${sectionId}`,
    role: 'system',
    streaming: false,
    text: '',
    toolCalls: []
  }
}

/** The inline card for a turn that did not finish (design: "Status in the chat"). */
/** "notion" -> "Notion", "web_search" -> "Web search", "mcp:github" -> "github". */
export function humanConnector(id: null | string | undefined): string {
  if (!id) {
    return ''
  }

  if (id.startsWith('mcp:')) {
    return id.slice(4)
  }

  const words = id.replace(/_/g, ' ')

  return words.charAt(0).toUpperCase() + words.slice(1)
}

export function StoppedCard({
  message,
  name,
  onFix,
  onRetry
}: {
  message: TranscriptMessage
  name: string
  onFix?: (connector: string) => void
  onRetry: () => void
}) {
  const connector = message.errorDetail?.connector ?? null

  const connectorName = message.errorDetail?.connectorName ?? humanConnector(connector)

  return (
    <div
      className="my-1 flex max-w-[80%] flex-col gap-2 rounded-panel bg-surface-2/70 px-3 py-2.5"
      data-testid="stopped-card"
      role="alert"
    >
      <div className="flex items-center gap-2">
        <span aria-hidden className="size-2 shrink-0 rounded-full bg-danger" />
        <span className="font-medium">{name} stopped</span>
        {message.createdAt > 0 ? (
          <time className="ml-auto text-[length:var(--text-meta)] text-muted">
            {new Date(toMillis(message.createdAt)).toLocaleTimeString([], {
              hour: 'numeric',
              minute: '2-digit'
            })}
          </time>
        ) : null}
      </div>
      <p className="text-[length:var(--text-secondary)]">{message.error}</p>
      <div className="flex gap-2">
        {connector && onFix ? (
          <Button onClick={() => onFix(connector)} size="sm" variant="primary">
            Fix {connectorName}
          </Button>
        ) : null}
        <Button onClick={onRetry} size="sm">
          Retry
        </Button>
      </div>
    </div>
  )
}

export function MessageRow({
  bot,
  message,
  onFix,
  onImage,
  onRetry
}: {
  bot?: Bot
  firstInRun: boolean
  message: TranscriptMessage
  onFix?: (connector: string) => void
  onImage: (source: string) => void
  onRetry: () => void
}) {
  if (message.error) {
    return (
      <StoppedCard
        message={message}
        name={bot?.display_name ?? 'The bot'}
        onFix={onFix}
        onRetry={onRetry}
      />
    )
  }

  if (message.role === 'system' || message.role === 'tool') {
    return null
  }

  const assistant = message.role === 'assistant'

  const copy = {
    icon: <Copy size={14} />,
    label: 'Copy',
    onClick: () => void navigator.clipboard.writeText(message.text)
  }

  const actions = assistant
    ? [copy, { icon: <RotateCcw size={14} />, label: 'Retry', onClick: onRetry }]
    : [copy]

  const hasBody = Boolean(message.text || message.attachments.length)
  const name = bot?.display_name ?? 'Bot'

  // The bot's face beside its bubble. No name: the header already says whose chat this is.
  // The column reads in order: the work that produced the reply, the reply, then its actions.
  return (
    <article
      className={cn('group flex gap-2 py-1', assistant ? 'justify-start' : 'flex-row-reverse')}
      data-testid={assistant ? 'bot-message' : 'user-message'}
    >
      {assistant && hasBody ? (
        <Avatar
          className={cn('mt-1', message.streaming && 'hex-think')}
          image={avatarData(bot)}
          mood={message.streaming ? 'working' : undefined}
          name={name}
          size="sm"
        />
      ) : null}
      <div
        className={cn('flex min-w-0 max-w-[80%] flex-col', assistant ? 'items-start' : 'items-end')}
      >
        {assistant ? (
          <WorkStatus face={!hasBody} image={avatarData(bot)} message={message} name={name} />
        ) : null}
        {hasBody ? (
          <div className={assistant ? bubbleClass : userBubbleClass}>
            {message.text ? (
              <div className="hex-prose">
                <Markdown text={message.text} />
              </div>
            ) : null}
            <Attachments attachments={message.attachments} onImage={onImage} />
          </div>
        ) : null}
        {message.streaming || !hasBody ? null : <BubbleActions actions={actions} />}
      </div>
    </article>
  )
}

/** A card the bot is waiting on, in the same row as its bubbles: face, then card. */
function CardRow({ bot, children }: { bot?: Bot; children: React.ReactNode }) {
  return (
    <div className="flex gap-2 py-1">
      <Avatar className="mt-1" image={avatarData(bot)} name={bot?.display_name ?? 'Bot'} size="sm" />
      {children}
    </div>
  )
}

function ApprovalCard({ approval }: { approval: ApprovalRequest }) {
  const choose = async (choice: ApprovalChoice) => {
    await approvalRespond(approval.sessionId, approval.requestId, choice)
    transcriptActions().resolveApproval(approval.sessionId, approval.requestId, choice)
  }

  return (
    <div className="hex-bubble min-w-0 max-w-[80%] flex-1 rounded-bubble border border-warning/40 bg-surface-2 px-3.5 py-2.5">
      <div className="font-semibold">Approval needed</div>
      {approval.command ? (
        <pre className="my-2 overflow-auto rounded-control bg-background/70 p-2 font-mono text-[length:var(--text-secondary)]">
          {approval.command}
        </pre>
      ) : null}
      {approval.reason ? (
        <p className="mb-2 text-[length:var(--text-secondary)] text-muted">{approval.reason}</p>
      ) : null}
      {approval.decision ? (
        <Chip tone={approval.decision === 'deny' ? 'danger' : 'success'}>
          {approval.decision === 'deny'
            ? 'Denied'
            : approval.decision === 'always'
              ? 'Always allowed'
              : 'Approved'}
        </Chip>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void choose('once')} size="sm" variant="primary">
            Approve
          </Button>
          <Button onClick={() => void choose('deny')} size="sm">
            Deny
          </Button>
          <Button onClick={() => void choose('always')} size="sm">
            Always allow
          </Button>
        </div>
      )}
    </div>
  )
}

export function suggestedPrompts(description: string, name = 'this bot'): string[] {
  const first = description.trim()
    ? `What can you help me with, ${name}? Give me two examples.`
    : `What can you help me with, ${name}?`

  return [
    first,
    'Tell me what you remember about me so far.',
    'Suggest three things we could do together right now.'
  ]
}

/**
 * Submit a prompt, and if the daemon no longer holds the live session (it was
 * reaped after a reload or a daemon restart), reopen the section once and
 * resend on the fresh session. Any other failure lands in the transcript as
 * an error row instead of an unhandled rejection.
 */
async function submitOrReopen(sessionId: string, sectionId: string | null, text: string) {
  try {
    await promptSubmit(sessionId, text)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    if (sectionId && /session not found/i.test(message)) {
      const reopened = await sectionsActions().open(sectionId)

      if (reopened.liveSessionId && reopened.liveSessionId !== sessionId) {
        transcriptActions().appendUserMessage(reopened.liveSessionId, text)
        await promptSubmit(reopened.liveSessionId, text)

        return
      }
    }

    transcriptActions().errorEvent(sessionId, message)
  }
}

interface DraftAttachment {
  file: File
  id: string
  preview?: string
}

function Composer({
  bot,
  notice,
  sectionId,
  sessionId,
  status,
  streaming
}: {
  bot?: Bot
  notice?: React.ReactNode
  sectionId: string | null
  sessionId: string | null
  status?: BotStatus
  streaming: boolean
}) {
  const [text, setText] = useState(() => (sectionId ? draftsActions().byId[sectionId] : '') ?? '')
  const [files, setFiles] = useState<DraftAttachment[]>([])
  const [sending, setSending] = useState(false)
  const picker = useRef<HTMLInputElement>(null)

  const addFiles = (incoming: File[]) =>
    setFiles(current => [
      ...current,
      ...incoming.map(file => ({
        file,
        id: `${file.name}-${file.size}-${crypto.randomUUID()}`,
        preview: file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined
      }))
    ])

  const send = async () => {
    if (!sessionId || sending || (!text.trim() && !files.length)) {
      return
    }

    setSending(true)

    try {
      for (const item of files) {
        await attachFile(sessionId, item.file)
      }

      const attachments: Attachment[] = files.map(item => ({
        dataUrl: item.preview,
        id: item.id,
        kind: item.file.type.startsWith('image/')
          ? 'image'
          : item.file.type === 'application/pdf'
            ? 'pdf'
            : 'file',
        mime: item.file.type,
        name: item.file.name,
        size: item.file.size
      }))

      transcriptActions().appendUserMessage(sessionId, text.trim(), attachments)

      if (sectionId) {
        sectionsActions().markTouched(sectionId)
      }

      await submitOrReopen(sessionId, sectionId, text.trim())
      setText('')
      setFiles([])

      if (sectionId) {
        draftsActions().clear(sectionId)
      }
    } finally {
      setSending(false)
    }
  }

  useEffect(() => {
    const node = document.getElementById('conversation-composer') as HTMLTextAreaElement | null

    if (node) {
      node.style.height = 'auto'
      node.style.height = `${Math.min(node.scrollHeight, 8 * 22)}px`
    }
  }, [text])

  return (
    <ComposerShell
      above={
        files.length ? (
          <div className="mb-2 flex flex-wrap gap-2">
            {files.map(item => (
              <Chip className="py-1 pr-1.5 pl-1.5" key={item.id}>
                {item.preview ? (
                  <img alt="" className="size-5 rounded object-cover" src={item.preview} />
                ) : (
                  <File size={12} />
                )}
                {item.file.name}
                <button
                  aria-label={`Remove ${item.file.name}`}
                  className="grid size-4 place-items-center rounded-full hover:bg-surface-3"
                  onClick={() => setFiles(current => current.filter(file => file.id !== item.id))}
                  type="button"
                >
                  <X size={11} />
                </button>
              </Chip>
            ))}
          </div>
        ) : null
      }
      canSend={Boolean(sessionId) && (Boolean(text.trim()) || files.length > 0)}
      notice={notice}
      onAttach={() => picker.current?.click()}
      onSend={() => void send()}
      onStop={() => sessionId && void sessionInterrupt(sessionId)}
      sending={sending}
      status={status}
      streaming={streaming}
    >
      <input
        className="hidden"
        multiple
        onChange={event => addFiles([...(event.target.files ?? [])])}
        ref={picker}
        type="file"
      />
      <textarea
        aria-label="Message"
        className={composerFieldClass}
        disabled={!sessionId}
        id="conversation-composer"
        onChange={event => {
          setText(event.target.value)

          if (sectionId) {
            draftsActions().set(sectionId, event.target.value)
          }
        }}
        onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            void send()
          }
        }}
        onPaste={event => {
          const pasted = [...event.clipboardData.files].filter(
            file => file.type.startsWith('image/') || file.type.startsWith('text/')
          )

          if (pasted.length) {
            event.preventDefault()
            addFiles(pasted)
          }
        }}
        placeholder={`Message ${bot?.display_name ?? 'bot'}`}
        rows={1}
        value={text}
      />
    </ComposerShell>
  )
}

type TimelineItem =
  | { approval: ApprovalRequest; at: number; kind: 'approval' }
  | { at: number; clarify: ClarifyRequest; kind: 'clarify' }
  | { at: number; index: number; kind: 'message'; message: TranscriptMessage }

function BotConversation() {
  const params = useParams({ strict: false }) as { bot?: string; section?: string }
  const navigate = useNavigate()
  const bot = useBot(params.bot ?? null)
  const section = useSection(params.section ?? null)
  const liveId = useLiveSessionId(params.section ?? null)
  const transcript = useTranscript(liveId)
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState('')
  const [lightbox, setLightbox] = useState<string | null>(null)
  const [visible, setVisible] = useState(60)
  const [atBottom, setAtBottom] = useState(true)
  const viewport = useRef<HTMLDivElement>(null)
  const bottom = useRef<HTMLDivElement>(null)
  const models = useSettings(state => state.models)
  const refreshModels = useSettings(state => state.refreshModels)
  const togglePanel = useUi(state => state.toggleRightPanel)
  const messages = useMemo(() => transcript?.messages ?? [], [transcript?.messages])
  const approvals = useMemo(() => transcript?.approvals ?? [], [transcript?.approvals])
  const clarifies = useMemo(() => transcript?.clarifies ?? [], [transcript?.clarifies])
  const streaming = Boolean(transcript?.streamingMessageId)
  const [unavailable, setUnavailable] = useState<string | null>(null)
  const stoppedHere = stoppedCardFor(bot, params.section ?? null, messages)

  const status = sectionStatusOf(
    bot,
    params.section ?? null,
    transcript && liveId ? liveSectionsOf({ [liveId]: transcript }) : {}
  )

  const notice =
    status === 'stopped'
      ? (bot?.status_detail?.text ?? messages.findLast(message => message.error)?.error)
      : status === 'needs_you'
        ? 'Waiting on you'
        : null

  useEffect(() => {
    if (params.section && !liveId && unavailable !== params.section) {
      sectionsActions()
        .open(params.section)
        .catch(() => {
          // The section does not exist on this daemon: show that instead of
          // bouncing through `/`, which would remember it and come back here.
          setUnavailable(params.section ?? null)
          uiActions().setLastSection(null)
        })
    }
  }, [liveId, params.section, unavailable])
  useEffect(() => setTitle(section?.title ?? ''), [section?.title])
  useEffect(() => {
    if (!models.all.length) {
      void refreshModels(bot?.provider ?? undefined)
    }
  }, [bot?.provider, models.all.length, refreshModels])
  useEffect(() => {
    if (atBottom) {
      bottom.current?.scrollIntoView({ block: 'end' })
    }
  }, [approvals.length, atBottom, clarifies, messages])
  const wasStreaming = useRef(streaming)
  useEffect(() => {
    if (document.hidden && wasStreaming.current && !streaming) {
      const body = messages.at(-1)?.text || 'New message'
      const input = { body, sectionId: section?.id, title: bot?.display_name ?? 'Hexbot' }
      const bridge = getBridge()

      if (bridge) {
        bridge.notify(input)
      } else if ('Notification' in window && Notification.permission === 'granted') {
        new Notification(input.title, { body: input.body })
      }
    }

    wasStreaming.current = streaming
  }, [bot?.display_name, messages, section?.id, streaming])
  const previousApprovalCount = useRef(approvals.length)
  useEffect(() => {
    if (
      !getBridge() &&
      document.hidden &&
      approvals.length > previousApprovalCount.current &&
      'Notification' in window &&
      Notification.permission === 'granted'
    ) {
      new Notification('Approval needed', {
        body:
          approvals.at(-1)?.command ?? approvals.at(-1)?.reason ?? 'A bot is asking for permission.'
      })
    }

    previousApprovalCount.current = approvals.length
  }, [approvals])
  const shown = messages.slice(-visible)

  // Messages, question cards and approval cards in the order they happened.
  // Restored history carries no times and stays first.
  const timeline = useMemo(() => {
    const items: TimelineItem[] = [
      ...shown.map((message, index) => ({
        at: message.createdAt > 0 ? toMillis(message.createdAt) : 0,
        index,
        kind: 'message' as const,
        message
      })),
      ...clarifies.map(clarify => ({ at: clarify.receivedAt, clarify, kind: 'clarify' as const })),
      ...approvals.map(approval => ({
        approval,
        at: approval.receivedAt,
        kind: 'approval' as const
      }))
    ]

    return items.sort((a, b) => a.at - b.at)
  }, [approvals, clarifies, shown])

  const retry = () => {
    const last = messages.findLast(message => message.role === 'user')

    if (liveId && last) {
      void promptSubmit(liveId, last.text)
    }
  }

  const fixConnector = (connector: string) => {
    if (bot) {
      void navigate({
        params: { bot: bot.name, tab: 'connectors' },
        search: { connector },
        to: '/b/$bot/settings/$tab'
      })
    }
  }

  const rename = async () => {
    if (section && title.trim() && title.trim() !== section.title) {
      await sectionsActions().rename(section.id, title.trim())
    }

    setEditing(false)
  }

  const selectModel = async (model: string) => {
    if (!liveId) {
      return
    }

    await setSectionModel(liveId, model)
    transcriptActions().sessionInfo(liveId, { ...(transcript?.info ?? {}), model })
  }

  const currentModel = transcript?.info?.model ?? bot?.model ?? 'Model'

  const archive = async () => {
    if (!section) {
      return
    }

    await sectionsActions().archive(section.id)

    // Leave the archived section: go to the bot's latest open one, or start a fresh one.
    const next = Object.values(useSections.getState().byId)
      .filter(item => item.bot === section.bot && !item.archived_at && item.id !== section.id)
      .sort((a, b) => toMillis(b.updated_at) - toMillis(a.updated_at))[0]

    const target = next ?? (await sectionsActions().create(section.bot))
    void navigate({ params: { bot: section.bot, section: target.id }, to: '/b/$bot/s/$section' })
  }

  const remove = async () => {
    if (!section || !window.confirm(`Delete “${section.title}”? Its history goes with it.`)) {
      return
    }

    await sectionsActions().remove(section.id)
    void navigate({ to: '/' })
  }

  return (
    <div
      className="relative flex h-screen min-h-0 flex-col bg-background"
      onDragOver={event => event.preventDefault()}
      onDrop={event => {
        event.preventDefault()

        const input =
          viewport.current?.parentElement?.querySelector<HTMLInputElement>('input[type=file]')

        if (input) {
          const transfer = new DataTransfer()

          for (const file of event.dataTransfer.files) {
            transfer.items.add(file)
          }

          input.files = transfer.files
          input.dispatchEvent(new Event('change', { bubbles: true }))
        }
      }}
    >
      <header className="hex-drag flex h-11 shrink-0 items-center gap-2 px-4 max-[700px]:pl-12">
        <span className="relative shrink-0">
          <Avatar
            image={avatarData(bot)}
            name={bot?.display_name ?? params.bot ?? 'Bot'}
            size="sm"
          />
          <StatusDot size="sm" status={status} />
        </span>
        <div className="hex-no-drag flex min-w-0 flex-1 items-baseline gap-2">
          <span className="truncate text-[length:var(--text-secondary)] font-semibold">
            {bot?.display_name ?? params.bot}
          </span>
          {editing ? (
            <Input
              aria-label="Section title"
              autoFocus
              className="h-6 max-w-xs rounded-[6px] px-1.5 text-[length:var(--text-secondary)]"
              onBlur={() => void rename()}
              onChange={event => setTitle(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') {
                  void rename()
                }

                if (event.key === 'Escape') {
                  setTitle(section?.title ?? '')
                  setEditing(false)
                }
              }}
              value={title}
            />
          ) : section?.title && section.title !== bot?.display_name ? (
            <button
              className="min-w-0 truncate text-left text-[length:var(--text-secondary)] text-muted hover:text-foreground"
              onClick={() => setEditing(true)}
              title="Rename section"
              type="button"
            >
              {section.title}
            </button>
          ) : null}
        </div>
        <div className="hex-no-drag flex items-center gap-1">
          <Menu
            items={models.all.map(model => ({
              label: (
                <span className="flex w-full items-center gap-2">
                  <span className="flex-1">{model.label}</span>
                  {model.id === currentModel ? <Check size={13} /> : null}
                </span>
              ),
              onSelect: () => void selectModel(model.id)
            }))}
            trigger={
              <button
                aria-label="Choose model"
                className="max-w-40 truncate rounded-full px-2.5 py-1 text-[length:var(--text-meta)] text-muted transition-colors hover:bg-surface-2 hover:text-foreground"
                type="button"
              >
                {currentModel}
              </button>
            }
          />
          <Menu
            items={[
              { label: 'Rename', onSelect: () => setEditing(true) },
              { label: 'Archive', onSelect: () => void archive() },
              { separator: true, label: '' },
              {
                label: (
                  <span className="flex items-center gap-2 text-danger">
                    <Trash2 size={14} />
                    Delete
                  </span>
                ),
                onSelect: () => void remove()
              }
            ]}
            trigger={
              <button
                aria-label="Conversation actions"
                className="grid size-7 place-items-center rounded-full text-muted transition-colors hover:bg-surface-2 hover:text-foreground"
                type="button"
              >
                <MoreHorizontal size={16} />
              </button>
            }
          />
          <button
            aria-label="Toggle profile panel"
            className="grid size-7 place-items-center rounded-full text-muted transition-colors hover:bg-surface-2 hover:text-foreground"
            onClick={() => togglePanel()}
            type="button"
          >
            <PanelRight size={16} />
          </button>
        </div>
      </header>
      <div
        className="min-h-0 flex-1 overflow-y-auto"
        onScroll={event => {
          const node = event.currentTarget
          setAtBottom(node.scrollHeight - node.scrollTop - node.clientHeight < 80)
        }}
        ref={viewport}
      >
        {unavailable === params.section && !liveId ? (
          <div className="hex-fade grid h-full place-content-center justify-items-center gap-4 p-8 text-center">
            <Avatar image={avatarData(bot)} name={bot?.display_name ?? 'Bot'} size="xl" />
            <div>
              <h2 className="text-[length:var(--text-title)] font-semibold">
                This conversation is no longer available
              </h2>
              <p className="mt-1 text-muted">
                It may have been deleted, or it lives on another daemon.
              </p>
            </div>
            {bot ? (
              <Button
                onClick={() =>
                  void sectionsActions()
                    .create(bot.name)
                    .then(section =>
                      navigate({
                        to: '/b/$bot/s/$section',
                        params: { bot: bot.name, section: section.id }
                      })
                    )
                }
                variant="primary"
              >
                Start a new section
              </Button>
            ) : null}
          </div>
        ) : messages.length === 0 && clarifies.length === 0 ? (
          <div className="hex-fade grid h-full place-content-center justify-items-center gap-5 p-8 text-center">
            <Avatar image={avatarData(bot)} name={bot?.display_name ?? 'Bot'} size="xl" />
            <div>
              <h2 className="text-[length:var(--text-title)] font-semibold">{bot?.display_name}</h2>
              {bot?.title || bot?.description ? (
                <p className="mt-1 text-muted">{bot.title || bot.description}</p>
              ) : null}
            </div>
            <div className="flex max-w-md flex-wrap justify-center gap-2">
              {suggestedPrompts(bot?.description ?? '', bot?.display_name).map(prompt => (
                <Button
                  key={prompt}
                  onClick={() => {
                    if (liveId && section) {
                      transcriptActions().appendUserMessage(liveId, prompt)
                      sectionsActions().markTouched(section.id)
                      void promptSubmit(liveId, prompt)
                    }
                  }}
                  size="sm"
                  variant="pill"
                >
                  {prompt}
                </Button>
              ))}
            </div>
          </div>
        ) : (
          <div className={transcriptClass}>
            {messages.length > visible ? (
              <button
                className="mx-auto mb-3 block rounded-full px-3 py-1 text-[length:var(--text-secondary)] text-muted hover:bg-surface-2 hover:text-foreground"
                onClick={() => setVisible(value => value + 60)}
                type="button"
              >
                Load earlier messages
              </button>
            ) : null}
            {timeline.map(item => {
              if (item.kind === 'clarify') {
                return (
                  <CardRow bot={bot} key={item.clarify.requestId}>
                    <ClarifyCard clarify={item.clarify} />
                  </CardRow>
                )
              }

              if (item.kind === 'approval') {
                return (
                  <CardRow bot={bot} key={item.approval.requestId}>
                    <ApprovalCard approval={item.approval} />
                  </CardRow>
                )
              }

              const { index, message } = item
              const previous = shown[index - 1]

              // Restored history carries no times (createdAt 0): draw no separator
              // for it, and none right after it, so a reload never splits a turn.
              const separator =
                message.createdAt > 0 &&
                (!previous ||
                  (previous.createdAt > 0 &&
                    (dayKey(previous.createdAt) !== dayKey(message.createdAt) ||
                      toMillis(message.createdAt) - toMillis(previous.createdAt) > 20 * 60_000)))

              return (
                <div key={message.id}>
                  {separator ? <DaySeparator time={message.createdAt} /> : null}
                  <MessageRow
                    bot={bot}
                    firstInRun={!previous || previous.role !== message.role}
                    message={message}
                    onFix={fixConnector}
                    onImage={setLightbox}
                    onRetry={retry}
                  />
                </div>
              )
            })}
            {stoppedHere ? (
              <StoppedCard
                message={stoppedHere}
                name={bot?.display_name ?? 'Bot'}
                onFix={fixConnector}
                onRetry={retry}
              />
            ) : null}
            <div className="h-2" ref={bottom} />
          </div>
        )}
      </div>
      {!atBottom ? (
        <button
          className="hex-bubble absolute bottom-20 left-1/2 -translate-x-1/2 rounded-full border border-border bg-surface px-3 py-1.5 text-[length:var(--text-secondary)] shadow-popup"
          onClick={() => {
            bottom.current?.scrollIntoView({ behavior: 'smooth' })
            setAtBottom(true)
          }}
          type="button"
        >
          Jump to latest
        </button>
      ) : null}
      <Composer
        bot={bot}
        key={params.section}
        notice={notice}
        sectionId={params.section ?? null}
        sessionId={liveId}
        status={status}
        streaming={streaming}
      />
      <Dialog
        onOpenChange={open => !open && setLightbox(null)}
        open={Boolean(lightbox)}
        toolbar={
          <button aria-label="Close image" onClick={() => setLightbox(null)} type="button">
            <X />
          </button>
        }
      >
        <div className="grid max-h-[85vh] place-items-center bg-black p-2">
          {lightbox ? (
            <img
              alt="Attachment preview"
              className="max-h-[78vh] max-w-full object-contain"
              src={lightbox}
            />
          ) : null}
        </div>
      </Dialog>
    </div>
  )
}

export function ConversationColumn() {
  const params = useParams({ strict: false }) as { room?: string }

  return params.room ? <RoomConversation /> : <BotConversation />
}
