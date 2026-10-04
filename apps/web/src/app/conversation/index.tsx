import { useNavigate, useParams } from '@tanstack/react-router'
import {
  ArrowDown,
  Copy,
  File,
  MoreHorizontal,
  PanelRight,
  RotateCcw,
  Trash2,
  X
} from 'lucide-react'
import { isValidElement, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { Avatar } from '../../components/ui/avatar'
import { Button } from '../../components/ui/button'
import { Chip } from '../../components/ui/chip'
import { Dialog } from '../../components/ui/dialog'
import { Input } from '../../components/ui/input'
import { Menu } from '../../components/ui/menu'
import { StatusDot } from '../../components/ui/status-dot'
import { Title } from '../../components/ui/title'
import { approvalRespond, attachFile, promptSubmit, sessionInterrupt } from '../../lib/api'
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
import { connectorsActions } from '../../stores/connectors'
import { draftsActions } from '../../stores/drafts'
import {
  isThread,
  liveSectionsOf,
  sectionsActions,
  sectionStatusOf,
  useLiveSessionId,
  useSection,
  useSections
} from '../../stores/sections'
import {
  transcriptActions,
  type TranscriptMessage,
  useTranscript,
  useTranscripts
} from '../../stores/transcripts'
import { uiActions, useUi } from '../../stores/ui'

import { AskingRow } from './asking-row'
import { ClarifyCard } from './clarify-card'
import { composerFieldClass, ComposerShell } from './composer'
import { MemoryMarks } from './memory-marks'
import { RoomConversation } from './room'
import { WaitingBanner } from './waiting-banner'
import { LiveStatus, WorkSummary } from './work-status'

export function ConnectedToolsNotice({ sectionId }: { sectionId: string }) {
  const warning = useTranscripts(state => state.warnings[sectionId])

  if (!warning) {
    return null
  }

  return (
    <div
      className="hex-glass hex-fade pointer-events-auto mx-auto flex w-fit max-w-full shrink-0 items-center gap-2 rounded-full py-1.5 pr-2 pl-3.5 text-[length:var(--text-secondary)] text-warning"
      role="status"
    >
      <span className="truncate">{warning}</span>
      <button
        aria-label="Dismiss notice"
        className="grid size-5 shrink-0 place-items-center rounded-full text-muted hover:text-foreground"
        onClick={() => transcriptActions().setWarning(sectionId, null)}
        type="button"
      >
        <X size={13} />
      </button>
    </div>
  )
}

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
    <div className="pt-6 pb-2 text-center text-[length:var(--text-meta)] font-medium text-muted">
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
    <span className="flex shrink-0 items-center gap-0.5 self-end pb-0.5 opacity-0 transition-opacity duration-[var(--hex-motion-fast)] group-hover:opacity-100 focus-within:opacity-100">
      {actions.map(action => (
        <button
          aria-label={action.label}
          className="hex-focus grid size-7 place-items-center rounded-full text-muted transition-colors duration-[var(--hex-motion-fast)] hover:bg-foreground/[0.06] hover:text-foreground"
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

/**
 * Soft grey for bots. Humans get the inverse (`userBubbleClass`), like Grok
 * Bot. A message that arrives while the chat is open springs in whole from
 * its corner (`hex-message`), like a text; history is drawn where it is.
 */
export const bubbleClass =
  'min-w-0 max-w-full rounded-[20px] bg-bubble px-3.5 py-2 leading-[1.5] break-words'
export const userBubbleClass = cn(bubbleClass, 'bg-foreground text-background')

/** The transcript column: centred and capped so lines stay readable on wide windows. */
export const transcriptClass = 'mx-auto max-w-[52rem] px-5 py-2'

/** Inline code: a small chip in the sentence. Fenced blocks go through `Pre`. */
function InlineCode({ children }: { children?: React.ReactNode }) {
  return (
    <code className="rounded-[5px] bg-foreground/8 px-1.5 py-0.5 font-mono text-[0.9em]">
      {children}
    </code>
  )
}

/**
 * A fenced block, with or without a language: the `pre` is the signal, so a
 * plain ``` block is a block too and never a row of inline chips.
 */
function Pre({ children }: { children?: React.ReactNode }) {
  const code = isValidElement<{ children?: React.ReactNode; className?: string }>(children)
    ? children.props
    : { children, className: '' }

  return <CodeBlock className={code.className}>{code.children}</CodeBlock>
}

function CodeBlock({ children, className }: { children?: React.ReactNode; className?: string }) {
  const language = /language-([^ ]+)/.exec(className ?? '')?.[1]
  const text = String(children ?? '').replace(/\n$/, '')

  // The language sits in a quiet header when there is one; a bare block keeps
  // only the copy button, floating in its corner until hovered.
  return (
    <div className="group/code relative my-3 overflow-hidden rounded-[14px] bg-background/70">
      {language ? (
        <div className="px-3 pt-2 text-[length:var(--text-meta)] text-muted">{language}</div>
      ) : null}
      <button
        aria-label="Copy code"
        className="hex-focus absolute top-1.5 right-1.5 grid size-6 place-items-center rounded-full text-muted opacity-0 transition-[opacity,background-color,color] duration-[var(--hex-motion-fast)] group-hover/code:opacity-100 hover:bg-surface-2 hover:text-foreground focus-visible:opacity-100"
        onClick={() => void navigator.clipboard.writeText(text)}
        type="button"
      >
        <Copy size={12} />
      </button>
      <pre
        className={cn(
          'overflow-auto px-3 pb-2.5 font-mono text-[length:var(--text-secondary)] leading-relaxed',
          language ? 'pt-1' : 'pt-2.5'
        )}
      >
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
        code: InlineCode,
        pre: Pre,
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
      className="hex-bubble mt-2 flex max-w-[min(85%,40rem)] flex-col gap-2 rounded-[20px] border border-danger/15 bg-danger/[0.05] px-3.5 py-3"
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
  onRetry,
  fresh = false,
  joined = false,
  showFace = false
}: {
  bot?: Bot
  message: TranscriptMessage
  onFix?: (connector: string) => void
  onImage: (source: string) => void
  onRetry: () => void
  /** Arrived while this chat was open: each of its bubbles springs in as it appears. */
  fresh?: boolean
  /** Follows a bubble from the same side: it sits 4 px under it, one stack. */
  joined?: boolean
  /** Rooms draw a face beside every bot bubble; a bot's own chat does not. */
  showFace?: boolean
}) {
  const assistant = message.role === 'assistant'
  const settled = useRef<number>(undefined)

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

  // A bot's words show one finished message at a time, never mid-sentence:
  // while the turn runs, what it is still writing stays behind the status.
  const words = assistant
    ? [...(message.parts ?? []), ...(message.streaming ? [] : [message.text])]
    : [message.text]

  const bubbles = words.filter(text => text.trim())

  if (!bubbles.length && message.attachments.length && !message.streaming) {
    bubbles.push('')
  }

  // Bubbles drawn when the row first rendered stay still; later ones spring in.
  const still = settled.current ?? (settled.current = fresh ? 0 : bubbles.length)

  const copy = {
    icon: <Copy size={14} />,
    label: 'Copy',
    onClick: () => void navigator.clipboard.writeText(bubbles.join('\n\n'))
  }

  const actions = assistant
    ? [copy, { icon: <RotateCcw size={14} />, label: 'Retry', onClick: onRetry }]
    : [copy]

  const last = bubbles.length - 1
  const name = bot?.display_name ?? 'Bot'

  // The column reads in order: the bot's messages, their marks, and at the
  // foot the live status while the turn runs, then the line for what it did.
  // The bots it asked get their own row under the turn, two faces turned
  // toward each other.
  return (
    <>
      <article
        className={cn(
          'group flex gap-2',
          joined ? 'pt-1' : 'pt-4',
          assistant ? 'justify-start' : 'flex-row-reverse'
        )}
        data-testid={assistant ? 'bot-message' : 'user-message'}
      >
        {assistant && showFace ? (
          <Avatar
            className={cn('mt-1', message.streaming && 'hex-think')}
            image={avatarData(bot)}
            mood={message.streaming ? 'working' : undefined}
            name={name}
            size="sm"
          />
        ) : null}
        <div
          className={cn(
            'flex min-w-0 max-w-[min(85%,40rem)] flex-col gap-1',
            assistant ? 'items-start' : 'items-end'
          )}
        >
          {bubbles.map((text, index) => (
            <div
              className={cn('flex max-w-full gap-1', !assistant && 'flex-row-reverse')}
              key={index}
            >
              <div
                className={cn(
                  assistant ? bubbleClass : userBubbleClass,
                  index >= still && 'hex-message',
                  index >= still && !assistant && 'hex-message-mine'
                )}
              >
                {text ? (
                  <div className="hex-prose">
                    <Markdown text={text} />
                  </div>
                ) : null}
                {index === last ? (
                  <Attachments attachments={message.attachments} onImage={onImage} />
                ) : null}
              </div>
              {index === last && !message.streaming ? <BubbleActions actions={actions} /> : null}
            </div>
          ))}
          {assistant ? <MemoryMarks message={message} /> : null}
          {assistant ? (
            <WorkSummary computer={!showFace} fresh={fresh} message={message} name={name} />
          ) : null}
          {assistant && message.streaming ? (
            <LiveStatus
              computer={!showFace}
              face={
                showFace ? undefined : (
                  <Avatar
                    className="hex-think"
                    image={avatarData(bot)}
                    mood="working"
                    name={name}
                    size="sm"
                  />
                )
              }
              message={message}
              name={name}
            />
          ) : null}
        </div>
      </article>
      {assistant ? <AskingRow message={message} sender={bot?.name ?? null} /> : null}
    </>
  )
}

/**
 * A card the bot is waiting on, in the same row as its bubbles. Rooms pass the
 * bot so its face leads the card; a bot's own chat has no faces in the column.
 */
export function CardRow({ bot, children }: { bot?: Bot; children: React.ReactNode }) {
  return (
    <div className="flex gap-2 pt-1">
      {bot ? (
        <Avatar className="mt-1" image={avatarData(bot)} name={bot.display_name} size="sm" />
      ) : null}
      {children}
    </div>
  )
}

const APPROVAL_BUTTONS: Record<ApprovalChoice, string> = {
  always: 'Always allow',
  deny: 'Deny',
  once: 'Approve',
  session: 'Allow in this section'
}

const APPROVAL_CHOICES: Record<ApprovalChoice, string> = {
  always: 'Always allowed',
  deny: 'Denied',
  once: 'Approved',
  session: 'Allowed in this section'
}

export function ApprovalCard({ approval }: { approval: ApprovalRequest }) {
  const choose = async (choice: ApprovalChoice) => {
    await approvalRespond(approval.sessionId, approval.requestId, choice)
    transcriptActions().resolveApproval(approval.sessionId, approval.requestId, choice)
  }

  return (
    <div className="hex-bubble min-w-0 max-w-[min(85%,40rem)] flex-1 rounded-[20px] border border-warning/30 bg-bubble px-4 py-3">
      <div className="font-semibold">Approval needed</div>
      {approval.command ? (
        <pre className="my-2 overflow-auto rounded-[12px] bg-background/80 p-2.5 font-mono text-[length:var(--text-secondary)]">
          {approval.command}
        </pre>
      ) : null}
      {approval.reason ? (
        <p className="mb-2 text-[length:var(--text-secondary)] text-muted">{approval.reason}</p>
      ) : null}
      {approval.decision ? (
        <Chip tone={approval.decision === 'deny' ? 'danger' : 'success'}>
          {APPROVAL_CHOICES[approval.decision]}
        </Chip>
      ) : (
        <div className="flex flex-wrap gap-2">
          {approval.choices.map(choice => (
            <Button
              key={choice}
              onClick={() => void choose(choice)}
              size="sm"
              variant={choice === 'once' ? 'primary' : undefined}
            >
              {APPROVAL_BUTTONS[choice]}
            </Button>
          ))}
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
  accessory,
  bot,
  notice,
  sectionId,
  sessionId,
  status,
  streaming
}: {
  accessory?: React.ReactNode
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
        sectionsActions().markTouched(sectionId, text)
      }

      await submitOrReopen(sessionId, sectionId, text.trim())
      setText('')
      setFiles([])

      if (sectionId) {
        draftsActions().clear(sectionId)
      }
    } finally {
      setSending(false)

      if (sectionId) {
        void sectionsActions().settleTitle(sectionId)
      }
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
              <Chip className="hex-glass py-1 pr-1.5 pl-1.5 text-foreground" key={item.id}>
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
      accessory={accessory}
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

/**
 * A time separator before `message`: between days and after 20 quiet minutes.
 * Restored history carries no times (createdAt 0): no separator for it, and
 * none right after it, so a reload never splits a turn.
 */
function separatedFrom(previous: TranscriptMessage | undefined, message: TranscriptMessage) {
  return (
    message.createdAt > 0 &&
    (!previous ||
      (previous.createdAt > 0 &&
        (dayKey(previous.createdAt) !== dayKey(message.createdAt) ||
          toMillis(message.createdAt) - toMillis(previous.createdAt) > 20 * 60_000)))
  )
}

const bubbleShown = (message: TranscriptMessage) =>
  !message.error &&
  (message.role === 'assistant' || message.role === 'user') &&
  Boolean(message.text || message.attachments.length)

/** Two bubbles from the same side, one after the other, read as one run. */
const joins = (a: TranscriptMessage, b: TranscriptMessage) =>
  a.role === b.role && bubbleShown(a) && bubbleShown(b) && !a.streaming

/** Tracks an element's height, for content that scrolls under floating glass. */
function useHeight<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null)
  const [height, setHeight] = useState(0)

  useEffect(() => {
    const node = ref.current

    if (!node || typeof ResizeObserver === 'undefined') {
      return
    }

    const observer = new ResizeObserver(() => setHeight(node.offsetHeight))
    observer.observe(node)

    return () => observer.disconnect()
  }, [])

  return [ref, height]
}

function BotConversation() {
  const params = useParams({ strict: false }) as { bot?: string; section?: string }
  const navigate = useNavigate()
  const bot = useBot(params.bot ?? null)
  const section = useSection(params.section ?? null)
  const liveId = useLiveSessionId(params.section ?? null)
  const transcript = useTranscript(liveId)
  const [editing, setEditing] = useState(false)

  // Connector tools are named from the bot's catalog ("Connecting to Project tools").
  useEffect(() => {
    if (params.bot) {
      void connectorsActions().load(params.bot)
    }
  }, [params.bot])
  const [title, setTitle] = useState('')
  const [lightbox, setLightbox] = useState<string | null>(null)
  const [visible, setVisible] = useState(60)
  const [atBottom, setAtBottom] = useState(true)
  const viewport = useRef<HTMLDivElement>(null)
  const togglePanel = useUi(state => state.toggleRightPanel)
  const panelOpen = useUi(state => state.rightPanelOpen)
  const [composerBox, composerHeight] = useHeight<HTMLDivElement>()
  // Messages that arrive after the section opened spring in; history is drawn still.
  const opened = useRef({ at: Date.now(), id: liveId })

  if (opened.current.id !== liveId) {
    opened.current = { at: Date.now(), id: liveId }
  }

  const openedAt = opened.current.at

  // The transcript's real end, past the padding the floating composer covers;
  // `scrollIntoView` on the last row would leave it under the composer.
  const toEnd = (behavior: ScrollBehavior = 'auto') => {
    const node = viewport.current

    if (node && behavior === 'smooth') {
      node.scrollTo({ behavior, top: node.scrollHeight })
    } else if (node) {
      node.scrollTop = node.scrollHeight
    }
  }

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

  // Waiting is the banner under the header; the composer notice is for errors only.
  const notice =
    status === 'stopped'
      ? (bot?.status_detail?.text ?? messages.findLast(message => message.error)?.error)
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
    if (atBottom) {
      toEnd()
    }
  }, [approvals.length, atBottom, clarifies, composerHeight, messages])
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

  const archive = async () => {
    if (!section) {
      return
    }

    await sectionsActions().archive(section.id)

    // Leave the archived section: go to the bot's latest open one, or start a fresh one.
    const next = Object.values(useSections.getState().byId)
      .filter(
        item =>
          item.bot === section.bot && !item.archived_at && !isThread(item) && item.id !== section.id
      )
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

  const send = (prompt: string) => {
    if (liveId && section) {
      transcriptActions().appendUserMessage(liveId, prompt)
      sectionsActions().markTouched(section.id, prompt)
      void promptSubmit(liveId, prompt).finally(
        () => void sectionsActions().settleTitle(section.id)
      )
    }
  }

  const name = bot?.display_name ?? params.bot ?? 'Bot'

  return (
    <div
      className="relative h-full min-h-0 overflow-hidden bg-background"
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
      <div
        className="absolute inset-0 overflow-y-auto"
        onScroll={event => {
          const node = event.currentTarget
          setAtBottom(node.scrollHeight - node.scrollTop - node.clientHeight < 80)
        }}
        ref={viewport}
        style={{ paddingBottom: composerHeight + 8, paddingTop: 60 }}
      >
        {unavailable === params.section && !liveId ? (
          <div className="hex-rise grid h-full place-content-center justify-items-center gap-4 p-8 text-center">
            <Avatar image={avatarData(bot)} name={name} size="xl" />
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
          <div className="hex-rise grid h-full place-content-center justify-items-center gap-6 p-8 text-center">
            <Avatar image={avatarData(bot)} name={name} size="xl" />
            <div>
              <h2 className="text-[22px] font-semibold tracking-[-0.01em]">{bot?.display_name}</h2>
              {bot?.title || bot?.description ? (
                <p className="mx-auto mt-1.5 max-w-sm text-muted">{bot.title || bot.description}</p>
              ) : null}
            </div>
            <div className="flex max-w-lg flex-col items-center gap-2">
              {suggestedPrompts(bot?.description ?? '', bot?.display_name).map(prompt => (
                <button
                  className="hex-glass-press hex-focus rounded-full bg-bubble px-4 py-2 text-[length:var(--text-secondary)] text-foreground/85 transition-colors duration-[var(--hex-motion-fast)] hover:bg-surface-2 hover:text-foreground"
                  key={prompt}
                  onClick={() => send(prompt)}
                  type="button"
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className={cn(transcriptClass, 'hex-fade')} key={liveId ?? params.section}>
            {messages.length > visible ? (
              <button
                className="hex-focus mx-auto mb-3 block rounded-full px-3 py-1 text-[length:var(--text-secondary)] text-muted transition-colors duration-[var(--hex-motion-fast)] hover:bg-surface-2 hover:text-foreground"
                onClick={() => setVisible(value => value + 60)}
                type="button"
              >
                Load earlier messages
              </button>
            ) : null}
            {timeline.map((item, position) => {
              if (item.kind === 'clarify') {
                return (
                  <CardRow key={item.clarify.requestId}>
                    <ClarifyCard clarify={item.clarify} />
                  </CardRow>
                )
              }

              if (item.kind === 'approval') {
                return (
                  <CardRow key={item.approval.requestId}>
                    <ApprovalCard approval={item.approval} />
                  </CardRow>
                )
              }

              const { index, message } = item
              const previous = shown[index - 1]
              const separator = separatedFrom(previous, message)
              const before = timeline[position - 1]

              const joined =
                !separator && before?.kind === 'message' && joins(before.message, message)

              return (
                <div key={message.id}>
                  {separator ? <DaySeparator time={message.createdAt} /> : null}
                  <MessageRow
                    bot={bot}
                    fresh={toMillis(message.createdAt) > openedAt}
                    joined={joined}
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
            <div className="h-2" />
          </div>
        )}
      </div>
      <header className="hex-drag pointer-events-none absolute inset-x-0 top-0 z-20 flex flex-col items-center gap-2 px-24 pt-2.5">
        <div
          aria-hidden
          className="absolute inset-x-0 top-0 h-9 bg-gradient-to-b from-background/70 to-transparent"
        />
        {editing ? (
          <div className="hex-glass hex-no-drag pointer-events-auto flex h-9 max-w-full min-w-0 items-center gap-2 rounded-full pr-1.5 pl-1.5">
            <Avatar image={avatarData(bot)} name={name} size="sm" />
            <Input
              aria-label="Section title"
              autoFocus
              className="h-7 w-64 max-w-full min-w-0 rounded-full border-transparent bg-foreground/[0.05] px-3 text-[length:var(--text-secondary)]"
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
          </div>
        ) : (
          <button
            aria-expanded={panelOpen}
            aria-label={
              section?.title && section.title !== bot?.display_name
                ? `${name}, ${section.title}`
                : name
            }
            className="hex-glass hex-glass-press hex-focus hex-no-drag pointer-events-auto flex h-9 max-w-[min(100%,30rem)] min-w-0 items-center gap-2 rounded-full pr-4 pl-1.5"
            onClick={() => togglePanel()}
            title={panelOpen ? 'Hide details' : 'Show details'}
            type="button"
          >
            <span className="relative shrink-0">
              <Avatar
                className={cn(status === 'working' && 'hex-think')}
                image={avatarData(bot)}
                mood={status === 'working' ? 'working' : undefined}
                name={name}
                size="sm"
              />
              <StatusDot size="sm" status={status} />
            </span>
            <span className="shrink-0 truncate text-[length:var(--text-secondary)] font-semibold">
              {name}
            </span>
            {section?.title && section.title !== bot?.display_name ? (
              <span className="min-w-0 truncate text-[length:var(--text-secondary)] text-muted max-[860px]:hidden">
                <Title key={section.id} text={section.title} />
              </span>
            ) : null}
          </button>
        )}
        {status === 'needs_you' ? <WaitingBanner /> : null}
        <ConnectedToolsNotice sectionId={params.section ?? ''} />
      </header>
      <div className="hex-no-drag absolute top-2.5 right-3 z-30 flex items-center gap-1.5">
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
              className="hex-glass hex-glass-press hex-focus grid size-9 place-items-center rounded-full text-foreground/70 transition-colors duration-[var(--hex-motion-fast)] hover:text-foreground"
              type="button"
            >
              <MoreHorizontal size={16} />
            </button>
          }
        />
        {panelOpen ? null : (
          <button
            aria-label="Toggle profile panel"
            className="hex-glass hex-glass-press hex-focus hex-fade grid size-9 place-items-center rounded-full text-foreground/70 transition-colors duration-[var(--hex-motion-fast)] hover:text-foreground"
            onClick={() => togglePanel()}
            type="button"
          >
            <PanelRight size={16} />
          </button>
        )}
      </div>
      {!atBottom ? (
        <button
          aria-label="Jump to latest"
          className="hex-glass hex-glass-press hex-focus hex-fade absolute left-1/2 z-20 grid size-9 -translate-x-1/2 place-items-center rounded-full text-foreground/80"
          onClick={() => {
            toEnd('smooth')
            setAtBottom(true)
          }}
          style={{ bottom: composerHeight + 8 }}
          type="button"
        >
          <ArrowDown size={16} />
        </button>
      ) : null}
      <div className="absolute inset-x-0 bottom-0 z-20" ref={composerBox}>
        <div className="relative mx-auto max-w-[52rem] px-1">
          <Composer
            bot={bot}
            key={params.section}
            notice={notice}
            sectionId={params.section ?? null}
            sessionId={liveId}
            status={status}
            streaming={streaming}
          />
        </div>
      </div>
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
