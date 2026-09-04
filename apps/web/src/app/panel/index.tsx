import { Link } from '@tanstack/react-router'
import {
  Archive,
  ChevronLeft,
  ChevronRight,
  ChevronsRight,
  Square,
  Trash2,
  Undo2
} from 'lucide-react'
import { type ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { Avatar } from '../../components/ui/avatar'
import { AvatarBuilder } from '../../components/ui/avatar-builder'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Select } from '../../components/ui/select'
import { Switch } from '../../components/ui/switch'
import { Textarea } from '../../components/ui/textarea'
import {
  botMemoryGet,
  botMemorySet,
  coreMemoryGet,
  coreMemorySet,
  dreamingList,
  dreamingRunNow,
  dreamingStatus,
  modelsList,
  sessionInterrupt
} from '../../lib/api'
import { avatarPng, avatarSrc, type AvatarStyle, styleForName } from '../../lib/avatar-builder'
import { cn } from '../../lib/cn'
import type { Bot, CoreMemorySection, Message, ModelOption } from '../../lib/types'
import { useBots } from '../../stores/bots'
import { useSections, useSectionsForBot } from '../../stores/sections'
import { useTranscript } from '../../stores/transcripts'
import { useUi } from '../../stores/ui'
import { Markdown } from '../conversation'

const TABS = ['persona', 'model', 'memory', 'tools', 'skills', 'sections', 'computer'] as const

const TAB_LABELS: Record<PanelTab, string> = {
  computer: 'Computer',
  memory: 'Memory',
  model: 'Model',
  persona: 'Persona',
  sections: 'Sections',
  skills: 'Skills',
  tools: 'Tools'
}

export const cardClass = 'rounded-panel bg-surface-2/70'
export const fieldLabel = 'mb-1.5 block text-[length:var(--text-secondary)] text-muted'
type PanelTab = (typeof TABS)[number]
const MEMORY_SECTIONS: CoreMemorySection[] = ['user', 'household', 'workspace', 'rules']
const MAX_AVATAR_BYTES = 2 * 1024 * 1024
const PANEL_TAB_KEY = 'hexbot.ui.profilePanelTab'
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

function usePersistentPanelTab(): [null | PanelTab, (tab: null | PanelTab) => void] {
  const [tab, setState] = useState<null | PanelTab>(() => {
    const saved = typeof localStorage === 'undefined' ? null : localStorage.getItem(PANEL_TAB_KEY)

    return TABS.includes(saved as PanelTab) ? (saved as PanelTab) : null
  })

  return [
    tab,
    next => {
      setState(next)

      if (next) {
        localStorage.setItem(PANEL_TAB_KEY, next)
      } else {
        localStorage.removeItem(PANEL_TAB_KEY)
      }
    }
  ]
}

const avatarUrl = avatarSrc

export function ProfilePanel(): React.JSX.Element {
  const selectedName = useUi(state => state.lastSection?.bot ?? null)
  const bot = useBots(state => (selectedName ? state.byName[selectedName] : undefined))
  const updateBot = useBots(state => state.update)
  const removeBot = useBots(state => state.remove)
  const closePanel = useUi(state => state.toggleRightPanel)
  const [tab, setTab] = usePersistentPanelTab()
  const [error, setError] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  const [pickerTab, setPickerTab] = useState<'bot' | 'upload'>('bot')
  const [style, setStyle] = useState<AvatarStyle | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  if (!bot) {
    return (
      <div className="grid h-full place-content-center p-5 text-center text-muted">
        Select a bot to see its settings.
      </div>
    )
  }

  const save = async (patch: Parameters<typeof updateBot>[1]) => {
    try {
      setError(null)
      await updateBot(bot.name, patch)
    } catch (cause) {
      setError(errorText(cause))
    }
  }

  const upload = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''

    if (!file) {
      return
    }

    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      return setError('Choose a PNG, JPEG, or WebP image.')
    }

    if (file.size > MAX_AVATAR_BYTES) {
      return setError('Avatar must be 2 MB or smaller.')
    }

    const reader = new FileReader()
    reader.onload = () => void save({ avatar: String(reader.result) })
    reader.onerror = () => setError('Could not read that image.')
    reader.readAsDataURL(file)
  }

  const chooseFace = (next: AvatarStyle) => {
    setStyle(next)
    void avatarPng(next).then(png => {
      if (png) {
        void save({ avatar: png })
      }
    })
  }

  const currentStyle = style ?? styleForName(bot.display_name)

  const header = (
    <header className="hex-drag flex h-11 shrink-0 items-center px-2">
      <button
        aria-label="Back"
        className={cn(
          'hex-no-drag grid size-7 place-items-center rounded-full text-muted transition-colors hover:bg-surface-2 hover:text-foreground',
          tab ? '' : 'invisible'
        )}
        onClick={() => setTab(null)}
        type="button"
      >
        <ChevronLeft size={16} />
      </button>
      <span className="flex-1 text-center text-[length:var(--text-secondary)] font-semibold">
        {tab ? TAB_LABELS[tab] : 'Settings'}
      </span>
      <button
        aria-label="Hide settings"
        className="hex-no-drag grid size-7 place-items-center rounded-full text-muted transition-colors hover:bg-surface-2 hover:text-foreground"
        onClick={() => closePanel(false)}
        type="button"
      >
        <ChevronsRight size={16} />
      </button>
    </header>
  )

  if (tab) {
    return (
      <div className="flex h-screen min-h-0 flex-col" data-testid="profile-panel">
        {header}
        <div className="hex-fade min-h-0 flex-1 overflow-y-auto px-4 pt-1 pb-6" key={tab}>
          {tab === 'persona' && <PersonaTab bot={bot} onSave={save} />}
          {tab === 'model' && <ModelTab bot={bot} onSave={save} />}
          {tab === 'memory' && <MemoryTab bot={bot} onSave={save} />}
          {tab === 'computer' && <ComputerTab />}
          {tab === 'tools' && <ToolsTab bot={bot} onSave={save} />}
          {tab === 'skills' && <SkillsTab bot={bot} onSave={save} />}
          {tab === 'sections' && <SectionsTab botName={bot.name} />}
          {error ? (
            <p className="mt-3 text-[length:var(--text-secondary)] text-danger" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-screen min-h-0 flex-col" data-testid="profile-panel">
      {header}
      <div className="hex-fade min-h-0 flex-1 overflow-y-auto px-4 pt-3 pb-4">
        <div className="flex flex-col items-center">
          <button
            aria-expanded={picking}
            aria-label="Change avatar"
            className="hex-face rounded-full outline-none transition-transform hover:scale-105 focus-visible:ring-2 focus-visible:ring-foreground/40"
            onClick={() => setPicking(value => !value)}
            type="button"
          >
            <Avatar
              image={avatarUrl(bot.avatar)}
              name={bot.display_name}
              size="xl"
              style={currentStyle}
            />
          </button>
          <input
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={upload}
            ref={fileRef}
            type="file"
          />
        </div>
        {picking ? (
          <div className={cn(cardClass, 'hex-bubble mt-4 border border-border')}>
            <div className="flex gap-1 border-b border-border px-2 py-2" role="tablist">
              {(
                [
                  ['bot', 'Bot'],
                  ['upload', 'Upload']
                ] as const
              ).map(([id, label]) => (
                <button
                  aria-selected={pickerTab === id}
                  className={cn(
                    'rounded-control px-2.5 py-1 text-[length:var(--text-secondary)] transition-colors',
                    pickerTab === id
                      ? 'bg-surface-3 text-foreground'
                      : 'text-muted hover:text-foreground'
                  )}
                  key={id}
                  onClick={() => setPickerTab(id)}
                  role="tab"
                  type="button"
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="p-3">
              {pickerTab === 'bot' ? (
                <AvatarBuilder onChange={chooseFace} preview={false} value={currentStyle} />
              ) : (
                <div className="grid gap-2 text-center">
                  <p className="text-[length:var(--text-secondary)] text-muted">
                    PNG, JPEG or WebP up to 2 MB.
                  </p>
                  <Button onClick={() => fileRef.current?.click()} variant="secondary">
                    Choose image
                  </Button>
                  {bot.avatar ? (
                    <Button onClick={() => void save({ avatar: null })} variant="ghost">
                      Use a generated face
                    </Button>
                  ) : null}
                </div>
              )}
            </div>
          </div>
        ) : null}
        <div className="mt-5 grid gap-3">
          <label className="block">
            <span className={fieldLabel}>Name</span>
            <InlineField
              ariaLabel="Bot name"
              onSave={value => save({ display_name: value })}
              value={bot.display_name}
            />
          </label>
          <label className="block">
            <span className={fieldLabel}>Label (optional)</span>
            <InlineField
              ariaLabel="Title"
              onSave={value => save({ title: value })}
              placeholder="Research, marketing, admin"
              value={bot.title}
            />
          </label>
          <label className="block">
            <span className={fieldLabel}>Description</span>
            <InlineField
              ariaLabel="Description"
              multiline
              onSave={value => save({ description: value })}
              placeholder="What this bot is for"
              value={bot.description}
            />
          </label>
        </div>
        {error ? (
          <p className="mt-3 text-[length:var(--text-secondary)] text-danger" role="alert">
            {error}
          </p>
        ) : null}
        <div className={cn(cardClass, 'mt-4 flex items-center justify-between gap-3 px-3 py-2.5')}>
          <span>
            <span className="block font-medium">Shareable</span>
            <span className="block text-[length:var(--text-meta)] text-muted">
              Other users on this daemon can talk to this bot
            </span>
          </span>
          <Switch
            aria-label="Shareable with other users"
            checked={bot.shareable ?? false}
            onCheckedChange={checked => void save({ shareable: checked })}
          />
        </div>
        <div className={cn(cardClass, 'mt-4 divide-y divide-border')} role="tablist">
          {TABS.map(item => (
            <button
              aria-selected={false}
              className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left transition-colors first:rounded-t-panel last:rounded-b-panel hover:bg-surface-2"
              key={item}
              onClick={() => setTab(item)}
              role="tab"
              type="button"
            >
              <span>{TAB_LABELS[item]}</span>
              <ChevronRight className="text-muted" size={15} />
            </button>
          ))}
        </div>
        <div className="mt-6">
          <DeleteBot bot={bot} onDelete={() => removeBot(bot.name)} />
        </div>
      </div>
    </div>
  )
}

interface InlineFieldProps {
  ariaLabel: string
  className?: string
  multiline?: boolean
  onSave: (value: string) => void
  placeholder?: string
  value: string
}

function InlineField({
  ariaLabel,
  className,
  multiline = false,
  onSave,
  placeholder,
  value
}: InlineFieldProps) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])

  if (multiline) {
    return (
      <Textarea
        aria-label={ariaLabel}
        className={className}
        onBlur={() => {
          if (draft !== value) {
            onSave(draft)
          }
        }}
        onChange={event => setDraft(event.target.value)}
        placeholder={placeholder}
        value={draft}
      />
    )
  }

  return (
    <Input
      aria-label={ariaLabel}
      className={className}
      onBlur={() => {
        if (draft !== value) {
          onSave(draft)
        }
      }}
      onChange={event => setDraft(event.target.value)}
      placeholder={placeholder}
      value={draft}
    />
  )
}

function PersonaTab({ bot, onSave }: { bot: Bot; onSave: (patch: { persona: string }) => void }) {
  const [persona, setPersona] = useState(bot.persona)
  useEffect(() => setPersona(bot.persona), [bot.persona])

  return (
    <label className="block">
      <span className={fieldLabel}>How this bot behaves and speaks</span>
      <Textarea
        aria-label="Persona"
        className="min-h-64"
        onBlur={() => {
          if (persona !== bot.persona) {
            onSave({ persona })
          }
        }}
        onChange={event => setPersona(event.target.value)}
        value={persona}
      />
    </label>
  )
}

function ModelTab({
  bot,
  onSave
}: {
  bot: Bot
  onSave: (patch: { model?: string; provider?: string }) => Promise<void> | void
}) {
  const [models, setModels] = useState<{ all: ModelOption[]; curated: ModelOption[] }>({
    all: [],
    curated: []
  })

  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    void modelsList()
      .then(setModels)
      .catch(cause => setError(errorText(cause)))
  }, [])

  const ordered = useMemo(() => {
    const ids = new Set(models.curated.map(item => `${item.provider}:${item.id}`))

    return [
      ...models.curated.map(item => ({ ...item, label: `Recommended · ${item.label}` })),
      ...models.all.filter(item => !ids.has(`${item.provider}:${item.id}`))
    ]
  }, [models])

  const providers = [
    ...new Set(ordered.map(item => item.provider).filter((item): item is string => Boolean(item)))
  ]

  const visible = ordered.filter(item => !bot.provider || item.provider === bot.provider)

  return (
    <div className="space-y-4">
      <label className="block">
        <span className={fieldLabel}>Provider</span>
        <Select
          label="Provider"
          onValueChange={provider => void onSave({ provider })}
          options={providers.map(provider => ({ label: provider, value: provider }))}
          placeholder="Choose a provider"
          value={bot.provider ?? undefined}
        />
      </label>
      <label className="block">
        <span className={fieldLabel}>Model</span>
        <Select
          label="Model"
          onValueChange={model => {
            const found = ordered.find(item => item.id === model)
            void onSave({ model, ...(found?.provider ? { provider: found.provider } : {}) })
          }}
          options={visible.map(item => ({ label: item.label, value: item.id }))}
          placeholder="Choose a model"
          value={bot.model ?? undefined}
        />
      </label>
      {error && (
        <p className="text-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

export function MemorySectionEditor({
  cap,
  label,
  onSave,
  value
}: {
  cap: number
  label: string
  onSave: (value: string) => Promise<void>
  value: string
}) {
  const [draft, setDraft] = useState(value)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => setDraft(value), [value])
  const tooLong = draft.length > cap

  return (
    <label className="block">
      <span className="mb-1.5 flex justify-between text-[length:var(--text-secondary)]">
        <span className="font-medium capitalize">{label}</span>
        <span className={tooLong ? 'text-danger' : 'text-muted'}>
          {draft.length} / {cap}
        </span>
      </span>
      <Textarea
        aria-label={`${label} memory`}
        onBlur={() => {
          if (tooLong) {
            return setError(`Keep this section to ${cap} characters or fewer.`)
          }

          if (draft !== value) {
            void onSave(draft).catch(cause => setError(errorText(cause)))
          }
        }}
        onChange={event => {
          setDraft(event.target.value)
          setError(null)
        }}
        rows={3}
        value={draft}
      />
      {error && (
        <span className="mt-1 block text-[length:var(--text-meta)] text-danger" role="alert">
          {error}
        </span>
      )}
    </label>
  )
}

export function MemoryTab({
  bot,
  onSave
}: {
  bot: Bot
  onSave: (patch: { dream_enabled?: boolean; may_write_core?: boolean }) => Promise<void> | void
}) {
  const botName = bot.name
  const [core, setCore] = useState<Awaited<ReturnType<typeof coreMemoryGet>> | null>(null)
  const [notes, setNotes] = useState<Awaited<ReturnType<typeof botMemoryGet>> | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState({ memory_md: '', user_md: '' })
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    void Promise.all([coreMemoryGet(), botMemoryGet(botName)])
      .then(([a, b]) => {
        setCore(a)
        setNotes(b)
        setDraft(b)
      })
      .catch(cause => setError(errorText(cause)))
  }, [botName])

  if (error) {
    return (
      <p className="text-danger" role="alert">
        {error}
      </p>
    )
  }

  if (!core || !notes) {
    return <p className="text-muted">Loading memory…</p>
  }

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <h3 className="font-semibold">Core memory</h3>
        {MEMORY_SECTIONS.map(section => (
          <MemorySectionEditor
            cap={core.caps.per_section}
            key={section}
            label={section}
            onSave={async text => setCore(await coreMemorySet(section, text))}
            value={core.sections[section]}
          />
        ))}
      </div>
      <div className="border-t border-border pt-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-semibold">Bot notes</h3>
          <Button
            onClick={() => {
              if (editing) {
                setDraft(notes)
              }

              setEditing(!editing)
            }}
            size="sm"
            variant="ghost"
          >
            {editing ? 'Cancel' : 'Edit'}
          </Button>
        </div>
        <label className="mb-3 block">
          <span className="mb-1 block text-muted">Memory</span>
          <Textarea
            aria-label="Bot memory notes"
            disabled={!editing}
            onChange={event => setDraft(value => ({ ...value, memory_md: event.target.value }))}
            rows={4}
            value={draft.memory_md}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-muted">User notes</span>
          <Textarea
            aria-label="Bot user notes"
            disabled={!editing}
            onChange={event => setDraft(value => ({ ...value, user_md: event.target.value }))}
            rows={3}
            value={draft.user_md}
          />
        </label>
        {editing && (
          <Button
            className="mt-3"
            onClick={() =>
              void botMemorySet(botName, draft)
                .then(next => {
                  setNotes(next)
                  setEditing(false)
                })
                .catch(cause => setError(errorText(cause)))
            }
            variant="primary"
          >
            Save notes
          </Button>
        )}
      </div>
      <DreamingBlock bot={bot} onSave={onSave} />
    </div>
  )
}

export function DreamingBlock({
  bot,
  onSave
}: {
  bot: Bot
  onSave: (patch: { dream_enabled?: boolean; may_write_core?: boolean }) => Promise<void> | void
}) {
  const [status, setStatus] = useState<Awaited<ReturnType<typeof dreamingStatus>> | null>(null)
  const [dreams, setDreams] = useState<Awaited<ReturnType<typeof dreamingList>>['dreams']>([])
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const [nextStatus, result] = await Promise.all([
      dreamingStatus(bot.name),
      dreamingList(bot.name)
    ])

    setStatus(nextStatus)
    setDreams(result.dreams)
  }, [bot.name])

  useEffect(() => {
    void load().catch(cause => setError(errorText(cause)))
  }, [load])

  const run = async () => {
    setRunning(true)
    const before = status?.last_run_at

    try {
      await dreamingRunNow(bot.name)

      for (let attempt = 0; attempt < 30; attempt += 1) {
        await new Promise(resolve => window.setTimeout(resolve, 1000))
        const next = await dreamingStatus(bot.name)
        setStatus(next)

        if (next.last_run_at !== before || next.last_status !== status?.last_status) {
          break
        }
      }

      await load()
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setRunning(false)
    }
  }

  const dreamsSection = useSectionsForBot(bot.name).find(section => section.title === 'Dreams')

  return (
    <div className="border-t border-border pt-4">
      <h3 className="font-semibold">Dreaming</h3>
      <p className="mt-1 text-[length:var(--text-secondary)] text-muted">
        Each day, this bot reviews recent conversations and writes useful details to its notes.
      </p>
      <div className={cn(cardClass, 'mt-4 divide-y divide-border')}>
        <div className="flex items-center justify-between gap-3 px-3 py-2.5">
          <span>Enabled for this bot</span>
          <Switch
            aria-label="Enable dreaming"
            checked={bot.dream_enabled ?? true}
            onCheckedChange={checked => void onSave({ dream_enabled: checked })}
          />
        </div>
        <div className="flex items-center justify-between gap-3 px-3 py-2.5">
          <span>May write core memory</span>
          <Switch
            aria-label="May write core memory"
            checked={bot.may_write_core ?? false}
            onCheckedChange={checked => void onSave({ may_write_core: checked })}
          />
        </div>
      </div>
      <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[length:var(--text-secondary)]">
        <dt className="text-muted">Last run</dt>
        <dd>{formatTimestamp(status?.last_run_at)}</dd>
        <dt className="text-muted">Next run</dt>
        <dd>{formatTimestamp(status?.next_run_at)}</dd>
      </dl>
      <Button
        busy={running}
        className="mt-4"
        disabled={!status?.enabled}
        onClick={() => void run()}
      >
        Dream now
      </Button>
      {error ? (
        <p className="mt-2 text-danger" role="alert">
          {error}
        </p>
      ) : null}
      {dreams.length ? (
        <div className="mt-5">
          <h4 className="font-medium">Recent dreams</h4>
          <ul className="mt-2 divide-y divide-border">
            {dreams.map(dream => (
              <li className="py-2" key={dream.id}>
                {dreamsSection ? (
                  <Link
                    className="block hover:text-accent"
                    params={{ bot: bot.name, section: dreamsSection.id }}
                    to="/b/$bot/s/$section"
                  >
                    <div className="line-clamp-2">
                      <Markdown text={dream.summary || dream.status} />
                    </div>
                    <time className="text-[length:var(--text-meta)] text-muted">
                      {formatTimestamp(dream.started_at)}
                    </time>
                  </Link>
                ) : (
                  <span className="line-clamp-2">{dream.summary || dream.status}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}

function formatTimestamp(value: null | number | undefined): string {
  return value ? new Date(value < 1e12 ? value * 1000 : value).toLocaleString() : 'Never'
}

const NO_MESSAGES: Message[] = []

export function ComputerTab({ sessionId }: { sessionId?: string } = {}) {
  const sectionId = useUi(state => state.lastSection?.section ?? null)
  const live = useSections(state => (sectionId ? (state.liveSessionId[sectionId] ?? null) : null))
  const transcript = useTranscript(sessionId ?? live)

  const calls = (transcript?.messages ?? NO_MESSAGES)
    .flatMap(message => message.toolCalls)
    .sort((a, b) => b.startedAt - a.startedAt)

  return (
    <div>
      <p className="text-[length:var(--text-secondary)] text-muted">Working directory</p>
      <p className="mt-0.5 font-mono text-[length:var(--text-secondary)]">
        {transcript?.info?.cwd ?? 'Unknown'}
      </p>
      {(sessionId ?? live) ? (
        <Button
          className="mt-3"
          icon={<Square size={13} />}
          onClick={() => void sessionInterrupt(sessionId ?? live!)}
          variant="danger"
        >
          Stop
        </Button>
      ) : null}
      <h4 className="mt-5 text-[length:var(--text-secondary)] text-muted">Tool activity</h4>
      {calls.length ? (
        <ol className={cn(cardClass, 'mt-2 divide-y divide-border')}>
          {calls.map(call => (
            <li className="px-3 py-2" key={call.toolId}>
              <div className="flex justify-between gap-2">
                <span className="font-mono">{call.name}</span>
                <span
                  className={
                    call.status === 'error'
                      ? 'text-danger'
                      : call.status === 'running'
                        ? 'text-warning'
                        : 'text-success'
                  }
                >
                  {call.status}
                </span>
              </div>
              <p className="text-[length:var(--text-meta)] text-muted">
                {call.durationS == null ? 'Running' : `${call.durationS.toFixed(2)}s`}
              </p>
            </li>
          ))}
        </ol>
      ) : (
        <p className="mt-2 text-muted">No tool activity in this session.</p>
      )}
      <p className="mt-5 text-[length:var(--text-meta)] text-muted">
        Terminal emulation comes later.
      </p>
    </div>
  )
}

const TOOL_OPTIONS = [
  ['terminal', 'Terminal'],
  ['files', 'Files'],
  ['browser', 'Browser'],
  ['web_search', 'Web search'],
  ['computer_use', 'Computer use']
] as const

function ToolsTab({
  bot,
  onSave
}: {
  bot: Bot
  onSave: (patch: { tools: string[] }) => Promise<void> | void
}) {
  const tools = Array.isArray(bot.tools) ? bot.tools : []

  return (
    <fieldset className={cn(cardClass, 'divide-y divide-border')}>
      <legend className="sr-only">Bot tools</legend>
      {TOOL_OPTIONS.map(([id, label]) => (
        <div className="flex items-center justify-between gap-3 px-3 py-2.5" key={id}>
          <span>{label}</span>
          <Switch
            aria-label={label}
            checked={tools.includes(id)}
            onCheckedChange={checked =>
              void onSave({
                tools: checked ? [...tools, id] : tools.filter(tool => tool !== id)
              })
            }
          />
        </div>
      ))}
    </fieldset>
  )
}

function SkillsTab({
  bot,
  onSave
}: {
  bot: Bot
  onSave: (patch: { skills: string[] }) => Promise<void> | void
}) {
  const skills = Array.isArray(bot.skills) ? bot.skills : []
  const [draft, setDraft] = useState('')

  return (
    <div>
      <form
        className="flex gap-2"
        onSubmit={event => {
          event.preventDefault()
          const skill = draft.trim()

          if (skill && !skills.includes(skill)) {
            void onSave({ skills: [...skills, skill] })
            setDraft('')
          }
        }}
      >
        <Input
          aria-label="Skill name"
          onChange={event => setDraft(event.target.value)}
          placeholder="Attach a skill"
          value={draft}
        />
        <Button disabled={!draft.trim()} type="submit">
          Attach
        </Button>
      </form>
      {skills.length ? (
        <ul className={cn(cardClass, 'mt-3 divide-y divide-border')}>
          {skills.map(skill => (
            <li className="flex items-center justify-between py-2 pr-2 pl-3" key={skill}>
              <span>{skill}</span>
              <Button
                aria-label={`Detach ${skill}`}
                onClick={() => void onSave({ skills: skills.filter(item => item !== skill) })}
                size="sm"
                variant="ghost"
              >
                Detach
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-4 text-muted">No skills attached.</p>
      )}
    </div>
  )
}

function SectionsTab({ botName }: { botName: string }) {
  const sections = useSectionsForBot(botName)
  const { archive, refresh, remove, unarchive } = useSections()
  useEffect(() => {
    void refresh({ bot: botName, include_archived: true })
  }, [botName, refresh])

  return (
    <ul className={cn(cardClass, 'divide-y divide-border')}>
      {sections.map(section => (
        <li className="flex items-center gap-2 py-2 pr-2 pl-3" key={section.id}>
          <span className="min-w-0 flex-1 truncate">{section.title}</span>
          {section.archived_at ? (
            <Button
              aria-label={`Unarchive ${section.title}`}
              icon={<Undo2 size={14} />}
              onClick={() => void unarchive(section.id)}
              size="sm"
              variant="ghost"
            />
          ) : (
            <Button
              aria-label={`Archive ${section.title}`}
              icon={<Archive size={14} />}
              onClick={() => void archive(section.id)}
              size="sm"
              variant="ghost"
            />
          )}
          <Button
            aria-label={`Delete ${section.title}`}
            icon={<Trash2 size={14} />}
            onClick={() => {
              if (window.confirm(`Delete “${section.title}” and purge its memory?`)) {
                void remove(section.id)
              }
            }}
            size="sm"
            variant="ghost"
          />
        </li>
      ))}
    </ul>
  )
}

function DeleteBot({ bot, onDelete }: { bot: Bot; onDelete: () => Promise<void> }) {
  const [confirming, setConfirming] = useState(false)
  const [typed, setTyped] = useState('')

  if (!confirming) {
    return (
      <button
        className="w-full rounded-panel px-3 py-2.5 text-center font-medium text-danger transition-colors hover:bg-danger/10"
        onClick={() => setConfirming(true)}
        type="button"
      >
        Delete bot
      </button>
    )
  }

  return (
    <div className={cn(cardClass, 'space-y-3 p-3')}>
      <p className="text-[length:var(--text-secondary)]">
        Type <strong>{bot.name}</strong> to delete this bot and all of its sections.
      </p>
      <Input
        aria-label="Confirm bot name"
        onChange={event => setTyped(event.target.value)}
        value={typed}
      />
      <div className="flex gap-2">
        <Button disabled={typed !== bot.name} onClick={() => void onDelete()} variant="danger">
          Delete permanently
        </Button>
        <Button
          onClick={() => {
            setConfirming(false)
            setTyped('')
          }}
          variant="ghost"
        >
          Cancel
        </Button>
      </div>
    </div>
  )
}
