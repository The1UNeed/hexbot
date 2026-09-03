import { useNavigate, useParams } from '@tanstack/react-router'
import { Archive, ChevronDown, ChevronRight, Plus, Search, Settings } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { Avatar } from '../../components/ui/avatar'
import { Button } from '../../components/ui/button'
import { Chip } from '../../components/ui/chip'
import { Dialog } from '../../components/ui/dialog'
import { Input } from '../../components/ui/input'
import { Menu } from '../../components/ui/menu'
import { toMillis } from '../../lib/time'
import type { Bot, Section } from '../../lib/types'
import { useBotList, useBots } from '../../stores/bots'
import { useConnection } from '../../stores/connection'
import { sectionsActions, useSections } from '../../stores/sections'

const DAY = 86_400_000

const avatarData = (bot: Bot) =>
  bot.avatar ? `data:${bot.avatar.mime};base64,${bot.avatar.data}` : null

const sectionTime = (section: Section) => section.updated_at ?? section.created_at ?? 0

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
  [...bots].sort((a, b) => (b.last_activity_at ?? 0) - (a.last_activity_at ?? 0))

export function visibleRecentSections(bot: Bot, expanded: boolean, all: Section[]): Section[] {
  return [...(expanded && all.length ? all : bot.sections_recent)]
    .filter(
      section => !section.archived_at && (expanded || Date.now() - sectionTime(section) < 14 * DAY)
    )
    .sort((a, b) => sectionTime(b) - sectionTime(a))
    .slice(0, expanded ? undefined : 2)
}

interface BotRowsProps {
  active?: string
  bot: Bot
  expanded: boolean
  focused: string | null
  onExpand: () => void
  onOpen: (bot: string, section: string) => void
  query: string
  sections: Section[]
}

function BotRows({
  active,
  bot,
  expanded,
  focused,
  onExpand,
  onOpen,
  query,
  sections
}: BotRowsProps) {
  const matchesBot = `${bot.display_name} ${bot.name}`.toLowerCase().includes(query)

  const available = [
    ...sections,
    ...bot.sections_recent.filter(recent => !sections.some(section => section.id === recent.id))
  ]

  const matching = available.filter(section => section.title.toLowerCase().includes(query))

  if (query && !matchesBot && matching.length === 0) {
    return null
  }

  const rows = query ? matching : visibleRecentSections(bot, expanded, available)
  const first = rows[0] ?? bot.sections_recent[0]

  const canExpand =
    bot.sections_total > rows.length ||
    bot.sections_recent.some(section => Date.now() - sectionTime(section) >= 14 * DAY)

  return (
    <div className="py-1" data-testid="bot-group">
      <button
        className={`grid w-full grid-cols-[auto_1fr_auto] gap-x-2 rounded-control px-2 py-2 text-left outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent ${focused === `bot:${bot.name}` ? 'bg-surface-2' : ''}`}
        data-roster-id={`bot:${bot.name}`}
        onClick={() => first && onOpen(bot.name, first.id)}
        type="button"
      >
        <Avatar image={avatarData(bot)} name={bot.display_name} />
        <span className="min-w-0">
          <span className="flex items-center gap-2">
            <span className="truncate font-medium">{bot.display_name}</span>
            {bot.model ? (
              <Chip className="max-w-28 truncate" tone="muted">
                {bot.model}
              </Chip>
            ) : null}
          </span>
          <span className="block truncate text-[length:var(--text-secondary)] text-muted">
            {first?.preview || bot.description || 'No messages yet'}
          </span>
        </span>
        <span className="text-[length:var(--text-meta)] text-muted">
          {relativeTime(bot.last_activity_at)}
        </span>
      </button>
      <div className="ml-10 border-l border-border pl-2">
        {rows.map(section => {
          const unread =
            section.id !== active &&
            sectionTime(section) > Number(localStorage.getItem(`hexbot.read.${section.id}`) ?? 0)

          return (
            <button
              className={`flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left text-[length:var(--text-secondary)] outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent ${active === section.id ? 'bg-surface-2 text-foreground' : 'text-muted'} ${focused === `section:${section.id}` ? 'ring-1 ring-accent' : ''}`}
              data-roster-id={`section:${section.id}`}
              key={section.id}
              onClick={() => onOpen(bot.name, section.id)}
              type="button"
            >
              <span className="min-w-0 flex-1 truncate">{section.title}</span>
              {unread ? (
                <span aria-label="Unread" className="size-1.5 rounded-full bg-accent" />
              ) : null}
              <span className="text-[length:var(--text-meta)]">
                {relativeTime(section.updated_at)}
              </span>
            </button>
          )
        })}
        {!query && canExpand ? (
          <button
            className="flex items-center gap-1 px-2 py-1 text-[length:var(--text-meta)] text-muted hover:text-foreground"
            onClick={onExpand}
            type="button"
          >
            {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            {expanded ? 'Show recent' : 'More'}
          </button>
        ) : null}
      </div>
    </div>
  )
}

export function RosterColumn() {
  const params = useParams({ strict: false }) as { bot?: string; section?: string }
  const navigate = useNavigate()
  const bots = useBotList()
  const sectionMap = useSections(state => state.byId)
  const connection = useConnection()
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [archivedOpen, setArchivedOpen] = useState(false)
  const [botDialog, setBotDialog] = useState(false)
  const [newBot, setNewBot] = useState({ model: '', name: '', provider: '' })
  const [focused, setFocused] = useState<string | null>(null)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!useBots.getState().loaded) {
      void useBots.getState().refresh()
    }
  }, [])
  useEffect(() => {
    if (params.section) {
      localStorage.setItem(`hexbot.read.${params.section}`, String(Date.now()))
    }
  }, [params.section])
  const ordered = useMemo(() => orderedBots(bots), [bots])
  const archived = Object.values(sectionMap).filter(section => section.archived_at)

  const open = (bot: string, section: string) => {
    localStorage.setItem(`hexbot.read.${section}`, String(Date.now()))
    void sectionsActions()
      .open(section)
      .catch(() => undefined)
    void navigate({ to: '/b/$bot/s/$section', params: { bot, section } })
  }

  const createSection = async () => {
    const bot = params.bot ?? ordered[0]?.name

    if (!bot) {
      return
    }

    const section = await sectionsActions().create(bot)
    open(bot, section.id)
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

  return (
    <div className="flex h-screen min-h-0 flex-col bg-surface" onKeyDown={keyboard} ref={root}>
      <header className="border-b border-border p-3">
        <div className="mb-3 flex items-center justify-between">
          <h1 className="text-[length:var(--text-title)] font-semibold">Hexbot</h1>
          <Menu
            items={[
              { label: 'New bot', onSelect: () => setBotDialog(true) },
              {
                disabled: !ordered.length,
                label: 'New section',
                onSelect: () => void createSection()
              }
            ]}
            trigger={
              <Button icon={<Plus size={15} />} size="sm">
                New
              </Button>
            }
          />
        </div>
        <label className="relative block">
          <Search className="absolute top-2.5 left-2.5 text-muted" size={14} />
          <Input
            aria-label="Search bots and sections"
            className="pl-8"
            onChange={event => setQuery(event.target.value.toLowerCase())}
            placeholder="Search"
            value={query}
          />
        </label>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {useBots.getState().loaded && ordered.length === 0 ? (
          <div className="grid h-full place-content-center gap-3 p-6 text-center">
            <p className="text-muted">Create your first bot to start a conversation.</p>
            <Button onClick={() => setBotDialog(true)} variant="primary">
              Create a bot
            </Button>
          </div>
        ) : null}
        {ordered.map(bot => (
          <BotRows
            active={params.section}
            bot={bot}
            expanded={expanded.has(bot.name)}
            focused={focused}
            key={bot.name}
            onExpand={() => void expandBot(bot.name)}
            onOpen={open}
            query={query}
            sections={Object.values(sectionMap).filter(section => section.bot === bot.name)}
          />
        ))}
      </div>
      <div className="border-t border-border">
        <button
          className="flex w-full items-center gap-2 px-3 py-2 text-[length:var(--text-secondary)] text-muted hover:bg-surface-2"
          onClick={() => setArchivedOpen(value => !value)}
          type="button"
        >
          <Archive size={14} />
          Archived<span className="ml-auto">{archived.length}</span>
          {archivedOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>
        {archivedOpen ? (
          <div className="max-h-32 overflow-auto px-2 pb-2">
            {archived.map(section => (
              <button
                className="block w-full truncate rounded-control px-2 py-1.5 text-left text-[length:var(--text-secondary)] text-muted hover:bg-surface-2"
                key={section.id}
                onClick={() => open(section.bot, section.id)}
                type="button"
              >
                {section.title}
              </button>
            ))}
          </div>
        ) : null}
        <footer className="flex items-center gap-2 border-t border-border px-3 py-2 text-[length:var(--text-meta)] text-muted">
          <span className={`size-2 rounded-full ${dot}`} />
          <span className="min-w-0 flex-1 truncate">{label}</span>
          <button
            aria-label="Settings"
            className="rounded-control p-1 hover:bg-surface-2 hover:text-foreground"
            onClick={() => void navigate({ to: '/settings/$tab', params: { tab: 'providers' } })}
            type="button"
          >
            <Settings size={16} />
          </button>
        </footer>
      </div>
      <Dialog onOpenChange={setBotDialog} open={botDialog} title="New bot">
        <form
          className="grid gap-3 p-5"
          onSubmit={event => {
            event.preventDefault()
            void useBots
              .getState()
              .create(newBot)
              .then(({ bot, section }) => {
                setBotDialog(false)
                open(bot.name, section.id)
              })
          }}
        >
          <Input
            aria-label="Bot name"
            onChange={event => setNewBot(value => ({ ...value, name: event.target.value }))}
            placeholder="Bot name"
            required
            value={newBot.name}
          />
          <Input
            aria-label="Provider"
            onChange={event => setNewBot(value => ({ ...value, provider: event.target.value }))}
            placeholder="Provider"
            required
            value={newBot.provider}
          />
          <Input
            aria-label="Model"
            onChange={event => setNewBot(value => ({ ...value, model: event.target.value }))}
            placeholder="Model"
            required
            value={newBot.model}
          />
          <div className="flex justify-end gap-2">
            <Button onClick={() => setBotDialog(false)}>Cancel</Button>
            <Button type="submit" variant="primary">
              Create
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  )
}
