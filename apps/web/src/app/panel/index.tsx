import { useNavigate } from '@tanstack/react-router'
import {
  Bell,
  Brain,
  ChevronRight,
  ChevronsRight,
  Cpu,
  File,
  ImageIcon,
  type LucideIcon,
  Plug,
  ScrollText,
  Settings,
  Sparkles,
  SquareTerminal,
  Wrench
} from 'lucide-react'
import { useMemo, useState } from 'react'

import { Switch } from '../../components/ui/switch'
import { cn } from '../../lib/cn'
import { toMillis } from '../../lib/time'
import type { Attachment, Bot, ToolCall } from '../../lib/types'
import { useBots } from '../../stores/bots'
import { useLiveSessionId } from '../../stores/sections'
import { type TranscriptMessage, useTranscript } from '../../stores/transcripts'
import { type PanelTab, useUi } from '../../stores/ui'
import { type BotSettingsTab, rememberedTab } from '../bot-settings'
import { AvatarPicker, errorText, InlineField, type SaveBot } from '../bot-settings/shared'
import { activityLabel } from '../conversation/steps'
import { StepRow } from '../conversation/work-status'

// Stable empty value: a fresh [] per render would re-run the tabs' memos.
const NO_MESSAGES: TranscriptMessage[] = []

const TABS: { id: PanelTab; label: string }[] = [
  { id: 'details', label: 'Details' },
  { id: 'library', label: 'Library' },
  { id: 'computer', label: 'Computer' }
]

/** A white card of rows on the glass panel, with hairlines between them. */
const listClass =
  'divide-y divide-foreground/[0.06] overflow-hidden rounded-[16px] bg-background shadow-card'

const rowClass =
  'hex-focus flex min-h-11 w-full items-center gap-3 px-3.5 py-2 text-left transition-colors duration-[var(--hex-motion-fast)] hover:bg-foreground/[0.03] focus-visible:-outline-offset-2'

function RowIcon({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span className="grid size-7 shrink-0 place-items-center rounded-[9px] bg-foreground/[0.05] text-foreground/70">
      <Icon size={14} />
    </span>
  )
}

const SETTINGS_LINKS: { icon: LucideIcon; label: string; tab: BotSettingsTab }[] = [
  { icon: ScrollText, label: 'Soul', tab: 'persona' },
  { icon: Brain, label: 'Memory', tab: 'memory' },
  { icon: Wrench, label: 'Tools', tab: 'tools' },
  { icon: Plug, label: 'Connectors', tab: 'connectors' },
  { icon: Sparkles, label: 'Skills', tab: 'skills' }
]

function DetailsTab({ bot, onSave }: { bot: Bot; onSave: SaveBot }) {
  const navigate = useNavigate()

  const open = (tab: BotSettingsTab) =>
    void navigate({ params: { bot: bot.name, tab }, to: '/b/$bot/settings/$tab' })

  return (
    <div className="grid gap-5">
      <section>
        <h3 className="mb-1.5 px-1 text-[length:var(--text-meta)] font-medium text-muted">
          Description
        </h3>
        <div className="rounded-[16px] bg-background p-1 shadow-card">
          <InlineField
            ariaLabel="Description"
            className="min-h-20 resize-none rounded-[12px] border-transparent bg-transparent px-2.5 py-2 shadow-none focus-visible:border-transparent focus-visible:ring-0"
            multiline
            onSave={value => onSave({ description: value })}
            placeholder={`What ${bot.display_name} is for`}
            value={bot.description}
          />
        </div>
      </section>
      <section className={listClass}>
        <button className={rowClass} onClick={() => open('model')} type="button">
          <RowIcon icon={Cpu} />
          <span className="flex-1 font-medium">Model</span>
          <span className="max-w-36 truncate text-[length:var(--text-secondary)] text-muted">
            {bot.model || 'Default'}
          </span>
          <ChevronRight className="shrink-0 text-muted" size={14} />
        </button>
        <div className={cn(rowClass, 'hover:bg-transparent')}>
          <RowIcon icon={Bell} />
          <span className="min-w-0 flex-1">
            <span className="block font-medium">Notify me</span>
            <span className="block text-[length:var(--text-meta)] text-muted">
              When it stops or needs you
            </span>
          </span>
          <Switch
            aria-label="Notify me when this bot stops or needs me"
            checked={bot.notify ?? true}
            onCheckedChange={checked => void onSave({ notify: checked })}
          />
        </div>
      </section>
      <section className={listClass}>
        {SETTINGS_LINKS.map(link => (
          <button className={rowClass} key={link.tab} onClick={() => open(link.tab)} type="button">
            <RowIcon icon={link.icon} />
            <span className="flex-1 font-medium">{link.label}</span>
            <ChevronRight className="shrink-0 text-muted" size={14} />
          </button>
        ))}
      </section>
      <button
        className="hex-focus mx-auto flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[length:var(--text-secondary)] text-muted transition-colors duration-[var(--hex-motion-fast)] hover:bg-foreground/[0.05] hover:text-foreground"
        onClick={() => open(rememberedTab(bot.name))}
        type="button"
      >
        <Settings size={14} />
        Bot settings
      </button>
    </div>
  )
}

function Empty({ icon: Icon, text }: { icon: LucideIcon; text: string }) {
  return (
    <div className="hex-fade grid justify-items-center gap-3 px-6 pt-10 text-center">
      <span className="grid size-11 place-items-center rounded-[14px] bg-background text-muted shadow-card">
        <Icon size={18} />
      </span>
      <p className="max-w-60 text-[length:var(--text-secondary)] text-muted">{text}</p>
    </div>
  )
}

/** Every image and file shared in the section, newest first. */
function LibraryTab({ messages, name }: { messages: TranscriptMessage[]; name: string }) {
  const items = useMemo(
    () => messages.flatMap(message => message.attachments).reverse(),
    [messages]
  )

  const images = items.filter(item => item.kind === 'image' && item.dataUrl)
  const files = items.filter(item => !(item.kind === 'image' && item.dataUrl))

  if (!items.length) {
    return <Empty icon={ImageIcon} text={`Images and files you share with ${name} show up here.`} />
  }

  return (
    <div className="grid gap-5">
      {images.length ? (
        <div className="grid grid-cols-3 gap-1.5">
          {images.map(item => (
            <img
              alt={item.name}
              className="aspect-square w-full rounded-[12px] object-cover shadow-card"
              key={item.id}
              src={item.dataUrl}
            />
          ))}
        </div>
      ) : null}
      {files.length ? (
        <ul className={listClass}>
          {files.map((item: Attachment) => (
            <li className={rowClass} key={item.id}>
              <RowIcon icon={File} />
              <span className="min-w-0 flex-1 truncate font-medium">{item.name}</span>
              <span className="shrink-0 text-[length:var(--text-meta)] text-muted">
                {Math.ceil(item.size / 1024)} KB
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

const clock = (call: ToolCall) =>
  call.startedAt > 0
    ? new Date(toMillis(call.startedAt)).toLocaleTimeString([], {
        hour: 'numeric',
        minute: '2-digit'
      })
    : undefined

/**
 * Every tool call in the section, housekeeping included, newest first, each
 * closed until clicked. While a step runs, a line on top says what the bot
 * is doing in plain words, as the chat does.
 */
function ComputerTab({ messages, name }: { messages: TranscriptMessage[]; name: string }) {
  const calls = useMemo(() => messages.flatMap(message => message.toolCalls).reverse(), [messages])

  const running = calls.find(call => call.status === 'running')

  if (!calls.length) {
    return (
      <Empty
        icon={SquareTerminal}
        text={`When ${name} runs a command, reads a page or edits a file, each step shows up here.`}
      />
    )
  }

  return (
    <div className="grid gap-3">
      {running ? (
        <div className="hex-fade flex items-center gap-2 px-1 text-[length:var(--text-secondary)]">
          <span className="size-1.5 shrink-0 rounded-full bg-info" />
          <span className="truncate">{activityLabel(running, name)}</span>
        </div>
      ) : null}
      <ul
        className="min-w-0 rounded-[16px] bg-background p-1.5 shadow-card"
        data-testid="computer-steps"
      >
        {calls.map(call => (
          <StepRow call={call} key={call.toolId} meta={clock(call)} />
        ))}
      </ul>
    </div>
  )
}

/**
 * The side panel, opened from the name pill above the chat: the bot's face,
 * name and label, then three tabs. Details holds the description, the model,
 * notifications and the doors into Bot settings. Library collects what was
 * shared in the section. Computer lists every step the bot took, live.
 */
export function ProfilePanel(): React.JSX.Element {
  const selected = useUi(state => state.lastSection)
  const bot = useBots(state => (selected?.bot ? state.byName[selected.bot] : undefined))
  const updateBot = useBots(state => state.update)
  const closePanel = useUi(state => state.toggleRightPanel)
  const tab = useUi(state => state.panelTab)
  const setTab = useUi(state => state.setPanelTab)
  const liveId = useLiveSessionId(selected?.section ?? null)
  const transcript = useTranscript(liveId)
  const [error, setError] = useState<string | null>(null)
  const messages = transcript?.messages ?? NO_MESSAGES
  const streaming = Boolean(transcript?.streamingMessageId)

  const running = messages.at(-1)?.toolCalls.findLast(call => call.status === 'running')

  if (!bot) {
    return (
      <div className="grid h-full place-content-center p-5 text-center text-muted">
        Select a bot to see its details.
      </div>
    )
  }

  const save: SaveBot = async patch => {
    try {
      setError(null)
      await updateBot(bot.name, patch)
    } catch (cause) {
      setError(errorText(cause))
    }
  }

  const status = running ? activityLabel(running, bot.display_name) : streaming ? 'Working' : null

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="profile-panel">
      <header className="hex-drag flex h-14 shrink-0 items-center justify-end px-3">
        <button
          aria-label="Hide settings"
          className="hex-no-drag hex-focus grid size-8 place-items-center rounded-full text-muted transition-colors duration-[var(--hex-motion-fast)] hover:bg-foreground/[0.06] hover:text-foreground"
          onClick={() => closePanel(false)}
          type="button"
        >
          <ChevronsRight size={16} />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-5">
        <div className="flex flex-col items-center">
          <AvatarPicker bot={bot} hint={false} onSave={save} />
          <InlineField
            ariaLabel="Bot name"
            className="mt-2 h-8 max-w-60 rounded-[10px] border-transparent bg-transparent px-2 text-center text-[18px] font-semibold shadow-none hover:bg-foreground/[0.04] focus-visible:border-transparent focus-visible:bg-background focus-visible:ring-0"
            onSave={value => void save({ display_name: value })}
            value={bot.display_name}
          />
          <InlineField
            ariaLabel="Title"
            className="h-7 max-w-52 rounded-[10px] border-transparent bg-transparent px-2 text-center text-[length:var(--text-secondary)] text-muted shadow-none placeholder:text-muted/70 hover:bg-foreground/[0.04] focus-visible:border-transparent focus-visible:bg-background focus-visible:text-foreground focus-visible:ring-0"
            onSave={value => void save({ title: value })}
            placeholder="Add a label"
            value={bot.title}
          />
          {status ? (
            <button
              className="hex-bubble hex-focus mt-1.5 flex max-w-full items-center gap-1.5 rounded-full bg-info/10 px-2.5 py-1 text-[length:var(--text-meta)] font-medium text-info"
              onClick={() => setTab('computer')}
              type="button"
            >
              <span className="size-1.5 shrink-0 rounded-full bg-current" />
              <span className="truncate">{status}</span>
            </button>
          ) : null}
        </div>
        {error ? (
          <p
            className="mt-3 text-center text-[length:var(--text-secondary)] text-danger"
            role="alert"
          >
            {error}
          </p>
        ) : null}
        <div
          aria-label="Panel tabs"
          className="mx-auto mt-5 mb-5 flex w-fit gap-0.5 rounded-full bg-foreground/[0.05] p-[3px]"
          onKeyDown={event => {
            const step = { ArrowLeft: -1, ArrowRight: 1 }[event.key]

            if (!step) {
              return
            }

            event.preventDefault()
            const index = TABS.findIndex(item => item.id === tab)
            const next = TABS[(index + step + TABS.length) % TABS.length]!
            setTab(next.id)
            document.getElementById(`panel-tab-${next.id}`)?.focus()
          }}
          role="tablist"
        >
          {TABS.map(item => (
            <button
              aria-controls="panel-tabpanel"
              aria-selected={tab === item.id}
              className={cn(
                'hex-focus relative flex h-7 items-center gap-1.5 rounded-full px-3.5 text-[length:var(--text-secondary)] font-medium transition-colors duration-[var(--hex-motion-fast)]',
                tab === item.id
                  ? 'bg-background text-foreground shadow-card'
                  : 'text-muted hover:text-foreground'
              )}
              id={`panel-tab-${item.id}`}
              key={item.id}
              onClick={() => setTab(item.id)}
              role="tab"
              tabIndex={tab === item.id ? 0 : -1}
              type="button"
            >
              {item.label}
              {item.id === 'computer' && running ? (
                <span aria-hidden className="size-1.5 rounded-full bg-info" />
              ) : null}
            </button>
          ))}
        </div>
        <div
          aria-labelledby={`panel-tab-${tab}`}
          className="hex-fade"
          id="panel-tabpanel"
          key={tab}
          role="tabpanel"
        >
          {tab === 'details' ? <DetailsTab bot={bot} onSave={save} /> : null}
          {tab === 'library' ? <LibraryTab messages={messages} name={bot.display_name} /> : null}
          {tab === 'computer' ? <ComputerTab messages={messages} name={bot.display_name} /> : null}
        </div>
      </div>
    </div>
  )
}
