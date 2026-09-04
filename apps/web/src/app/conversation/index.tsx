import { useNavigate, useParams } from '@tanstack/react-router'
import {
  Check,
  ChevronDown,
  Copy,
  File,
  MoreHorizontal,
  PanelRight,
  RotateCcw,
  Trash2,
  X
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { Avatar } from '../../components/ui/avatar'
import { Button } from '../../components/ui/button'
import { Chip } from '../../components/ui/chip'
import { Dialog } from '../../components/ui/dialog'
import { Input } from '../../components/ui/input'
import { Menu } from '../../components/ui/menu'
import { Spinner } from '../../components/ui/spinner'
import { Thinking } from '../../components/ui/thinking'
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
  Message,
  ToolCall
} from '../../lib/types'
import { useBot } from '../../stores/bots'
import { sectionsActions, useLiveSessionId, useSection } from '../../stores/sections'
import { useSettings } from '../../stores/settings'
import { transcriptActions, useTranscript } from '../../stores/transcripts'
import { uiActions, useUi } from '../../stores/ui'

import { composerFieldClass, ComposerShell } from './composer'
import { RoomConversation } from './room'

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
    <span className="flex shrink-0 items-center gap-0.5 self-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
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

export const bubbleClass =
  'hex-bubble min-w-0 max-w-[min(78%,42rem)] rounded-bubble bg-surface-2 px-4 py-2.5 leading-[1.5] break-words'

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

function ToolRow({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(false)

  const format = (value: unknown) =>
    typeof value === 'string' ? value : JSON.stringify(value, null, 2)

  return (
    <div className="border-t border-foreground/8 first:border-t-0">
      <button
        aria-expanded={open}
        className="flex w-full items-center gap-2 py-2 text-left text-[length:var(--text-secondary)]"
        onClick={() => setOpen(value => !value)}
        type="button"
      >
        {call.status === 'running' ? (
          <Spinner size="sm" />
        ) : (
          <Check className={call.status === 'error' ? 'text-danger' : 'text-success'} size={13} />
        )}
        <span className="font-medium">{call.name}</span>
        <span className="min-w-0 flex-1 truncate text-muted">
          {call.summary ?? (call.status === 'running' ? 'Running…' : format(call.result))}
        </span>
        <ChevronDown className={open ? 'rotate-180' : ''} size={13} />
      </button>
      {open ? (
        <div className="mb-2 grid gap-2">
          <pre className="overflow-auto rounded-control bg-background/70 p-2 font-mono text-[length:var(--text-meta)]">
            {format(call.args)}
          </pre>
          {call.result !== null ? (
            <pre className="max-h-60 overflow-auto rounded-control bg-background/70 p-2 font-mono text-[length:var(--text-meta)]">
              {format(call.result)}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
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

function MessageRow({
  bot,
  message,
  onImage,
  onRetry
}: {
  bot?: Bot
  firstInRun: boolean
  message: Message
  onImage: (source: string) => void
  onRetry: () => void
}) {
  if (message.error) {
    return (
      <div className="flex items-center justify-center gap-2 py-3 text-[length:var(--text-secondary)] text-danger">
        <span>{message.error}</span>
        <button className="underline" onClick={onRetry} type="button">
          Retry
        </button>
      </div>
    )
  }

  if (message.role === 'system' || message.role === 'tool') {
    return null
  }

  const assistant = message.role === 'assistant'

  if (assistant && message.streaming && !message.text && message.toolCalls.length === 0) {
    return <Thinking image={avatarData(bot)} name={bot?.display_name ?? 'Bot'} />
  }

  const copy = {
    icon: <Copy size={14} />,
    label: 'Copy',
    onClick: () => void navigator.clipboard.writeText(message.text)
  }

  const actions = assistant
    ? [copy, { icon: <RotateCcw size={14} />, label: 'Retry', onClick: onRetry }]
    : [copy]

  return (
    <article
      className={cn('group flex gap-1 py-1', assistant ? 'justify-start' : 'flex-row-reverse')}
      data-testid={assistant ? 'bot-message' : 'user-message'}
    >
      <div className={bubbleClass}>
        {message.thinking ? (
          <details className="mb-2 text-[length:var(--text-secondary)] text-muted">
            <summary className="cursor-pointer select-none">Thinking</summary>
            <div className="mt-1 whitespace-pre-wrap border-l border-foreground/15 pl-3">
              {message.thinking}
            </div>
          </details>
        ) : null}
        {message.text ? (
          <div className="hex-prose">
            <Markdown text={message.text} />
            {message.streaming ? (
              <span
                aria-label="Streaming"
                className="ml-0.5 inline-block h-4 w-[2px] animate-pulse rounded bg-foreground/70 align-middle"
              />
            ) : null}
          </div>
        ) : null}
        {message.toolCalls.length ? (
          <div className={message.text ? 'mt-2 border-t border-foreground/8' : ''}>
            {message.toolCalls.map(call => (
              <ToolRow call={call} key={call.toolId} />
            ))}
          </div>
        ) : null}
        <Attachments attachments={message.attachments} onImage={onImage} />
      </div>
      {message.streaming ? null : <BubbleActions actions={actions} />}
    </article>
  )
}

function ApprovalCard({ approval }: { approval: ApprovalRequest }) {
  const choose = async (choice: ApprovalChoice) => {
    await approvalRespond(approval.sessionId, approval.requestId, choice)
    transcriptActions().resolveApproval(approval.sessionId, approval.requestId, choice)
  }

  return (
    <div className="hex-bubble my-2 max-w-[min(78%,42rem)] rounded-bubble border border-warning/40 bg-surface-2 px-4 py-3">
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
  const focus = description.trim().replace(/[.!?].*$/, '')

  const first = focus
    ? `What can you help me with when it comes to ${focus.charAt(0).toLowerCase()}${focus.slice(1)}?`
    : `What can you help me with, ${name}?`

  return [
    first,
    'Tell me what you remember about me so far.',
    'Suggest three things we could do together right now.'
  ]
}

interface DraftAttachment {
  file: File
  id: string
  preview?: string
}

function Composer({
  bot,
  sessionId,
  streaming
}: {
  bot?: Bot
  sessionId: string | null
  streaming: boolean
}) {
  const [text, setText] = useState('')
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
      await promptSubmit(sessionId, text.trim())
      setText('')
      setFiles([])
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
      onAttach={() => picker.current?.click()}
      onSend={() => void send()}
      onStop={() => sessionId && void sessionInterrupt(sessionId)}
      sending={sending}
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
        onChange={event => setText(event.target.value)}
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
  const streaming = Boolean(transcript?.streamingMessageId)
  const [unavailable, setUnavailable] = useState<string | null>(null)
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
  }, [approvals.length, atBottom, messages])
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

  const retry = () => {
    const last = messages.findLast(message => message.role === 'user')

    if (liveId && last) {
      void promptSubmit(liveId, last.text)
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
  }

  const remove = async () => {
    if (!section || !window.confirm(`Delete “${section.title}”? This also purges its memory.`)) {
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
      <header className="hex-drag flex h-11 shrink-0 items-center gap-2 px-4">
        <Avatar image={avatarData(bot)} name={bot?.display_name ?? params.bot ?? 'Bot'} size="xs" />
        <div className="hex-no-drag flex min-w-0 flex-1 items-baseline gap-2">
          <span className="truncate text-[length:var(--text-secondary)] font-semibold">
            {bot?.display_name ?? params.bot}
          </span>
          {editing ? (
            <Input
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
        ) : messages.length === 0 ? (
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
                    if (liveId) {
                      transcriptActions().appendUserMessage(liveId, prompt)
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
          <div className="mx-auto max-w-3xl px-4 py-2">
            {messages.length > visible ? (
              <button
                className="mx-auto mb-3 block rounded-full px-3 py-1 text-[length:var(--text-secondary)] text-muted hover:bg-surface-2 hover:text-foreground"
                onClick={() => setVisible(value => value + 60)}
                type="button"
              >
                Load earlier messages
              </button>
            ) : null}
            {shown.map((message, index) => {
              const previous = shown[index - 1]

              const separator =
                !previous ||
                dayKey(previous.createdAt) !== dayKey(message.createdAt) ||
                toMillis(message.createdAt) - toMillis(previous.createdAt) > 20 * 60_000

              return (
                <div key={message.id}>
                  {separator ? <DaySeparator time={message.createdAt} /> : null}
                  <MessageRow
                    bot={bot}
                    firstInRun={!previous || previous.role !== message.role}
                    message={message}
                    onImage={setLightbox}
                    onRetry={retry}
                  />
                </div>
              )
            })}
            {approvals.map(approval => (
              <ApprovalCard approval={approval} key={approval.requestId} />
            ))}
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
      <Composer bot={bot} sessionId={liveId} streaming={streaming} />
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
