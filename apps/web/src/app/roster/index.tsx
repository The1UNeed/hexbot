import { useNavigate, useParams } from '@tanstack/react-router'
import { Plus, Search, Settings, SquarePen } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { Avatar, PersonAvatar } from '../../components/ui/avatar'
import { AvatarBuilder } from '../../components/ui/avatar-builder'
import { Button } from '../../components/ui/button'
import { Dialog } from '../../components/ui/dialog'
import { Input } from '../../components/ui/input'
import { ContextMenu, Menu } from '../../components/ui/menu'
import { RoomCluster } from '../../components/ui/room-cluster'
import { Select } from '../../components/ui/select'
import { StatusDot, StatusTag } from '../../components/ui/status-dot'
import { providerModels, sectionsMarkRead } from '../../lib/api'
import { approvalModes } from '../../lib/approval-modes'
import {
  avatarPng,
  type AvatarStyle,
  botFace,
  DEFAULT_AVATAR_STYLE,
  styleForName
} from '../../lib/avatar-builder'
import { toHandle } from '../../lib/bot-handle'
import { getBridge } from '../../lib/bridge'
import { cn } from '../../lib/cn'
import { reasoningOptions, runningLevel } from '../../lib/reasoning'
import { toMillis } from '../../lib/time'
import type { Bot, ModelOption, ReasoningEffort, Room, RoomEvent, Section } from '../../lib/types'
import { useBotList, useBots } from '../../stores/bots'
import { useConnection } from '../../stores/connection'
import { useDrafts } from '../../stores/drafts'
import { useMe } from '../../stores/me'
import { roomStatus, roomUnread, useRoomList, useRooms } from '../../stores/rooms'
import {
  botStatusWithLive,
  introduceBot,
  type LiveSections,
  liveSectionsOf,
  sectionsActions,
  useSections
} from '../../stores/sections'
import { useSettings } from '../../stores/settings'
import { useTranscripts } from '../../stores/transcripts'
import { rememberedTab } from '../bot-settings'
import { UpdatePill } from '../update-pill'

const DAY = 86_400_000

const rowClass =
  'flex w-full items-center gap-3 rounded-panel px-2.5 py-2.5 text-left outline-none transition-colors duration-[var(--hex-motion-fast)] hover:bg-foreground/[0.04] data-[popup-open]:bg-foreground/[0.04]'

const rowFocus = 'ring-1 ring-foreground/40'

// Stable empty array: a fresh [] per render would re-render forever.
const NO_EVENTS: RoomEvent[] = []

export function relativeTime(raw: number | null): string {
  const value = toMillis(raw)

  if (!value) {
    return ''
  }

  const elapsed = Math.max(0, Date.now() - value)

  if (elapsed < 60_000) {
    return 'now'
  }

  if (elapsed < 3_600_000) {
    return `${Math.floor(elapsed / 60_000)}m`
  }

  if (elapsed < DAY) {
    return `${Math.floor(elapsed / 3_600_000)}h`
  }

  if (elapsed < 7 * DAY) {
    return `${Math.floor(elapsed / DAY)}d`
  }

  return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(value)
}

export const orderedBots = (bots: Bot[]) =>
  [...bots].sort((a, b) => toMillis(b.last_activity_at) - toMillis(a.last_activity_at))

export function Field({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <label className="grid gap-1.5">
      <span className="text-[length:var(--text-secondary)] text-muted">{label}</span>
      {children}
    </label>
  )
}

export type RosterItem = { item: Bot | Room; kind: 'bot' | 'room' }

export const orderedRosterItems = (bots: Bot[], rooms: Room[]): RosterItem[] =>
  [
    ...bots.map(item => ({ item, kind: 'bot' as const })),
    ...rooms.filter(room => !room.archived_at).map(item => ({ item, kind: 'room' as const }))
  ].sort((a, b) => toMillis(b.item.last_activity_at) - toMillis(a.item.last_activity_at))

function RoomRow({
  active,
  focused,
  onOpen,
  onSettings,
  query,
  room
}: {
  active: boolean
  focused: string | null
  onOpen: (id: string) => void
  onSettings: (id: string) => void
  query: string
  room: Room
}) {
  const bots = useBots(state => state.byName)
  const events = useRooms(state => state.eventsByRoom[room.id] ?? NO_EVENTS)
  const turns = useRooms(state => state.liveTurnsByRoom[room.id])
  const currentId = useMe(state => state.me?.id)

  if (query && !room.name.toLowerCase().includes(query)) {
    return null
  }

  const active_ = room.members.filter(member => member.member_kind === 'bot' && !member.left_at)
  const latest = events.at(-1)
  const status = roomStatus(events, turns)
  const dot = status === 'idle' && roomUnread(room, events, currentId) ? 'done' : status

  return (
    <ContextMenu items={[{ label: 'Settings', onSelect: () => onSettings(room.id) }]}>
      <button
        className={cn(
          rowClass,
          active && 'bg-background shadow-card',
          focused === `room:${room.id}` && rowFocus
        )}
        data-roster-id={`room:${room.id}`}
        onClick={() => onOpen(room.id)}
        type="button"
      >
        <RoomCluster bots={bots} room={room} status={dot} />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate font-semibold">{room.name}</span>
            <StatusTag status={status} />
          </span>
          <span className="block truncate text-[length:var(--text-secondary)] text-muted">
            {typeof latest?.payload.text === 'string'
              ? latest.payload.text
              : `${active_.length} bot${active_.length === 1 ? '' : 's'}`}
          </span>
        </span>
      </button>
    </ContextMenu>
  )
}

interface BotRowProps {
  active: boolean
  bot: Bot
  draft: boolean
  focused: string | null
  live: LiveSections
  onOpen: (bot: string) => void
  onSettings: (bot: string) => void
  query: string
  sections: Section[]
}

/** A bot and its one chat with you: opening the row opens the chat. */
function BotRow({
  active,
  bot,
  draft,
  focused,
  live,
  onOpen,
  onSettings,
  query,
  sections
}: BotRowProps) {
  if (query && !`${bot.display_name} ${bot.name}`.toLowerCase().includes(query)) {
    return null
  }

  // Prefer the live sections store; the bot row's recent list can lag behind.
  const available = [
    ...sections,
    ...bot.sections_recent.filter(recent => !sections.some(section => section.id === recent.id))
  ]

  const label = bot.title || bot.description
  const status = botStatusWithLive(bot, available, live)

  // A turn finished that you have not seen on any device.
  const dot =
    status === 'idle' && !active && available.some(section => section.done_at) ? 'done' : status

  return (
    <ContextMenu items={[{ label: 'Settings', onSelect: () => onSettings(bot.name) }]}>
      <button
        className={cn(
          rowClass,
          active && 'bg-background shadow-card',
          focused === `bot:${bot.name}` && rowFocus
        )}
        data-roster-id={`bot:${bot.name}`}
        onClick={() => onOpen(bot.name)}
        type="button"
      >
        <span className="relative shrink-0">
          <Avatar {...botFace(bot)} name={bot.display_name} size="lg" />
          <StatusDot status={dot} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate font-semibold">{bot.display_name}</span>
            {status === 'idle' && draft ? (
              <SquarePen aria-label="Draft" className="shrink-0 text-muted" size={12} />
            ) : (
              <StatusTag status={status} />
            )}
          </span>
          {label ? (
            <span className="block truncate text-[length:var(--text-secondary)] text-muted">
              {label}
            </span>
          ) : null}
        </span>
      </button>
    </ContextMenu>
  )
}

export function RosterColumn() {
  const params = useParams({ strict: false }) as { bot?: string; section?: string }
  const navigate = useNavigate()
  const bots = useBotList()
  const rooms = useRoomList()
  const sectionMap = useSections(state => state.byId)
  const drafts = useDrafts(state => state.byId)
  const connection = useConnection()
  const me = useMe(state => state.me)
  const [query, setQuery] = useState('')
  const [botDialog, setBotDialog] = useState(false)
  const [roomDialog, setRoomDialog] = useState(false)

  const [newBot, setNewBot] = useState<{
    model: string
    name: string
    provider: string
    reasoning: null | ReasoningEffort
  }>({ model: '', name: '', provider: '', reasoning: null })

  const [newBotError, setNewBotError] = useState<null | string>(null)
  const [creatingBot, setCreatingBot] = useState(false)
  const [showModel, setShowModel] = useState(false)

  const [newStyle, setNewStyle] = useState<AvatarStyle>(DEFAULT_AVATAR_STYLE)
  const [newModels, setNewModels] = useState<ModelOption[]>([])
  const providers = useSettings(state => state.providers)
  const settings = useSettings(state => state.settings)

  const configuredProviders = useMemo(
    () => providers.filter(item => item.configured === true),
    [providers]
  )

  useEffect(() => {
    if (!botDialog) {
      return
    }

    void useSettings.getState().refreshProviders()
    void useSettings.getState().refresh()
    const [provider, ...rest] = (settings?.default_model ?? '').split('/')
    setNewBot(value => ({
      ...value,
      model: value.model || rest.join('/'),
      provider: value.provider || provider || ''
    }))
  }, [botDialog, settings?.default_model])
  // Each open starts at the default level, which the collapsed summary implies.
  useEffect(() => {
    if (botDialog) {
      setNewBot(value => ({ ...value, reasoning: null }))
    }
  }, [botDialog])
  useEffect(() => {
    if (!newBot.provider) {
      return
    }

    // A slower answer for a provider no longer chosen is dropped.
    let current = true
    void providerModels(newBot.provider)
      .then(list => {
        if (!current) {
          return
        }

        setNewModels(list)
        setNewBot(value => ({
          ...value,
          model: list.some(item => item.id === value.model) ? value.model : (list[0]?.id ?? '')
        }))
      })
      .catch(() => current && setNewModels([]))

    return () => {
      current = false
    }
  }, [newBot.provider])

  const newModel = newModels.find(item => item.id === newBot.model)
  const [focused, setFocused] = useState<string | null>(null)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!useBots.getState().loaded) {
      void useBots.getState().refresh()
    }
  }, [])
  useEffect(() => {
    if (!useRooms.getState().order.length) {
      void useRooms.getState().refresh()
    }
  }, [])

  // The store only learns a section once it opens; the bot's own list knows it sooner.
  const activeSectionDoneAt = params.section
    ? (
        sectionMap[params.section] ??
        bots.flatMap(bot => bot.sections_recent).find(section => section.id === params.section)
      )?.done_at
    : null

  useEffect(() => {
    if (params.section && activeSectionDoneAt) {
      void sectionsMarkRead(params.section).catch(() => undefined)
    }
  }, [activeSectionDoneAt, params.section])
  const streamingSessions = useTranscripts(state => state.bySession)

  const liveSections = useMemo(() => liveSectionsOf(streamingSessions), [streamingSessions])

  const ordered = useMemo(() => orderedBots(bots), [bots])
  const roster = useMemo(() => orderedRosterItems(bots, rooms), [bots, rooms])

  const anyMatch =
    !query ||
    roster.some(entry =>
      (entry.kind === 'room'
        ? (entry.item as Room).name
        : `${(entry.item as Bot).display_name} ${(entry.item as Bot).name}`
      )
        .toLowerCase()
        .includes(query)
    )

  const open = (bot: string, section: string) => {
    void sectionsActions()
      .open(section)
      .catch(() => undefined)
    void navigate({ to: '/b/$bot/s/$section', params: { bot, section } })
  }

  const openRoom = (room: string) => void navigate({ to: '/r/$room', params: { room } })

  const openRoomSettings = (room: string) =>
    void navigate({ to: '/r/$room/settings', params: { room } })

  const openBotSettings = (bot: string) =>
    void navigate({ to: '/b/$bot/settings/$tab', params: { bot, tab: rememberedTab(bot) } })

  /** The bot's one chat: the one this window knows, else the daemon's, made on first use. */
  const openChat = async (bot: string) => {
    const known = Object.values(useSections.getState().byId).find(
      item => item.bot === bot && !item.archived_at
    )

    open(bot, (known ?? (await sectionsActions().chat(bot))).id)
  }

  const keyboard = (event: React.KeyboardEvent) => {
    const target = event.target as HTMLElement

    // Only the search box and rows take roster keys. Buttons keep their own, and
    // menus and dialogs, whose keys reach here through their portals, keep theirs.
    if (
      !['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key) ||
      !root.current?.contains(target) ||
      (target.tagName !== 'INPUT' && !target.closest('[data-roster-id]'))
    ) {
      return
    }

    const ids = [...(root.current?.querySelectorAll<HTMLElement>('[data-roster-id]') ?? [])]
      .map(node => node.dataset.rosterId!)
      .filter(Boolean)

    if (!ids.length) {
      return
    }

    event.preventDefault()

    if (event.key === 'Enter') {
      root.current?.querySelector<HTMLElement>(`[data-roster-id="${focused}"]`)?.click()
    } else {
      const index = Math.max(0, ids.indexOf(focused ?? ''))
      setFocused(
        ids[(index + (event.key === 'ArrowDown' ? 1 : -1) + ids.length) % ids.length] ?? null
      )
    }
  }

  const label =
    connection.status === 'connected'
      ? connection.daemon?.daemon_name || 'Connected'
      : connection.status === 'reconnecting'
        ? `Reconnecting ${connection.attempt}`
        : connection.status

  const dot =
    connection.status === 'connected'
      ? 'bg-success'
      : ['connecting', 'reconnecting'].includes(connection.status)
        ? 'bg-warning'
        : 'bg-danger'

  const macTitleBar = getBridge()?.platform === 'darwin'

  const activeRoom = (params as { room?: string }).room

  const footerRow =
    'flex w-full items-center gap-3 rounded-panel px-2.5 py-2 text-left outline-none transition-colors hover:bg-foreground/[0.04]'

  const footerIcon =
    'grid size-7 shrink-0 place-items-center rounded-full border border-border text-foreground'

  return (
    <div className="flex h-full min-h-0 flex-col" onKeyDown={keyboard} ref={root}>
      <header className={cn('hex-drag shrink-0 px-3 pb-2', macTitleBar ? 'pt-[42px]' : 'pt-3')}>
        <div className="hex-no-drag flex items-center gap-2">
          <label className="relative block min-w-0 flex-1">
            <Search className="absolute top-1/2 left-3 -translate-y-1/2 text-muted" size={14} />
            <Input
              aria-label="Search bots and rooms"
              className="h-9 rounded-full border-transparent bg-foreground/[0.05] pl-9 focus-visible:border-transparent focus-visible:bg-background focus-visible:shadow-card"
              onChange={event => setQuery(event.target.value.toLowerCase())}
              placeholder="Search"
              value={query}
            />
          </label>
          <Menu
            items={[
              {
                label: 'New bot',
                onSelect: () => {
                  // Start each new bot on a different face than the last.
                  setNewStyle(styleForName(`bot-${ordered.length}`))
                  setBotDialog(true)
                }
              },
              {
                'data-testid': 'roster-new-room',
                disabled: !ordered.length,
                label: 'New room',
                onSelect: () => setRoomDialog(true)
              }
            ]}
            trigger={
              <button
                aria-label="New"
                className="hex-glass hex-glass-press grid size-9 shrink-0 place-items-center rounded-full text-foreground/75 hover:text-foreground"
                type="button"
              >
                <Plus size={18} />
              </button>
            }
          />
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
        {useBots.getState().loaded && ordered.length === 0 ? (
          <button
            className={cn(rowClass, 'bg-surface-2/60')}
            onClick={() => setBotDialog(true)}
            type="button"
          >
            <span className={cn(footerIcon, 'size-10')}>
              <Plus size={18} />
            </span>
            <span className="font-semibold">Create new</span>
          </button>
        ) : null}
        {query && !anyMatch ? (
          <p className="px-3 py-6 text-center text-[length:var(--text-secondary)] text-muted">
            No bots or rooms match “{query}”.
          </p>
        ) : null}
        {roster.map(entry =>
          entry.kind === 'room' ? (
            <RoomRow
              active={activeRoom === (entry.item as Room).id}
              focused={focused}
              key={`room:${(entry.item as Room).id}`}
              onOpen={openRoom}
              onSettings={openRoomSettings}
              query={query}
              room={entry.item as Room}
            />
          ) : (
            <BotRow
              active={Boolean(params.section) && params.bot === (entry.item as Bot).name}
              bot={entry.item as Bot}
              draft={Object.values(sectionMap).some(
                section => section.bot === (entry.item as Bot).name && Boolean(drafts[section.id])
              )}
              focused={focused}
              key={`bot:${(entry.item as Bot).name}`}
              live={liveSections}
              onOpen={name => void openChat(name)}
              onSettings={openBotSettings}
              query={query}
              sections={Object.values(sectionMap).filter(
                section => section.bot === (entry.item as Bot).name
              )}
            />
          )
        )}
      </div>
      <div className="shrink-0 px-2 pb-2">
        <UpdatePill className="mb-1 w-full" />
        <div className={cn(footerRow, 'hover:bg-transparent')}>
          <span className="relative">
            <PersonAvatar name={me?.display_name ?? 'You'} />
            <span
              className={cn(
                'absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full border-2 border-surface',
                dot
              )}
              title={label}
            />
          </span>
          <span className="min-w-0 flex-1 truncate font-medium">
            {me?.display_name ?? 'You'}
          </span>
          <button
            aria-label="Settings"
            className="grid size-7 place-items-center rounded-full border border-border text-muted transition-colors hover:bg-surface-2 hover:text-foreground"
            onClick={() => void navigate({ to: '/settings/$tab', params: { tab: 'providers' } })}
            type="button"
          >
            <Settings size={14} />
          </button>
        </div>
      </div>
      <Dialog
        description="A face and a name. It will ask you the rest in your chat."
        onOpenChange={value => {
          setBotDialog(value)

          if (!value) {
            setShowModel(false)
            setNewBotError(null)
          }
        }}
        open={botDialog}
        title="New bot"
      >
        <form
          className="grid gap-4 p-5"
          onSubmit={event => {
            event.preventDefault()
            const handle = toHandle(newBot.name)

            if (!handle) {
              setNewBotError('Give the bot a name with at least one letter or digit.')

              return
            }

            setNewBotError(null)
            setCreatingBot(true)
            const displayName = newBot.name.trim()
            void avatarPng(newStyle)
              .then(avatar =>
                useBots.getState().create({
                  display_name: displayName,
                  model: newBot.model,
                  name: handle,
                  provider: newBot.provider,
                  ...(newBot.reasoning
                    ? { reasoning_effort: runningLevel(newBot.reasoning, newModel) }
                    : {}),
                  ...(avatar ? { avatar } : {}),
                  face: newStyle
                })
              )
              .then(async ({ bot, section }) => {
                setBotDialog(false)
                setNewBot(value => ({ ...value, name: '' }))
                open(bot.name, section.id)
                await introduceBot(section, bot)
              })
              .catch(error =>
                setNewBotError(error instanceof Error ? error.message : String(error))
              )
              .finally(() => setCreatingBot(false))
          }}
        >
          <AvatarBuilder onChange={setNewStyle} value={newStyle} />
          <Field label="Name">
            <Input
              aria-label="Bot name"
              autoFocus
              onChange={event => setNewBot(value => ({ ...value, name: event.target.value }))}
              placeholder="research"
              required
              value={newBot.name}
            />
          </Field>
          {showModel || !newBot.provider || !newBot.model ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Provider">
                <Select
                  label="Provider"
                  onValueChange={provider => {
                    // The old provider's models must not be created with the new provider.
                    setNewModels([])
                    setNewBot(value => ({ ...value, model: '', provider }))
                  }}
                  options={configuredProviders.map(item => ({ label: item.label, value: item.id }))}
                  placeholder="Provider"
                  value={newBot.provider || undefined}
                />
              </Field>
              <Field label="Model">
                <Select
                  label="Model"
                  onValueChange={model => setNewBot(value => ({ ...value, model }))}
                  options={newModels.map(item => ({ label: item.label, value: item.id }))}
                  placeholder="Model"
                  value={newBot.model || undefined}
                />
              </Field>
              <Field label="Reasoning">
                <Select
                  label="Reasoning"
                  onValueChange={reasoning =>
                    setNewBot(value => ({ ...value, reasoning: reasoning as ReasoningEffort }))
                  }
                  options={reasoningOptions(newModel)}
                  value={runningLevel(newBot.reasoning ?? 'medium', newModel)}
                />
              </Field>
            </div>
          ) : (
            <p className="flex items-center gap-2 text-[length:var(--text-secondary)] text-muted">
              <span className="min-w-0 truncate">
                Runs on {newModel?.label ?? newBot.model}
              </span>
              <button
                className="shrink-0 underline-offset-2 hover:text-foreground hover:underline"
                onClick={() => setShowModel(true)}
                type="button"
              >
                Change
              </button>
            </p>
          )}
          {newBotError ? (
            <p className="text-[length:var(--text-secondary)] text-danger" role="alert">
              {newBotError}
            </p>
          ) : null}
          <div className="flex justify-end gap-2 pt-1">
            <Button onClick={() => setBotDialog(false)} variant="ghost">
              Cancel
            </Button>
            <Button
              busy={creatingBot}
              disabled={!newBot.provider || !newBot.model || !newBot.name.trim()}
              type="submit"
              variant="primary"
            >
              Create bot
            </Button>
          </div>
        </form>
      </Dialog>
      <NewRoomDialog onClose={() => setRoomDialog(false)} onCreated={openRoom} open={roomDialog} />
    </div>
  )
}

function NewRoomDialog({
  onClose,
  onCreated,
  open
}: {
  onClose: () => void
  onCreated: (id: string) => void
  open: boolean
}) {
  const bots = useBotList()
  const role = useMe(state => state.me?.role)
  const settings = useSettings(state => state.settings)
  const [name, setName] = useState('')
  const [query, setQuery] = useState('')
  const [members, setMembers] = useState<string[]>([])
  const [mainBot, setMainBot] = useState('')
  const [approvalMode, setApprovalMode] = useState(settings?.approval_mode ?? 'smart')
  const [turns, setTurns] = useState(String(settings?.room_bot_turns_per_human_turn ?? 8))
  const [budget, setBudget] = useState(String(settings?.room_budget_tokens_per_human_turn ?? ''))
  const [error, setError] = useState<string | null>(null)
  // Settings can arrive after the dialog first renders; each opening starts from them.
  useEffect(() => {
    if (open) {
      setApprovalMode(settings?.approval_mode ?? 'smart')
      setTurns(String(settings?.room_bot_turns_per_human_turn ?? 8))
      setBudget(String(settings?.room_budget_tokens_per_human_turn ?? ''))
    }
  }, [open, settings])

  return (
    <Dialog onOpenChange={value => !value && onClose()} open={open} title="New room">
      <form
        className="grid gap-4 p-5"
        onSubmit={event => {
          event.preventDefault()
          void useRooms
            .getState()
            .create({
              approval_mode: approvalMode,
              limits: {
                bot_turns_per_human_turn: Number(turns),
                budget_tokens_per_human_turn: budget ? Number(budget) : null
              },
              main_bot: mainBot || undefined,
              members,
              name: name.trim()
            })
            .then(room => {
              onClose()
              onCreated(room.id)
            })
            .catch(reason => setError(String(reason)))
        }}
      >
        <Input
          aria-label="Room name"
          onChange={event => setName(event.target.value)}
          placeholder="Room name"
          required
          value={name}
        />
        <Input
          aria-label="Search bots"
          onChange={event => setQuery(event.target.value)}
          placeholder="Search bots"
          value={query}
        />
        <fieldset className="max-h-44 overflow-auto border-y border-border">
          <legend className="sr-only">Members</legend>
          {bots
            .filter(bot =>
              `${bot.display_name} ${bot.name}`.toLowerCase().includes(query.toLowerCase())
            )
            .map(bot => (
              <label className="flex items-center gap-3 py-2" key={bot.name}>
                <input
                  checked={members.includes(bot.name)}
                  onChange={event =>
                    setMembers(items =>
                      event.target.checked
                        ? [...items, bot.name]
                        : items.filter(item => item !== bot.name)
                    )
                  }
                  type="checkbox"
                />
                <Avatar {...botFace(bot)} name={bot.display_name} size="sm" />
                <span>{bot.display_name}</span>
              </label>
            ))}
        </fieldset>
        <label className="grid gap-1">
          <span>
            Main bot <span className="text-muted">(optional)</span>
          </span>
          <Select
            label="Main bot"
            onValueChange={value => setMainBot(value === '__none' ? '' : value)}
            options={[
              { label: 'No main bot', value: '__none' },
              ...members.map(name => ({
                label: useBots.getState().byName[name]?.display_name ?? name,
                value: name
              }))
            ]}
            placeholder="No main bot"
            value={mainBot || '__none'}
          />
        </label>
        <label className="grid gap-1">
          <span>Approval mode</span>
          <Select
            label="Room approval mode"
            onValueChange={value => setApprovalMode(value as typeof approvalMode)}
            options={approvalModes(role, approvalMode).map(({ label, value }) => ({ label, value }))}
            value={approvalMode}
          />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="grid gap-1">
            <span>Bot turns</span>
            <Input
              aria-label="Bot turns per human turn"
              min="1"
              onChange={event => setTurns(event.target.value)}
              type="number"
              value={turns}
            />
          </label>
          <label className="grid gap-1">
            <span>Token budget</span>
            <Input
              aria-label="Token budget per human turn"
              min="1"
              onChange={event => setBudget(event.target.value)}
              placeholder="No limit"
              type="number"
              value={budget}
            />
          </label>
        </div>
        {error ? (
          <p className="text-danger" role="alert">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose} variant="ghost">
            Cancel
          </Button>
          <Button
            disabled={!name.trim() || !members.length}
            type="submit"
            variant="primary"
          >
            Create room
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
