import { Link } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'

import { Button } from '../../components/ui/button'
import { SkeletonLines } from '../../components/ui/skeleton'
import { Switch } from '../../components/ui/switch'
import { Textarea } from '../../components/ui/textarea'
import {
  botMemoryGet,
  botMemorySet,
  type BotNotes,
  botNotesDelete,
  botNotesList,
  botNotesSet,
  type Dream,
  dreamingList,
  dreamingRestore,
  dreamingRunNow,
  dreamingStatus,
  NOTES_CHANGED
} from '../../lib/api'
import { cn } from '../../lib/cn'
import type { Bot } from '../../lib/types'
import { sectionsActions, useSectionsForBot } from '../../stores/sections'
import { Markdown } from '../conversation'

import {
  cardClass,
  dividerClass,
  errorText,
  formatTimestamp,
  Group,
  Heading,
  Row,
  type SaveBot
} from './shared'

/** One capped memory text with a counter. Used for About you, a bot's memory and a day of notes. */
export function MemoryEditor({
  actions,
  cap,
  disabled = false,
  label,
  onSave,
  placeholder,
  rows = 6,
  value
}: {
  /** Sits left of Save: a Delete button, for a text that can go as a whole. */
  actions?: React.ReactNode
  cap: number
  disabled?: boolean
  label: string
  onSave: (value: string) => Promise<void>
  placeholder?: string
  rows?: number
  value: string
}) {
  const [draft, setDraft] = useState(value)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => setDraft(value), [value])
  const [saving, setSaving] = useState(false)
  const pending = useRef(false)
  const length = [...draft].length
  const tooLong = length > cap
  const dirty = draft !== value

  const save = () => {
    if (pending.current || disabled) {
      return
    }

    if (tooLong) {
      return setError(`Keep this to ${cap} characters or fewer.`)
    }

    pending.current = true
    setSaving(true)
    setError(null)
    void onSave(draft)
      .catch(cause => setError(errorText(cause)))
      .finally(() => {
        pending.current = false
        setSaving(false)
      })
  }

  return (
    <div>
      <div className={cn(cardClass, 'overflow-hidden')}>
        <Textarea
          aria-label={label}
          className="rounded-none bg-transparent px-4 py-3 hover:bg-transparent focus-visible:bg-transparent"
          disabled={disabled || saving}
          onChange={event => {
            setDraft(event.target.value)
            setError(null)
          }}
          placeholder={placeholder}
          rows={rows}
          value={draft}
        />
      </div>
      <div className="mt-2 flex min-h-[30px] items-center justify-between gap-3 px-1">
        <span
          className={cn('text-[length:var(--text-meta)]', tooLong ? 'text-danger' : 'text-muted')}
        >
          {length} / {cap}
        </span>
        <span className="flex items-center gap-2">
          {actions}
          {dirty ? (
            <Button disabled={disabled || saving} onClick={save} size="sm" variant="primary">
              Save
            </Button>
          ) : null}
        </span>
      </div>
      {error ? (
        <span className="block px-1 text-[length:var(--text-meta)] text-danger" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  )
}

export function MemoryTab(props: { bot: Bot; onSave: SaveBot }) {
  return <BotMemoryTab key={props.bot.name} {...props} />
}

function BotMemoryTab({ bot, onSave }: { bot: Bot; onSave: SaveBot }) {
  const botName = bot.name
  const [memory, setMemory] = useState<Awaited<ReturnType<typeof botMemoryGet>> | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    void botMemoryGet(botName)
      .then(setMemory)
      .catch(cause => setError(errorText(cause)))
  }, [botName])

  return (
    <div>
      <Heading description="What this bot has learned. It writes here on its own; dreaming tidies it up each day.">
        Memory
      </Heading>
      <div className="space-y-8">
        <div>
          <p className="mb-2 px-1 text-[length:var(--text-meta)] font-medium text-muted">
            This bot's memory
          </p>
          {error ? (
            <p className="text-danger" role="alert">
              {error}
            </p>
          ) : memory ? (
            <MemoryEditor
              cap={memory.cap}
              label="Bot memory"
              onSave={async value => setMemory(await botMemorySet(botName, value))}
              placeholder="Nothing yet. The bot writes here as it learns."

              value={memory.memory_md}
            />
          ) : (
            <SkeletonLines label="Loading memory" />
          )}
        </div>
        <NotesBlock bot={botName} />
        <Group>
          <Row
            control={
              <Link params={{ tab: 'memory' }} to="/settings/$tab">
                <Button size="sm" variant="secondary">
                  Open in Settings
                </Button>
              </Link>
            }
            description="Written by you and read by every bot you own."
            title="About you"
          />
        </Group>
        <DreamingBlock
          bot={bot}
          onRestored={memoryMd =>
            setMemory(current => current && { ...current, memory_md: memoryMd })
          }
          onSave={onSave}
        />
      </div>
    </div>
  )
}

/** A note day as the daemon files it, `YYYY-MM-DD`, for a local date. */
export function noteDay(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** A note day as a local date; a date with a time and no zone is read as local time. */
const dayDate = (date: string) => new Date(`${date}T00:00:00`)

/**
 * "Today", "Yesterday", or the day itself, with the year only when it is not
 * this one. `today` is the daemon's day, so a client in another timezone
 * names the days as the daemon files them.
 */
export function noteDayLabel(date: string, today: string): string {
  const now = dayDate(today)
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)

  if (date === today) {
    return 'Today'
  }

  if (date === noteDay(yesterday)) {
    return 'Yesterday'
  }

  return dayDate(date).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    weekday: 'short',
    ...(date.slice(0, 4) === today.slice(0, 4) ? {} : { year: 'numeric' })
  })
}

const noteCount = (text: string) => text.split('\n').filter(line => line.trim()).length

/** The question before a day of notes goes. */
export function deleteNotesQuestion(date: string, today: string): string {
  const label = noteDayLabel(date, today)

  return label === 'Today' || label === 'Yesterday'
    ? `Delete ${label.toLowerCase()}'s notes?`
    : `Delete the notes for ${label}?`
}

/**
 * The bot's notes by day: a card listing the days, newest first, and one
 * editor for the chosen day. The dream folds what lasts into memory.
 */
export function NotesBlock({ bot }: { bot: string }) {
  return <BotNotesBlock bot={bot} key={bot} />
}

function BotNotesBlock({ bot }: { bot: string }) {
  const [notes, setNotes] = useState<BotNotes | null>(null)
  const [chosen, setChosen] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const generation = useRef(0)
  const pending = useRef(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const request = ++generation.current
    setError(null)
    void botNotesList(bot)
      .then(result => {
        if (request !== generation.current) {
          return
        }

        setNotes(result)
        setChosen(result.days[0]?.date ?? null)
      })
      .catch(cause => {
        if (request === generation.current) {
          setError(errorText(cause))
        }
      })

    return () => {
      generation.current += 1
    }
  }, [bot])

  const days = notes?.days ?? []
  const day = days.find(entry => entry.date === chosen) ?? days[0]
  const today = notes?.today ?? noteDay(new Date())

  /** Keep the list in step after a save or a delete; an empty day is gone. */
  const update = (date: string, text: string | null) => {
    if (!notes) {
      return
    }

    const next = notes.days.flatMap(entry =>
      entry.date !== date ? [entry] : text?.trim() ? [{ ...entry, text }] : []
    )

    setNotes({ ...notes, days: next })
    setChosen(next.some(entry => entry.date === date) ? date : (next[0]?.date ?? null))
  }

  /** Only merge new lines after the exact boundary used by the bot's append. */
  const save = async (date: string, loaded: string, value: string) => {
    if (pending.current) {
      return
    }

    pending.current = true
    setBusy(true)
    setError(null)
    const request = generation.current
    const active = () => request === generation.current

    try {
      try {
        await botNotesSet(bot, date, value, loaded)

        if (active()) {
          update(date, value)
        }
      } catch (cause) {
        if (!active()) {
          return
        }

        if ((cause as { code?: unknown }).code !== NOTES_CHANGED) {
          throw cause
        }

        const fresh = await botNotesList(bot)

        if (!active()) {
          return
        }

        const current = fresh.days.find(entry => entry.date === date)?.text ?? ''

        if (current === value) {
          update(date, current)

          return
        }

        const boundary = `${loaded.trimEnd()}\n`

        if (!current.startsWith(boundary)) {
          throw new Error('Notes changed elsewhere. Your draft is kept. Copy it before reloading.')
        }

        const appended = current.slice(boundary.length)
        const merged = [value.trimEnd(), appended].filter(Boolean).join('\n')
        await botNotesSet(bot, date, merged, current)

        if (active()) {
          update(date, merged)
        }
      }
    } catch (cause) {
      if (active()) {
        throw cause
      }
    } finally {
      pending.current = false

      if (active()) {
        setBusy(false)
      }
    }
  }

  const remove = async (date: string, expected: string) => {
    if (pending.current || !window.confirm(deleteNotesQuestion(date, today))) {
      return
    }

    pending.current = true
    setBusy(true)
    setError(null)
    const request = generation.current

    try {
      await botNotesDelete(bot, date, expected)

      if (request === generation.current) {
        update(date, null)
      }
    } catch (cause) {
      if (request === generation.current) {
        setError(errorText(cause))
      }
    } finally {
      pending.current = false

      if (request === generation.current) {
        setBusy(false)
      }
    }
  }

  return (
    <div className="space-y-3">
      <Group
        description={`Short notes the bot keeps each day. When dreaming is on, each dream keeps what lasts in memory. Days older than ${notes?.retention_days ?? 30} days are removed.`}
        title="Notes"
      >
        {error ? (
          <p className="px-4 py-3 text-[length:var(--text-secondary)] text-danger" role="alert">
            {error}
          </p>
        ) : null}
        {!notes ? (
          <div className="px-4 py-3">
            <SkeletonLines label="Loading notes" lines={2} />
          </div>
        ) : days.length === 0 ? (
          <Row title="No notes yet" />
        ) : (
          <div aria-label="Days with notes" role="group">
            {days.map(entry => {
              const count = noteCount(entry.text)
              const selected = entry.date === day?.date

              return (
                <button
                  aria-pressed={selected}
                  className={cn(
                    'flex min-h-[52px] w-full items-center gap-4 px-4 py-2.5 text-left outline-none transition-colors focus-visible:bg-foreground/[0.04]',
                    selected
                      ? 'bg-foreground/[0.05] text-foreground'
                      : 'text-muted hover:bg-foreground/[0.03] hover:text-foreground'
                  )}
                  disabled={busy}
                  key={entry.date}
                  onClick={() => setChosen(entry.date)}
                  type="button"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-[length:var(--text-body)]">
                      {noteDayLabel(entry.date, today)}
                    </span>
                    <span className="mt-0.5 block text-[length:var(--text-secondary)] text-muted">
                      {count} {count === 1 ? 'note' : 'notes'}
                    </span>
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </Group>
      {notes && day ? (
        <MemoryEditor
          actions={
            <Button
              disabled={busy}
              onClick={() => void remove(day.date, day.text)}
              size="sm"
              variant="ghost"
            >
              Delete
            </Button>
          }
          cap={notes.cap}
          disabled={busy}
          key={day.date}
          label={`Notes for ${noteDayLabel(day.date, today)}`}
          onSave={value => save(day.date, day.text, value)}
          rows={5}
          value={day.text}
        />
      ) : null}
    </div>
  )
}

/** One dream in the log: its summary, and when it changed memory, the before and after with a way back. */
function DreamEntry({
  bot,
  dream,
  onRestored,
  sectionId
}: {
  bot: string
  dream: Dream
  onRestored: (memoryMd: string) => void
  sectionId?: string
}) {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const changed =
    typeof dream.memory_before === 'string' &&
    typeof dream.memory_after === 'string' &&
    dream.memory_before !== dream.memory_after

  const summary = (
    <>
      <div className="line-clamp-2 text-[length:var(--text-secondary)]">
        <Markdown text={dream.summary || dream.status} />
      </div>
      <time className="text-[length:var(--text-meta)] text-muted">
        {formatTimestamp(dream.started_at)}
      </time>
    </>
  )

  return (
    <li className="px-4 py-3">
      {sectionId ? (
        <Link
          className="block hover:text-accent"
          params={{ bot, section: sectionId }}
          to="/b/$bot/s/$section"
        >
          {summary}
        </Link>
      ) : (
        <div>{summary}</div>
      )}
      {changed ? (
        <div className="mt-1">
          <button
            aria-expanded={open}
            className="text-[length:var(--text-meta)] text-muted hover:text-foreground"
            onClick={() => setOpen(!open)}
            type="button"
          >
            {open ? 'Hide what changed' : 'What changed'}
          </button>
          {open ? (
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {(['Before', 'After'] as const).map(label => (
                <div key={label}>
                  <span className="mb-1 block text-[length:var(--text-meta)] text-muted">
                    {label}
                  </span>
                  <pre className="max-h-48 overflow-auto rounded-[10px] bg-foreground/[0.05] p-2.5 font-mono text-[length:var(--text-meta)] whitespace-pre-wrap">
                    {(label === 'Before' ? dream.memory_before : dream.memory_after) || '(empty)'}
                  </pre>
                </div>
              ))}
              <div className="sm:col-span-2">
                <Button
                  onClick={() => {
                    if (
                      window.confirm(
                        'Restore the memory from before this dream? The current memory is kept in the log, so you can come back to it.'
                      )
                    ) {
                      void dreamingRestore(dream.id)
                        .then(result => onRestored(result.memory_md))
                        .catch(cause => setError(errorText(cause)))
                    }
                  }}
                  size="sm"
                  variant="secondary"
                >
                  Restore memory from before this dream
                </Button>
                {error ? (
                  <span className="ml-2 text-[length:var(--text-meta)] text-danger" role="alert">
                    {error}
                  </span>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  )
}

export function DreamingBlock({
  bot,
  onRestored = () => undefined,
  onSave
}: {
  bot: Bot
  onRestored?: (memoryMd: string) => void
  onSave: (patch: { dream_enabled?: boolean }) => Promise<void> | void
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
    // The daemon creates the Dreams section on its own, without a sections event.
    void sectionsActions().refresh()
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

  const when = (text: string) => (
    <span className="text-[length:var(--text-secondary)] text-muted">{text}</span>
  )

  return (
    <>
      <Group
        footer="Each day the bot reads its recent conversations and tidies its memory. Every dream keeps the memory it started from."
        title="Dreaming"
      >
        <Row
          control={
            <Switch
              aria-label="Enable dreaming"
              checked={bot.dream_enabled ?? true}
              onCheckedChange={checked => void onSave({ dream_enabled: checked })}
            />
          }
          title="Dream daily"
        />
        <Row control={when(formatTimestamp(status?.last_run_at))} title="Last run" />
        <Row control={when(formatTimestamp(status?.next_run_at))} title="Next run" />
        <Row
          control={
            <Button busy={running} disabled={!status?.enabled} onClick={() => void run()} size="sm">
              Dream now
            </Button>
          }
          description="Reads the latest conversations without waiting for tonight."
          title="Run a pass now"
        />
      </Group>
      {error ? (
        <p className="text-[length:var(--text-secondary)] text-danger" role="alert">
          {error}
        </p>
      ) : null}
      {dreams.length ? (
        <div>
          <p className="mb-2 px-1 text-[length:var(--text-meta)] font-medium text-muted">
            Dream log
          </p>
          <ul className={cn(cardClass, dividerClass)}>
            {dreams.map(dream => (
              <DreamEntry
                bot={bot.name}
                dream={dream}
                key={dream.id}
                onRestored={memoryMd => {
                  onRestored(memoryMd)
                  void load().catch(cause => setError(errorText(cause)))
                }}
                sectionId={dreamsSection?.id}
              />
            ))}
          </ul>
        </div>
      ) : null}
    </>
  )
}
