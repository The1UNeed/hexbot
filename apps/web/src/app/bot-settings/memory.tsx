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

/** One capped memory text with a counter. Used for About you and a bot's memory. */
export function MemoryEditor({
  cap,
  label,
  onSave,
  rows = 6,
  value
}: {
  cap: number
  label: string
  onSave: (value: string) => Promise<void>
  rows?: number
  value: string
}) {
  const [draft, setDraft] = useState(value)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => setDraft(value), [value])
  const tooLong = draft.length > cap
  const dirty = draft !== value

  const save = () => {
    if (tooLong) {
      return setError(`Keep this to ${cap} characters or fewer.`)
    }

    void onSave(draft).catch(cause => setError(errorText(cause)))
  }

  return (
    <div>
      <span className="mb-1.5 flex justify-end text-[length:var(--text-secondary)]">
        <span className={tooLong ? 'text-danger' : 'text-muted'}>
          {draft.length} / {cap}
        </span>
      </span>
      <Textarea
        aria-label={label}
        onChange={event => {
          setDraft(event.target.value)
          setError(null)
        }}
        rows={rows}
        value={draft}
      />
      {error ? (
        <span className="mt-1 block text-[length:var(--text-meta)] text-danger" role="alert">
          {error}
        </span>
      ) : null}
      {dirty ? (
        <Button className="mt-3" onClick={save} variant="primary">
          Save
        </Button>
      ) : null}
    </div>
  )
}

export function MemoryTab({ bot, onSave }: { bot: Bot; onSave: SaveBot }) {
  const botName = bot.name
  const [memory, setMemory] = useState<Awaited<ReturnType<typeof botMemoryGet>> | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    void botMemoryGet(botName)
      .then(setMemory)
      .catch(cause => setError(errorText(cause)))
  }, [botName])

  return (
    <div className="space-y-6">
      <Heading description="What this bot has learned. It writes here on its own; dreaming tidies it up each day.">
        Memory
      </Heading>
      {error ? (
        <p className="text-danger" role="alert">
          {error}
        </p>
      ) : memory ? (
        <MemoryEditor
          cap={memory.cap}
          label="Bot memory"
          onSave={async value => setMemory(await botMemorySet(botName, value))}
          value={memory.memory_md}
        />
      ) : (
        <SkeletonLines label="Loading memory" />
      )}
      <div className={cn(cardClass, 'flex items-center justify-between gap-3 px-3 py-2.5')}>
        <span>
          <span className="block font-medium">About you</span>
          <span className="block text-[length:var(--text-secondary)] text-muted">
            Written by you and read by all of your bots.
          </span>
        </span>
        <Link params={{ tab: 'memory' }} to="/settings/$tab">
          <Button size="sm" variant="secondary">
            Open in Settings
          </Button>
        </Link>
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

  return (
    <div className="border-t border-border pt-4">
      <h3 className="font-semibold">Dreaming</h3>
      <p className="mt-1 text-[length:var(--text-secondary)] text-muted">
        Each day, this bot reviews recent conversations and updates its memory.
      </p>
      <div className={cn(cardClass, 'mt-4 flex items-center justify-between gap-3 px-3 py-2.5')}>
        <span>Enabled for this bot</span>
        <Switch
          aria-label="Enable dreaming"
          checked={bot.dream_enabled ?? true}
          onCheckedChange={checked => void onSave({ dream_enabled: checked })}
        />
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
