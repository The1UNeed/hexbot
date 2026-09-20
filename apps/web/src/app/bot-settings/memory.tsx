import { Link } from '@tanstack/react-router'
import { useCallback, useEffect, useState } from 'react'

import { Button } from '../../components/ui/button'
import { SkeletonLines } from '../../components/ui/skeleton'
import { Switch } from '../../components/ui/switch'
import { Textarea } from '../../components/ui/textarea'
import {
  botMemoryGet,
  botMemorySet,
  dreamingList,
  dreamingRunNow,
  dreamingStatus
} from '../../lib/api'
import { cn } from '../../lib/cn'
import type { Bot } from '../../lib/types'
import { sectionsActions, useSectionsForBot } from '../../stores/sections'
import { Markdown } from '../conversation'

import { cardClass, errorText, formatTimestamp, Heading, type SaveBot } from './shared'

/** One capped core memory section, saved on blur. Used by Settings, Memory. */
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

export function MemoryTab({ bot, onSave }: { bot: Bot; onSave: SaveBot }) {
  const botName = bot.name
  const [notes, setNotes] = useState<Awaited<ReturnType<typeof botMemoryGet>> | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState({ memory_md: '', user_md: '' })
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    void botMemoryGet(botName)
      .then(next => {
        setNotes(next)
        setDraft(next)
      })
      .catch(cause => setError(errorText(cause)))
  }, [botName])

  return (
    <div className="space-y-6">
      <Heading description="What this bot remembers on its own. Core memory, shared by every bot, lives in Settings.">
        Memory
      </Heading>
      <div className={cn(cardClass, 'flex items-center justify-between gap-3 px-3 py-2.5')}>
        <span>
          <span className="block font-medium">Core memory</span>
          <span className="block text-[length:var(--text-secondary)] text-muted">
            Shared by all of your bots and injected every turn.
          </span>
        </span>
        <Link params={{ tab: 'memory' }} to="/settings/$tab">
          <Button size="sm" variant="secondary">
            Open in Settings
          </Button>
        </Link>
      </div>
      <div>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-semibold">Bot notes</h3>
          <Button
            onClick={() => {
              if (editing && notes) {
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
        {error ? (
          <p className="text-danger" role="alert">
            {error}
          </p>
        ) : notes ? (
          <>
            <label className="mb-3 block">
              <span className="mb-1 block text-muted">Memory</span>
              <Textarea
                aria-label="Bot memory notes"
                disabled={!editing}
                onChange={event => setDraft(value => ({ ...value, memory_md: event.target.value }))}
                rows={6}
                value={draft.memory_md}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-muted">User notes</span>
              <Textarea
                aria-label="Bot user notes"
                disabled={!editing}
                onChange={event => setDraft(value => ({ ...value, user_md: event.target.value }))}
                rows={4}
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
          </>
        ) : (
          <SkeletonLines label="Loading memory" />
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
