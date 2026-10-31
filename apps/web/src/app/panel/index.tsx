import { useNavigate } from '@tanstack/react-router'
import {
  Bell,
  Brain,
  ChevronRight,
  ChevronsRight,
  Cpu,
  File,
  ImageIcon,
  LayoutTemplate,
  type LucideIcon,
  Plug,
  ScrollText,
  Search,
  Settings,
  Sparkles,
  Wrench
} from 'lucide-react'
import { useMemo, useState } from 'react'

import { Switch } from '../../components/ui/switch'
import { cn } from '../../lib/cn'
import type { Attachment, Bot } from '../../lib/types'
import { useBots } from '../../stores/bots'
import { searchActions, useSearch } from '../../stores/search'
import { useLiveSessionId } from '../../stores/sections'
import { type TranscriptMessage, useTranscript } from '../../stores/transcripts'
import { type PanelTab, useUi } from '../../stores/ui'
import { visualsActions } from '../../stores/visuals'
import { type BotSettingsTab, rememberedTab } from '../bot-settings'
import { AvatarPicker, errorText, InlineField, type SaveBot } from '../bot-settings/shared'
import { activityLabel } from '../conversation/steps'
import { visualsOf } from '../conversation/visual'

import { ComputerTab } from './computer'
import {
  FingerprintEditor,
  type FingerprintFile,
  FingerprintTab,
  useBotMemory
} from './fingerprint'
import { Empty, headingClass, listClass, rowClass, RowIcon, shortTime } from './rows'
import { chatEntries, type SearchDocument } from './search'
import { hideBotPanel, SearchField, SearchResults } from './search-panel'

// Stable empty value: a fresh [] per render would re-run the tabs' memos.
const NO_MESSAGES: TranscriptMessage[] = []

const TABS: { id: PanelTab; label: string }[] = [
  { id: 'details', label: 'Details' },
  { id: 'library', label: 'Library' },
  { id: 'fingerprint', label: 'Fingerprint' },
  { id: 'computer', label: 'Computer' }
]

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
        <h3 className={headingClass}>Description</h3>
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

/** Every visual the bot drew, image and file shared in the section, newest first. */
function LibraryTab({ messages, name }: { messages: TranscriptMessage[]; name: string }) {
  const items = useMemo(
    () => messages.flatMap(message => message.attachments).reverse(),
    [messages]
  )

  const visuals = useMemo(
    () =>
      messages
        .flatMap(message =>
          message.role === 'assistant'
            ? visualsOf(message).map(visual => ({ at: message.sentAt, visual }))
            : []
        )
        .reverse(),
    [messages]
  )

  const images = items.filter(item => item.kind === 'image' && item.dataUrl)
  const files = items.filter(item => !(item.kind === 'image' && item.dataUrl))

  if (!items.length && !visuals.length) {
    return (
      <Empty
        icon={ImageIcon}
        text={`Visuals ${name} draws and the images and files you share show up here.`}
      />
    )
  }

  return (
    <div className="grid gap-5">
      {visuals.length ? (
        <section>
          <h3 className={headingClass}>Visuals</h3>
          <ul className={listClass}>
            {visuals.map(({ at, visual }) => (
              <li key={visual.toolId}>
                <button
                  className={rowClass}
                  onClick={() => visualsActions().open(visual)}
                  type="button"
                >
                  <RowIcon icon={LayoutTemplate} />
                  <span className="min-w-0 flex-1 truncate font-medium">{visual.title}</span>
                  <span className="shrink-0 text-[length:var(--text-meta)] text-muted">
                    {shortTime(at)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {images.length ? (
        <section>
          <h3 className={headingClass}>Images</h3>
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
        </section>
      ) : null}
      {files.length ? (
        <section>
          <h3 className={headingClass}>Files</h3>
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
        </section>
      ) : null}
    </div>
  )
}

/**
 * The panel's two buttons. Close alone at first; as the panel opens it
 * splits, once, into Search and Close.
 */
function PanelActions({
  onClose,
  onSearch,
  searching
}: {
  onClose: () => void
  onSearch: () => void
  searching: boolean
}) {
  const button =
    'hex-focus grid size-8 shrink-0 place-items-center rounded-full text-muted transition-colors duration-[var(--hex-motion-fast)] hover:bg-foreground/[0.06] hover:text-foreground'

  return (
    <div className="hex-no-drag hex-split flex w-[4.25rem] shrink-0 items-center justify-end gap-1 overflow-hidden">
      <button
        aria-label={searching ? 'Close search' : 'Search this chat'}
        aria-pressed={searching}
        className={cn(button, 'hex-split-in', searching && 'bg-foreground/[0.07] text-foreground')}
        onClick={onSearch}
        title="Search"
        type="button"
      >
        <Search size={15} />
      </button>
      <button aria-label="Hide settings" className={button} onClick={onClose} type="button">
        <ChevronsRight size={16} />
      </button>
    </div>
  )
}

/** Memory steps the bot finished in the chat: each one means its memory changed. */
const memoryWrites = (messages: TranscriptMessage[]) =>
  messages.reduce(
    (count, message) =>
      count +
      message.toolCalls.filter(call => call.name === 'memory' && call.status === 'ok').length,
    0
  )

/**
 * The side panel, opened from the name pill above the chat: the bot's face,
 * name and label, then four tabs. Details holds the description, the model,
 * notifications and the doors into Bot settings. Library collects the visuals
 * and what was shared in the section. Fingerprint holds its soul and memory.
 * Computer shows the bot's own computer, live, and every step the bot took.
 * Search, beside Close, looks through the whole chat.
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
  const searching = useSearch(state => state.open)
  const [editing, setEditing] = useState<FingerprintFile | null>(null)
  const writes = useMemo(() => memoryWrites(messages), [messages])

  const [memory, setMemory] = useBotMemory(
    bot?.name ?? '',
    Boolean(bot) && (tab === 'fingerprint' || searching || editing === 'memory'),
    writes
  )

  const entries = useMemo(
    () => (searching ? chatEntries(messages, { bot: bot?.display_name ?? 'Bot' }) : []),
    [bot?.display_name, messages, searching]
  )

  const documents = useMemo<SearchDocument[]>(
    () => [
      { kind: 'soul', text: bot?.persona ?? '', title: 'Soul' },
      { kind: 'memory', text: memory?.memory_md ?? '', title: 'Memory' }
    ],
    [bot?.persona, memory?.memory_md]
  )

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
      <header className="hex-drag flex h-14 shrink-0 items-center justify-end gap-2 px-3">
        {searching ? (
          <SearchField
            label={`Search your chat with ${bot.display_name}`}
            onLeave={searchActions().close}
          />
        ) : null}
        <PanelActions
          onClose={() => closePanel(false)}
          onSearch={() => searchActions().setOpen(!searching)}
          searching={searching}
        />
      </header>
      {editing ? (
        <FingerprintEditor
          bot={bot}
          file={editing}
          memory={memory}
          onClose={() => setEditing(null)}
          onMemory={setMemory}
        />
      ) : null}
      {searching ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-5">
          <SearchResults
            documents={documents}
            entries={entries}
            hint={`Search messages, files and visuals in your chat with ${bot.display_name}, and its soul and memory.`}
            onDocument={setEditing}
            onLeave={hideBotPanel}
          />
        </div>
      ) : (
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
            className="mt-5 mb-5 flex w-full gap-0.5 rounded-full bg-foreground/[0.05] p-[3px]"
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
                  'hex-focus relative flex h-7 min-w-0 flex-1 items-center justify-center gap-1 rounded-full px-1.5 text-[12.5px] font-medium whitespace-nowrap transition-colors duration-[var(--hex-motion-fast)]',
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
            {tab === 'fingerprint' ? (
              <FingerprintTab bot={bot} memory={memory} onOpen={setEditing} />
            ) : null}
            {tab === 'computer' ? <ComputerTab bot={bot} onSave={save} /> : null}
          </div>
        </div>
      )}
    </div>
  )
}
