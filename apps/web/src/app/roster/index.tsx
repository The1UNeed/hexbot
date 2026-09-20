import { useNavigate, useParams } from '@tanstack/react-router'
import {
  Archive,
  ChevronDown,
  ChevronRight,
  MoreHorizontal,
  Plus,
  Search,
  Settings,
  SquarePen
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { Avatar, PersonAvatar } from '../../components/ui/avatar'
import { AvatarBuilder } from '../../components/ui/avatar-builder'
import { Button } from '../../components/ui/button'
import { Dialog } from '../../components/ui/dialog'
import { Input } from '../../components/ui/input'
import { Menu } from '../../components/ui/menu'
import { RoomCluster } from '../../components/ui/room-cluster'
import { Select } from '../../components/ui/select'
import { StatusDot } from '../../components/ui/status-dot'
import { modelsList, sectionsMarkRead } from '../../lib/api'
import {
  avatarPng,
  avatarSrc,
  type AvatarStyle,
  DEFAULT_AVATAR_STYLE,
  styleForName
} from '../../lib/avatar-builder'
import { toHandle } from '../../lib/bot-handle'
import { getBridge } from '../../lib/bridge'
import { cn } from '../../lib/cn'
import { toMillis } from '../../lib/time'
import type { Bot, ModelOption, Room, RoomEvent, Section } from '../../lib/types'
import { useBotList, useBots } from '../../stores/bots'
import { useConnection } from '../../stores/connection'
import { useDrafts } from '../../stores/drafts'
import { roomStatus, roomUnread, useRoomList, useRooms } from '../../stores/rooms'
import {
  botStatusWithLive,
  introduceBot,
  type LiveSections,
  liveSectionsOf,
  sectionsActions,
  sectionStatusOf,
  useSections
} from '../../stores/sections'
import { useSettings } from '../../stores/settings'
import { useTranscripts } from '../../stores/transcripts'
import { useUsers } from '../../stores/users'
import { UpdatePill } from '../update-pill'

const DAY = 86_400_000

const rowClass =
  'flex w-full items-center gap-3 rounded-panel px-2.5 py-2.5 text-left outline-none transition-colors duration-[var(--hex-motion-fast)] hover:bg-surface-2/70'

const rowFocus = 'ring-1 ring-foreground/40'

// Stable empty array: a fresh [] per render would re-render forever.
const NO_EVENTS: RoomEvent[] = []

const avatarData = (bot?: Bot) => avatarSrc(bot?.avatar)

const sectionTime = (section: Section) => toMillis(section.updated_at ?? section.created_at)

/** A section whose bot finished a turn the user has not seen on any device. */
const unseen = (section: Section, active?: string) => section.id !== active && !!section.done_at

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
  query,
  room
}: {
  active: boolean
  focused: string | null
  onOpen: (id: string) => void
  query: string
  room: Room
}) {
  const bots = useBots(state => state.byName)
  const events = useRooms(state => state.eventsByRoom[room.id] ?? NO_EVENTS)
  const turns = useRooms(state => state.liveTurnsByRoom[room.id])

  if (query && !room.name.toLowerCase().includes(query)) {
    return null
  }

  const active_ = room.members.filter(member => member.member_kind === 'bot' && !member.left_at)
  const latest = events.at(-1)
  const status = roomStatus(events, turns)
  const dot = status === 'idle' && roomUnread(room, events) ? 'done' : status

  return (
    <button
      className={cn(rowClass, active && 'bg-surface-2', focused === `room:${room.id}` && rowFocus)}
      data-roster-id={`room:${room.id}`}
      onClick={() => onOpen(room.id)}
      type="button"
    >
      <RoomCluster bots={bots} room={room} status={dot} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate font-semibold">{room.name}</span>
          <span className="shrink-0 text-[length:var(--text-meta)] text-muted">
            {relativeTime(room.last_activity_at)}
          </span>
        </span>
        <span className="block truncate text-[length:var(--text-secondary)] text-muted">
          {typeof latest?.payload.text === 'string'
            ? latest.payload.text
            : `${active_.length} bot${active_.length === 1 ? '' : 's'}`}
        </span>
      </span>
    </button>
  )
}

type Drafts = Record<string, string>

/**
 * A section the user has sent or typed something in. New, untouched ones sort last and
 * stay hidden.
 */
export const touched = (section: Section, drafts: Drafts = {}) =>
  section.message_count > 0 || Boolean(section.preview) || Boolean(drafts[section.id])

/**
 * The sections listed under a bot: touched ones, newest first. Folded, only the two most
 * recent from the last 14 days plus the open section; expanded, every unarchived one.
 */
export function visibleRecentSections(
  bot: Bot,
  expanded: boolean,
  all: Section[],
  active?: string,
  drafts: Drafts = {}
): Section[] {
  const byActivity = (a: Section, b: Section) =>
    Number(touched(b, drafts)) - Number(touched(a, drafts)) || sectionTime(b) - sectionTime(a)

  // Prefer the live sections store; the bot row's recent list can lag behind.
  const sections = [...(all.length ? all : bot.sections_recent)]
    .filter(section => !section.archived_at)
    .sort(byActivity)

  if (expanded) {
    return sections
  }

  const recent = sections
    .filter(section => touched(section, drafts) && Date.now() - sectionTime(section) < 14 * DAY)
    .slice(0, 2)

  const current = sections.find(section => section.id === active)

  return current && !recent.includes(current)
    ? [...recent, current].sort((a, b) => sectionTime(b) - sectionTime(a))
    : recent
}

interface BotRowsProps {
  active?: string
  bot: Bot
  drafts: Drafts
  expanded: boolean
  focused: string | null
  live: LiveSections
  onArchive: (section: Section) => void
  onDelete: (section: Section) => void
  onExpand: () => void
  onOpen: (bot: string, section: string) => void
  onStart: (bot: string) => void
  query: string
  sections: Section[]
}

/** Which of a bot's rows match the roster search: the bot itself, or section titles. */
function matchBot(bot: Bot, sections: Section[], query: string) {
  const matchesBot = `${bot.display_name} ${bot.name}`.toLowerCase().includes(query)

  const available = [
    ...sections,
    ...bot.sections_recent.filter(recent => !sections.some(section => section.id === recent.id))
  ]

  const matching = available.filter(section => section.title.toLowerCase().includes(query))

  return { available, matchesBot, matching }
}

function BotRows({
  active,
  bot,
  drafts,
  expanded,
  focused,
  live,
  onArchive,
  onDelete,
  onExpand,
  onOpen,
  onStart,
  query,
  sections
}: BotRowsProps) {
  const { available, matchesBot, matching } = matchBot(bot, sections, query)

  if (query && !matchesBot && matching.length === 0) {
    return null
  }

  const rows = query ? matching : visibleRecentSections(bot, expanded, available, active, drafts)

  const canExpand =
    !query &&
    (expanded ||
      available.filter(section => !section.archived_at).length > rows.length ||
      bot.sections_total > rows.length)

  const selected = rows.length === 0 && bot.sections_recent.some(section => section.id === active)
  const label = bot.title || bot.description
  const status = botStatusWithLive(bot, available, live)

  const dot =
    status === 'idle' && available.some(section => !section.archived_at && unseen(section, active))
      ? 'done'
      : status

  return (
    <div data-testid="bot-group">
      <button
        className={cn(
          rowClass,
          selected && 'bg-surface-2',
          focused === `bot:${bot.name}` && rowFocus
        )}
        data-roster-id={`bot:${bot.name}`}
        onClick={() => onStart(bot.name)}
        type="button"
      >
        <span className="relative shrink-0">
          <Avatar image={avatarData(bot)} name={bot.display_name} size="lg" />
          <StatusDot status={dot} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate font-semibold">{bot.display_name}</span>
            <span className="shrink-0 text-[length:var(--text-meta)] text-muted">
              {relativeTime(bot.last_activity_at)}
            </span>
          </span>
          {label ? (
            <span className="block truncate text-[length:var(--text-secondary)] text-muted">
              {label}
            </span>
          ) : null}
        </span>
      </button>
      {rows.length > 0 || canExpand ? (
        <div className="mb-1 ml-5 flex flex-col gap-px border-l border-border pr-1 pl-1.5">
          {rows.map(section => {
            const status = sectionStatusOf(bot, section.id, live)
            const dot = status === 'idle' && unseen(section, active) ? 'done' : status

            return (
              <div
                className={cn(
                  'group/row flex items-center rounded-control pr-1 transition-colors hover:bg-surface-2',
                  active === section.id && 'bg-surface-2'
                )}
                key={section.id}
              >
                <button
                  className={cn(
                    'flex min-w-0 flex-1 items-center gap-2 rounded-control px-2 py-1 text-left text-[length:var(--text-meta)] outline-none',
                    active === section.id ? 'text-foreground' : 'text-muted',
                    focused === `section:${section.id}` && rowFocus
                  )}
                  data-roster-id={`section:${section.id}`}
                  onClick={() => onOpen(bot.name, section.id)}
                  type="button"
                >
                  <span className="relative grid size-3 shrink-0 place-items-center">
                    {status === 'idle' && drafts[section.id] ? (
                      <SquarePen aria-label="Draft" size={12} />
                    ) : (
                      <StatusDot className="static size-2 border-0" status={dot} />
                    )}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{section.title}</span>
                  <span className="text-[length:var(--text-meta)] text-muted">
                    {relativeTime(section.updated_at)}
                  </span>
                </button>
                <Menu
                  items={[
                    { label: 'Archive', onSelect: () => onArchive(section) },
                    { label: 'Delete', onSelect: () => onDelete(section) }
                  ]}
                  trigger={
                    <button
                      aria-label={`Section actions for ${section.title}`}
                      className="grid size-6 shrink-0 place-items-center rounded-full text-muted opacity-0 transition-opacity group-hover/row:opacity-100 hover:text-foreground focus-visible:opacity-100 data-[popup-open]:opacity-100"
                      type="button"
                    >
                      <MoreHorizontal size={14} />
                    </button>
                  }
                />
              </div>
            )
          })}
          {canExpand ? (
            <button
              className="flex items-center gap-1 px-2 py-0.5 text-[length:var(--text-meta)] text-muted hover:text-foreground"
              onClick={onExpand}
              type="button"
            >
              {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              {expanded ? 'Show recent' : 'More'}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
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
  const currentUser = useUsers(state => state.current)
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [archivedOpen, setArchivedOpen] = useState(false)
  const [botDialog, setBotDialog] = useState(false)
  const [roomDialog, setRoomDialog] = useState(false)

  const [newBot, setNewBot] = useState({ model: '', name: '', provider: '' })
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
  useEffect(() => {
    if (!newBot.provider) {
      return
    }

    void modelsList(newBot.provider)
      .then(result => {
        const list = result.curated.length ? result.curated : result.all
        setNewModels(list)
        setNewBot(value => ({
          ...value,
          model: list.some(item => item.id === value.model) ? value.model : (list[0]?.id ?? '')
        }))
      })
      .catch(() => setNewModels([]))
  }, [newBot.provider])

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
    ? (sectionMap[params.section] ??
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
    roster.some(entry => {
      if (entry.kind === 'room') {
        return (entry.item as Room).name.toLowerCase().includes(query)
      }

      const bot = entry.item as Bot
      const own = Object.values(sectionMap).filter(section => section.bot === bot.name)
      const { matchesBot, matching } = matchBot(bot, own, query)

      return matchesBot || matching.length > 0
    })

  const archived = Object.values(sectionMap).filter(section => section.archived_at)

  const open = (bot: string, section: string) => {
    void sectionsActions()
      .open(section)
      .catch(() => undefined)
    void navigate({ to: '/b/$bot/s/$section', params: { bot, section } })
  }

  const openRoom = (room: string) => void navigate({ to: '/r/$room', params: { room } })

  /** After archiving or deleting the open section, land on the bot's next one (or a new one). */
  const leaveSection = async (bot: string, sectionId: string) => {
    if (params.section !== sectionId) {
      return
    }

    const next = Object.values(useSections.getState().byId)
      .filter(item => item.bot === bot && !item.archived_at && item.id !== sectionId)
      .sort((a, b) => toMillis(b.updated_at) - toMillis(a.updated_at))[0]

    const target = next ?? (await sectionsActions().create(bot))
    open(bot, target.id)
  }

  const archiveSection = async (section: Section) => {
    await sectionsActions().archive(section.id)
    await leaveSection(section.bot, section.id)
  }

  const deleteSection = async (section: Section) => {
    if (!window.confirm(`Delete “${section.title}”? This also purges its memory.`)) {
      return
    }

    await sectionsActions().remove(section.id)
    await leaveSection(section.bot, section.id)
  }

  const createSection = async (bot = params.bot ?? ordered[0]?.name) => {
    if (!bot) {
      return
    }

    const section = await sectionsActions().create(bot)
    open(bot, section.id)
  }

  /** Clicking a bot lands on a fresh section: an untouched one if it has any, else a new one. */
  const startSection = async (bot: string) => {
    const blank = Object.values(useSections.getState().byId)
      .filter(item => item.bot === bot && !item.archived_at && !touched(item, drafts))
      .sort((a, b) => toMillis(b.updated_at) - toMillis(a.updated_at))[0]

    if (blank) {
      open(bot, blank.id)
    } else {
      await createSection(bot)
    }
  }

  const expandBot = async (name: string) => {
    if (!expanded.has(name)) {
      await sectionsActions().refresh({ bot: name, include_archived: true })
    }

    setExpanded(current => {
      const next = new Set(current)

      if (next.has(name)) {
        next.delete(name)
      } else {
        next.add(name)
      }

      return next
    })
  }

  const keyboard = (event: React.KeyboardEvent) => {
    if (!['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)) {
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
    'flex w-full items-center gap-3 rounded-panel px-2.5 py-2 text-left outline-none transition-colors hover:bg-surface-2/70'

  const footerIcon =
    'grid size-7 shrink-0 place-items-center rounded-full border border-border text-foreground'

  return (
    <div className="flex h-screen min-h-0 flex-col bg-surface" onKeyDown={keyboard} ref={root}>
      <header className={cn('hex-drag shrink-0 px-3 pb-2', macTitleBar ? 'pt-[38px]' : 'pt-3')}>
        <div className="hex-no-drag mb-2 flex items-center justify-end">
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
                'data-testid': 'roster-new-section',
                disabled: !ordered.length,
                label: 'New section',
                onSelect: () => void createSection()
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
                className="grid size-8 place-items-center rounded-full text-muted transition-colors hover:bg-surface-2 hover:text-foreground"
                type="button"
              >
                <Plus size={18} />
              </button>
            }
          />
        </div>
        <label className="hex-no-drag relative block">
          <Search className="absolute top-1/2 left-3 -translate-y-1/2 text-muted" size={14} />
          <Input
            aria-label="Search bots and sections"
            className="h-9 rounded-[10px] border-transparent bg-surface-2 pl-9 focus-visible:border-transparent"
            onChange={event => setQuery(event.target.value.toLowerCase())}
            placeholder="Search"
            value={query}
          />
        </label>
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
            No bots, rooms or sections match “{query}”.
          </p>
        ) : null}
        {roster.map(entry =>
          entry.kind === 'room' ? (
            <RoomRow
              active={activeRoom === (entry.item as Room).id}
              focused={focused}
              key={`room:${(entry.item as Room).id}`}
              onOpen={openRoom}
              query={query}
              room={entry.item as Room}
            />
          ) : (
            <BotRows
              active={params.section}
              bot={entry.item as Bot}
              drafts={drafts}
              expanded={expanded.has((entry.item as Bot).name)}
              focused={focused}
              key={`bot:${(entry.item as Bot).name}`}
              live={liveSections}
              onArchive={section => void archiveSection(section)}
              onDelete={section => void deleteSection(section)}
              onExpand={() => void expandBot((entry.item as Bot).name)}
              onOpen={open}
              onStart={name => void startSection(name)}
              query={query}
              sections={Object.values(sectionMap).filter(
                section => section.bot === (entry.item as Bot).name
              )}
            />
          )
        )}
      </div>
      <div className="shrink-0 px-2 pb-2">
        {archived.length ? (
          <>
            <button
              className={footerRow}
              onClick={() => setArchivedOpen(value => !value)}
              type="button"
            >
              <span className={footerIcon}>
                <Archive size={14} />
              </span>
              <span className="flex-1 font-medium">Archived</span>
              <span className="text-[length:var(--text-meta)] text-muted">{archived.length}</span>
              {archivedOpen ? (
                <ChevronDown className="text-muted" size={14} />
              ) : (
                <ChevronRight className="text-muted" size={14} />
              )}
            </button>
            {archivedOpen ? (
              <div className="ml-[42px] max-h-32 overflow-auto pb-1">
                {archived.map(section => (
                  <button
                    className="block w-full truncate rounded-control px-2.5 py-1.5 text-left text-[length:var(--text-secondary)] text-muted hover:bg-surface-2"
                    key={section.id}
                    onClick={() => open(section.bot, section.id)}
                    type="button"
                  >
                    {section.title}
                  </button>
                ))}
              </div>
            ) : null}
          </>
        ) : null}
        <UpdatePill className="mb-1 w-full" />
        <div className={cn(footerRow, 'hover:bg-transparent')}>
          <span className="relative">
            <PersonAvatar name={currentUser?.display_name ?? 'You'} />
            <span
              className={cn(
                'absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full border-2 border-surface',
                dot
              )}
              title={label}
            />
          </span>
          <span className="min-w-0 flex-1 truncate font-medium">
            {currentUser?.display_name ?? 'Local user'}
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
        description="A face and a name. It will ask you the rest in its first section."
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
                  ...(avatar ? { avatar } : {})
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
                  onValueChange={provider => setNewBot(value => ({ ...value, provider }))}
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
            </div>
          ) : (
            <p className="flex items-center gap-2 text-[length:var(--text-secondary)] text-muted">
              <span className="min-w-0 truncate">
                Runs on {newModels.find(item => item.id === newBot.model)?.label ?? newBot.model}
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
  const users = useUsers(state => state.users)
  const settings = useSettings(state => state.settings)
  const [name, setName] = useState('')
  const [query, setQuery] = useState('')
  const [members, setMembers] = useState<string[]>([])
  const [humanMembers, setHumanMembers] = useState<string[]>([])
  const [mainBot, setMainBot] = useState('')
  const [approvalMode, setApprovalMode] = useState(settings?.approval_mode ?? 'manual')
  const [turns, setTurns] = useState(String(settings?.room_bot_turns_per_human_turn ?? 8))
  const [budget, setBudget] = useState(String(settings?.room_budget_tokens_per_human_turn ?? ''))
  const [error, setError] = useState<string | null>(null)

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
              members: [...members, ...humanMembers],
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
                <Avatar image={avatarData(bot)} name={bot.display_name} size="sm" />
                <span>{bot.display_name}</span>
              </label>
            ))}
        </fieldset>
        {users.length > 1 ? (
          <fieldset className="border-y border-border py-2">
            <legend className="mb-1 font-medium">People</legend>
            {users.map(user => (
              <label className="flex items-center gap-3 py-1" key={user.id}>
                <input
                  checked={humanMembers.includes(user.id)}
                  onChange={event =>
                    setHumanMembers(items =>
                      event.target.checked
                        ? [...items, user.id]
                        : items.filter(id => id !== user.id)
                    )
                  }
                  type="checkbox"
                />
                <span>{user.display_name}</span>
              </label>
            ))}
          </fieldset>
        ) : null}
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
            options={[
              { label: 'Manual', value: 'manual' },
              { label: 'Auto', value: 'smart' },
              { label: 'Off', value: 'off' }
            ]}
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
            disabled={!name.trim() || (!members.length && !humanMembers.length)}
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
