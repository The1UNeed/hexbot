import { useNavigate } from '@tanstack/react-router'
import { Search } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'

import { Avatar } from '../../components/ui/avatar'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { avatarSrc } from '../../lib/avatar-builder'
import { cn } from '../../lib/cn'
import { toMillis } from '../../lib/time'
import type { Bot, Section } from '../../lib/types'
import { useBotList } from '../../stores/bots'
import { sectionsActions, useSections } from '../../stores/sections'
import { cardClass, dividerClass, Heading } from '../bot-settings/shared'

const DAY = 86_400_000

const shortDate = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' })

/** "This week", "Last week", then one group per month, by when the section was archived. */
export function archiveGroup(archivedAt: number, now = Date.now()): string {
  const elapsed = now - archivedAt

  if (elapsed < 7 * DAY) {
    return 'This week'
  }

  if (elapsed < 14 * DAY) {
    return 'Last week'
  }

  const date = new Date(archivedAt)
  const sameYear = date.getFullYear() === new Date(now).getFullYear()

  return new Intl.DateTimeFormat(undefined, {
    month: 'long',
    year: sameYear ? undefined : 'numeric'
  }).format(date)
}

/** The rail's short label for a group: "Week", "Last", "Sep". */
const railLabel = (group: string) =>
  group === 'This week' ? 'Week' : group === 'Last week' ? 'Last' : group.slice(0, 3)

function Highlight({ query, text }: { query: string; text: string }) {
  const at = query ? text.toLowerCase().indexOf(query) : -1

  if (at < 0) {
    return <>{text}</>
  }

  return (
    <>
      {text.slice(0, at)}
      <mark className="rounded-[3px] bg-accent/15 text-inherit">
        {text.slice(at, at + query.length)}
      </mark>
      {text.slice(at + query.length)}
    </>
  )
}

const selectArchived = (state: { byId: Record<string, Section> }) =>
  Object.values(state.byId).filter(section => section.archived_at)

/**
 * Every archived section, newest first, grouped by when it was archived. A
 * search and one chip per bot narrow it; the rail on the right jumps between
 * groups. Restore puts a section back in the sidebar.
 */
export function ArchiveSettings() {
  const navigate = useNavigate()
  const archived = useSections(useShallow(selectArchived))
  const loading = useSections(state => state.loading)
  const error = useSections(state => state.error)
  const bots = useBotList()
  const [query, setQuery] = useState('')
  const [bot, setBot] = useState<null | string>(null)
  const [current, setCurrent] = useState<null | string>(null)
  const [restoring, setRestoring] = useState<null | string>(null)
  const [restoreError, setRestoreError] = useState<null | string>(null)
  const groupRefs = useRef(new Map<string, HTMLElement>())
  // A rail click owns the highlight while its scroll runs; the last groups may never reach the top.
  const jumpedAt = useRef(0)

  useEffect(() => {
    void sectionsActions().refresh()
  }, [])

  const botsByName = useMemo(() => new Map(bots.map(item => [item.name, item])), [bots])
  const displayName = (name: string) => botsByName.get(name)?.display_name ?? name
  const needle = query.trim().toLowerCase()

  const sorted = useMemo(
    () => [...archived].sort((a, b) => toMillis(b.archived_at) - toMillis(a.archived_at)),
    [archived]
  )

  // Chips for bots that have something archived, in the order of their newest archive.
  const botChips = [...new Set(sorted.map(section => section.bot))]
  const selectedBot = bot && botChips.includes(bot) ? bot : null

  const visible = sorted.filter(
    section =>
      (!selectedBot || section.bot === selectedBot) &&
      (!needle ||
        section.title.toLowerCase().includes(needle) ||
        section.preview.toLowerCase().includes(needle) ||
        displayName(section.bot).toLowerCase().includes(needle))
  )

  const groups: { label: string; sections: Section[] }[] = []

  for (const section of visible) {
    const label = archiveGroup(toMillis(section.archived_at))
    const last = groups.at(-1)

    if (last?.label === label) {
      last.sections.push(section)
    } else {
      groups.push({ label, sections: [section] })
    }
  }

  const labels = groups.map(group => group.label).join('|')

  // Light up the rail for the group nearest the top of the page as it scrolls.
  useEffect(() => {
    const elements = [...groupRefs.current.values()]

    if (!elements.length || typeof IntersectionObserver === 'undefined') {
      return
    }

    const observer = new IntersectionObserver(
      entries => {
        const top = entries
          .filter(entry => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]

        if (top && Date.now() - jumpedAt.current > 1000) {
          setCurrent((top.target as HTMLElement).dataset.group ?? null)
        }
      },
      { rootMargin: '0px 0px -70% 0px' }
    )

    elements.forEach(element => observer.observe(element))

    return () => observer.disconnect()
  }, [labels])

  const open = (section: Section) => {
    void sectionsActions()
      .open(section.id)
      .catch(() => undefined)
    void navigate({
      params: { bot: section.bot, section: section.id },
      to: '/b/$bot/s/$section'
    })
  }

  const restore = async (section: Section) => {
    setRestoring(section.id)
    setRestoreError(null)

    try {
      await sectionsActions().unarchive(section.id)
    } catch (error) {
      setRestoreError(error instanceof Error ? error.message : String(error))
    } finally {
      setRestoring(null)
    }
  }

  const max = Math.max(1, ...groups.map(group => group.sections.length))

  const active =
    current && groups.some(group => group.label === current) ? current : groups[0]?.label

  return (
    <div>
      <Heading description="Conversations you archived. Restore one to put it back in the sidebar.">
        Archive
      </Heading>
      {error ? (
        <div className="space-y-2" role="alert">
          <p>Could not load the archive: {error}</p>
          <Button onClick={() => void sectionsActions().refresh()} size="sm" variant="ghost">
            Retry
          </Button>
        </div>
      ) : null}
      {restoreError ? <p role="alert">Could not restore the conversation: {restoreError}</p> : null}
      {loading ? <p role="status">Loading the archive...</p> : null}
      {sorted.length ? (
        <div className="space-y-3">
          <label className="relative block">
            <Search
              className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-muted"
              size={15}
            />
            <Input
              aria-label="Search the archive"
              className="rounded-full pl-9"
              onChange={event => setQuery(event.target.value)}
              placeholder="Search titles, first messages, and bots"
              value={query}
            />
          </label>
          {botChips.length > 1 ? (
            <div aria-label="Filter by bot" className="flex flex-wrap gap-1.5" role="group">
              <FilterChip onClick={() => setBot(null)} pressed={!selectedBot}>
                All
              </FilterChip>
              {botChips.map(name => (
                <FilterChip
                  bot={botsByName.get(name)}
                  key={name}
                  onClick={() => setBot(value => (value === name ? null : name))}
                  pressed={selectedBot === name}
                >
                  {displayName(name)}
                </FilterChip>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="relative mt-6">
        {groups.length > 1 ? (
          <nav
            aria-label="Jump to"
            className="absolute top-0 -right-[88px] hidden h-full w-[72px] lg:block"
          >
            <div className="sticky top-16 flex flex-col items-end gap-0.5">
              {groups.map(group => (
                <button
                  aria-current={group.label === active ? 'true' : undefined}
                  className={cn(
                    'flex h-6 items-center gap-1.5 rounded-md px-1 text-[length:var(--text-meta)] whitespace-nowrap transition-colors duration-[var(--hex-motion-fast)] outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
                    group.label === active
                      ? 'font-medium text-foreground'
                      : 'text-muted hover:text-foreground'
                  )}
                  key={group.label}
                  onClick={() => {
                    jumpedAt.current = Date.now()
                    setCurrent(group.label)
                    groupRefs.current
                      .get(group.label)
                      ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                  }}
                  title={group.label}
                  type="button"
                >
                  {railLabel(group.label)}
                  <span
                    className={cn(
                      'h-1 rounded-full',
                      group.label === active ? 'bg-foreground' : 'bg-foreground/15'
                    )}
                    style={{ width: 6 + (group.sections.length / max) * 14 }}
                  />
                </button>
              ))}
            </div>
          </nav>
        ) : null}
        {groups.length ? (
          <div className="space-y-7">
            {groups.map(group => (
              <section
                aria-label={group.label}
                className="scroll-mt-6"
                data-group={group.label}
                key={group.label}
                ref={element => {
                  if (element) {
                    groupRefs.current.set(group.label, element)
                  } else {
                    groupRefs.current.delete(group.label)
                  }
                }}
              >
                <div className="mb-2 flex items-center justify-between px-1 text-[length:var(--text-meta)] font-medium text-muted">
                  <span>{group.label}</span>
                  <span className="tabular-nums">{group.sections.length}</span>
                </div>
                <ul className={cn(cardClass, dividerClass)}>
                  {group.sections.map(section => (
                    <ArchivedRow
                      bot={botsByName.get(section.bot)}
                      botName={displayName(section.bot)}
                      key={section.id}
                      onOpen={() => open(section)}
                      onRestore={() => void restore(section)}
                      query={needle}
                      restoring={restoring === section.id}
                      section={section}
                    />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        ) : !loading && !error ? (
          <p className="px-1 text-[length:var(--text-secondary)] text-muted">
            {sorted.length
              ? 'Nothing archived matches that.'
              : 'Nothing archived. Archive a conversation from its menu and it waits here.'}
          </p>
        ) : null}
      </div>
    </div>
  )
}

function FilterChip({
  bot,
  children,
  onClick,
  pressed
}: {
  bot?: Bot
  children: React.ReactNode
  onClick: () => void
  pressed: boolean
}) {
  return (
    <button
      aria-pressed={pressed}
      className={cn(
        'flex h-7 items-center gap-1.5 rounded-full text-[length:var(--text-secondary)] transition-colors duration-[var(--hex-motion-fast)] outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
        bot ? 'pr-3 pl-1' : 'px-3',
        pressed
          ? 'bg-foreground text-background'
          : 'bg-foreground/[0.07] text-foreground hover:bg-foreground/[0.11]'
      )}
      onClick={onClick}
      type="button"
    >
      {bot ? <Avatar image={avatarSrc(bot.avatar)} name={bot.display_name} size="xs" /> : null}
      {children}
    </button>
  )
}

function ArchivedRow({
  bot,
  botName,
  onOpen,
  onRestore,
  query,
  restoring,
  section
}: {
  bot?: Bot
  botName: string
  onOpen: () => void
  onRestore: () => void
  query: string
  restoring: boolean
  section: Section
}) {
  const messages = `${section.message_count} ${section.message_count === 1 ? 'message' : 'messages'}`

  return (
    <li className="group relative flex min-h-[56px] items-center gap-3 py-2 pr-4 pl-3">
      <Avatar image={avatarSrc(bot?.avatar)} name={botName} size="sm" />
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">
          <Highlight query={query} text={section.title} />
        </p>
        <p className="truncate text-[length:var(--text-meta)] text-muted">
          <Highlight query={query} text={botName} /> · {messages}
          {section.preview ? (
            <>
              {' · '}
              <Highlight query={query} text={section.preview} />
            </>
          ) : null}
        </p>
      </div>
      <span className="shrink-0 text-[length:var(--text-meta)] text-muted tabular-nums max-sm:hidden">
        {shortDate.format(toMillis(section.archived_at))}
      </span>
      {/* Over the date on wide windows, so the title keeps its width until you point at it. */}
      <div className="flex shrink-0 items-center gap-1 rounded-[10px] bg-[var(--hex-card)] transition-opacity sm:absolute sm:inset-y-1 sm:right-2 sm:pl-2 duration-[var(--hex-motion-fast)] sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100">
        <Button onClick={onOpen} size="sm" variant="ghost">
          Open
        </Button>
        <Button busy={restoring} onClick={onRestore} size="sm" variant="primary">
          Restore
        </Button>
      </div>
    </li>
  )
}
