import { useParams } from '@tanstack/react-router'
import {
  Brain,
  ChevronsRight,
  File,
  LayoutTemplate,
  type LucideIcon,
  MessageSquare,
  ScrollText,
  Search,
  X
} from 'lucide-react'
import { Fragment, useDeferredValue, useEffect, useMemo, useRef } from 'react'

import type { RoomEvent } from '../../lib/types'
import { useBots } from '../../stores/bots'
import { useMe } from '../../stores/me'
import { useRooms } from '../../stores/rooms'
import { searchActions, useSearch } from '../../stores/search'
import { uiActions } from '../../stores/ui'
import { visualsActions } from '../../stores/visuals'

import { Empty, headingClass, listClass, rowClass, RowIcon, shortTime } from './rows'
import {
  foldKeepingOffsets,
  MESSAGE_LIMIT,
  queryTerms,
  roomEntries,
  search,
  type SearchDocument,
  type SearchEntry,
  type SearchHit
} from './search'

const NO_EVENTS: RoomEvent[] = []

/** The panel is a sheet over the conversation below this width; a found message needs it out of the way. */
const coversConversation = () => window.matchMedia('(max-width: 1100px)').matches

/** The query's words marked wherever they appear in `text`. */
export function Marked({ terms, text }: { terms: string[]; text: string }) {
  const parts = useMemo(() => {
    const folded = foldKeepingOffsets(text)
    const marked = new Array<boolean>(text.length).fill(false)

    for (const term of terms) {
      for (let at = folded.indexOf(term); at >= 0; at = folded.indexOf(term, at + term.length)) {
        marked.fill(true, at, at + term.length)
      }
    }

    const out: { mark: boolean; text: string }[] = []

    for (let index = 0; index < text.length; index++) {
      const last = out.at(-1)

      if (last && last.mark === marked[index]) {
        last.text += text[index]
      } else {
        out.push({ mark: marked[index]!, text: text[index]! })
      }
    }

    return out
  }, [terms, text])

  return (
    <>
      {parts.map((part, index) =>
        part.mark ? (
          <mark className="rounded-[3px] bg-accent/18 text-foreground" key={index}>
            {part.text}
          </mark>
        ) : (
          <Fragment key={index}>{part.text}</Fragment>
        )
      )}
    </>
  )
}

/** The search box: Escape clears what was typed, then leaves search. */
export function SearchField({ label, onLeave }: { label: string; onLeave: () => void }) {
  const query = useSearch(state => state.query)
  const setQuery = useSearch(state => state.setQuery)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => input.current?.focus(), [])

  return (
    <label className="hex-no-drag hex-fade flex h-8 min-w-0 flex-1 items-center gap-2 rounded-full bg-foreground/[0.05] pr-1 pl-3 focus-within:bg-background focus-within:shadow-card">
      <Search aria-hidden className="shrink-0 text-muted" size={14} />
      <input
        aria-label={label}
        className="min-w-0 flex-1 bg-transparent text-[length:var(--text-secondary)] text-foreground outline-none placeholder:text-muted [&::-webkit-search-cancel-button]:appearance-none"
        onChange={event => setQuery(event.target.value)}
        onKeyDown={event => {
          if (event.key !== 'Escape') {
            return
          }

          event.preventDefault()

          if (query) {
            setQuery('')
          } else {
            onLeave()
          }
        }}
        placeholder="Search"
        ref={input}
        type="search"
        value={query}
      />
      {query ? (
        <button
          aria-label="Clear search"
          className="hex-focus grid size-6 shrink-0 place-items-center rounded-full text-muted hover:bg-foreground/[0.06] hover:text-foreground"
          onClick={() => {
            setQuery('')
            input.current?.focus()
          }}
          type="button"
        >
          <X size={13} />
        </button>
      ) : null}
    </label>
  )
}

const ICONS: Record<string, LucideIcon> = {
  memory: Brain,
  soul: ScrollText
}

function iconOf(hit: SearchHit, group: 'documents' | 'files' | 'messages' | 'visuals'): LucideIcon {
  if (hit.target.kind === 'document') {
    return ICONS[hit.target.document] ?? ScrollText
  }

  return { documents: ScrollText, files: File, messages: MessageSquare, visuals: LayoutTemplate }[
    group
  ]
}

const GROUPS = [
  { key: 'messages', label: 'Messages' },
  { key: 'files', label: 'Files' },
  { key: 'visuals', label: 'Visuals' },
  { key: 'documents', label: 'Soul and memory' }
] as const

/**
 * What matches in the conversation, by kind. A message or file shows its
 * place in the conversation; a visual opens beside it; soul and memory open
 * in their editor through `onDocument`.
 */
export function SearchResults({
  documents,
  entries,
  hint,
  onDocument,
  onLeave
}: {
  documents?: SearchDocument[]
  entries: SearchEntry[]
  /** What the empty search says it looks through. */
  hint: string
  onDocument?: (kind: SearchDocument['kind']) => void
  /** Leaves the panel, for a found message the panel would cover. */
  onLeave: () => void
}) {
  const query = useDeferredValue(useSearch(state => state.query))
  const terms = useMemo(() => queryTerms(query), [query])
  const results = useMemo(() => search(entries, query, documents), [documents, entries, query])

  if (!terms.length) {
    return <Empty icon={Search} text={hint} />
  }

  if (!results.total) {
    return <Empty icon={Search} text={`Nothing matches “${query.trim()}”.`} />
  }

  const pick = (hit: SearchHit) => {
    const target = hit.target

    if (target.kind === 'visual') {
      visualsActions().open(target.visual)
    } else if (target.kind === 'document') {
      onDocument?.(target.document)
    } else {
      searchActions().jumpTo(target.id)

      if (coversConversation()) {
        onLeave()
      }
    }
  }

  return (
    <div className="grid gap-5" data-testid="search-results">
      {GROUPS.map(group => {
        const hits = results[group.key]

        if (!hits.length) {
          return null
        }

        return (
          <section key={group.key}>
            <h3 className={headingClass}>{group.label}</h3>
            <ul className={listClass}>
              {hits.map(hit => (
                <li key={hit.key}>
                  <button className={rowClass} onClick={() => pick(hit)} type="button">
                    <RowIcon icon={iconOf(hit, group.key)} />
                    <span className="min-w-0 flex-1 py-0.5">
                      <span className="flex items-baseline gap-2">
                        <span className="min-w-0 flex-1 truncate font-medium">
                          {group.key === 'messages' ? (
                            hit.title
                          ) : (
                            <Marked terms={terms} text={hit.title} />
                          )}
                        </span>
                        <span className="shrink-0 text-[length:var(--text-meta)] text-muted">
                          {shortTime(hit.at)}
                        </span>
                      </span>
                      {hit.snippet ? (
                        <span className="line-clamp-2 text-[length:var(--text-secondary)] break-words text-muted">
                          <Marked terms={terms} text={hit.snippet} />
                        </span>
                      ) : null}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {group.key === 'messages' && hits.length === MESSAGE_LIMIT ? (
              <p className="mt-1.5 px-1 text-[length:var(--text-meta)] text-muted">
                Showing the latest {MESSAGE_LIMIT}. Add a word to narrow it.
              </p>
            ) : null}
          </section>
        )
      })}
    </div>
  )
}

/**
 * Search in a room. A room has no profile panel, so search opens the panel
 * slot on its own, from the search button by the room's name.
 */
export function RoomSearchPanel() {
  const { room: roomId } = useParams({ strict: false }) as { room?: string }
  const room = useRooms(state => (roomId ? state.byId[roomId] : undefined))
  const events = useRooms(state => (roomId ? state.eventsByRoom[roomId] : undefined) ?? NO_EVENTS)
  const bots = useBots(state => state.byName)
  const me = useMe(state => state.me)

  const entries = useMemo(
    () =>
      roomEntries(events, event => {
        const id = event.payload.bot ?? event.actor_id

        if (event.kind === 'message.user' && (!me || event.actor_id === me.id)) {
          return 'You'
        }

        return (
          (id && bots[id]?.display_name) ??
          room?.members.find(member => member.member_id === id)?.display_name ??
          id ??
          'Someone'
        )
      }),
    [bots, events, me, room?.members]
  )

  const leave = () => searchActions().close()

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="room-search-panel">
      <header className="hex-drag flex h-14 shrink-0 items-center gap-2 px-3">
        <SearchField label={`Search ${room?.name ?? 'this room'}`} onLeave={leave} />
        <button
          aria-label="Close search"
          className="hex-no-drag hex-focus grid size-8 shrink-0 place-items-center rounded-full text-muted transition-colors duration-[var(--hex-motion-fast)] hover:bg-foreground/[0.06] hover:text-foreground"
          onClick={leave}
          type="button"
        >
          <ChevronsRight size={16} />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-5">
        <SearchResults
          entries={entries}
          hint="Search messages and files in this room."
          onLeave={leave}
        />
      </div>
    </div>
  )
}

/** Hides a bot's panel so a found message shows; search stays open for when it comes back. */
export function hideBotPanel(): void {
  uiActions().toggleRightPanel(false)
}
