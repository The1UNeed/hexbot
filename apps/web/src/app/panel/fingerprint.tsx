import { useNavigate } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'
import { type CSSProperties, lazy, Suspense, useEffect, useState } from 'react'

import { type BotMemory, botMemoryGet, botMemorySet } from '../../lib/api'
import type { Bot } from '../../lib/types'
import { useBots } from '../../stores/bots'

import { headingClass } from './rows'

export type FingerprintFile = 'memory' | 'soul'

// The editor loads the first time a file opens; most visits never open one.
const DocumentEditor = lazy(() =>
  import('./document-editor').then(module => ({ default: module.DocumentEditor }))
)

/**
 * The bot's memory, read when the panel needs it and again after the bot
 * writes it (`writes` counts its finished memory steps in the chat).
 */
export function useBotMemory(
  bot: string,
  enabled: boolean,
  writes: number
): [BotMemory | null, (memory: BotMemory) => void] {
  const [memory, setMemory] = useState<{ bot: string; value: BotMemory } | null>(null)

  useEffect(() => {
    if (!enabled) {
      return
    }

    let live = true

    botMemoryGet(bot)
      .then(value => live && setMemory({ bot, value }))
      .catch(() => undefined)

    return () => {
      live = false
    }
  }, [bot, enabled, writes])

  return [memory?.bot === bot ? memory.value : null, value => setMemory({ bot, value })]
}

/** 10.25.26, in the reader's own order of day and month. */
export function cardDate(seconds: null | number | undefined): string {
  if (!seconds) {
    return 'Not written yet'
  }

  return new Date(seconds * 1000)
    .toLocaleDateString(undefined, { day: '2-digit', month: '2-digit', year: '2-digit' })
    .replace(/[/-]/g, '.')
}

/** A grain over the card's colour, drawn once: no motion, no repaint. */
const GRAIN = `url("data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><filter id="g"><feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="3" stitchTiles="stitch"/><feColorMatrix values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 .55 0"/></filter><rect width="100%" height="100%" filter="url(#g)"/></svg>'
)}")`

const CARDS: Record<
  FingerprintFile,
  { background: string; fileName: string; line: string; title: string }
> = {
  memory: {
    background:
      'radial-gradient(120% 90% at 70% 30%, #5a5cf0 0%, transparent 60%), radial-gradient(90% 80% at 20% 90%, #1d1a8f 0%, transparent 70%), linear-gradient(160deg, #3c3fd6, #2622a6)',
    fileName: 'MEMORY.md',
    line: 'What it remembers',
    title: 'Memory'
  },
  soul: {
    background:
      'radial-gradient(110% 90% at 75% 25%, #ef4d63 0%, transparent 60%), radial-gradient(90% 80% at 15% 95%, #8f1028 0%, transparent 70%), linear-gradient(160deg, #d8314b, #a8182f)',
    fileName: 'SOUL.md',
    line: 'Who it is',
    title: 'Soul'
  }
}

function FileCard({
  date,
  file,
  onOpen
}: {
  date: null | number | undefined
  file: FingerprintFile
  onOpen: () => void
}) {
  const card = CARDS[file]

  return (
    <button
      aria-label={`${card.title}, edited ${cardDate(date)}`}
      className="hex-focus group relative flex aspect-[6/5] flex-col justify-between overflow-hidden rounded-[20px] p-4 text-left text-white shadow-card transition-[transform,box-shadow] duration-[var(--hex-motion-fast)] hover:-translate-y-px hover:shadow-popup active:scale-[0.98]"
      data-testid={`fingerprint-${file}`}
      onClick={onOpen}
      style={{ backgroundImage: `${GRAIN}, ${card.background}` } as CSSProperties}
      type="button"
    >
      <span>
        <span className="block text-[17px] leading-tight font-semibold tracking-wide uppercase">
          {card.title}
        </span>
        <span className="mt-1 block font-mono text-[10px] tracking-[0.08em] text-white/75 uppercase">
          {card.line}
        </span>
      </span>
      <span className="font-mono text-[13px] tracking-wide text-white/85 tabular-nums">
        {cardDate(date)}
      </span>
    </button>
  )
}

function about(file: FingerprintFile, name: string) {
  const lead = <strong className="font-semibold not-italic">About this file.</strong>

  return file === 'soul' ? (
    <>
      {lead} This is {name}&apos;s soul: who it is and the values it tries to hold to in every
      conversation. {name} may refine it over time and tells you when it does. You can edit it at
      any time. This note is not part of the file.
    </>
  ) : (
    <>
      {lead} This is what {name} remembers: facts, preferences and lessons it keeps from one
      conversation to the next. {name} writes it as you talk, and dreaming tidies it each day. You
      can edit it at any time. This note is not part of the file.
    </>
  )
}

/** The open editor, for the Fingerprint tab and for soul and memory search results. */
export function FingerprintEditor({
  bot,
  file,
  memory,
  onClose,
  onMemory
}: {
  bot: Bot
  file: FingerprintFile
  memory: BotMemory | null
  onClose: () => void
  onMemory: (memory: BotMemory) => void
}) {
  const update = useBots(state => state.update)
  const card = CARDS[file]

  if (file === 'memory' && !memory) {
    return null
  }

  return (
    <Suspense fallback={null}>
      <DocumentEditor
        about={about(file, bot.display_name)}
        cap={file === 'memory' ? memory?.cap : undefined}
        fileName={card.fileName}
        onClose={onClose}
        onSave={async text => {
          if (file === 'memory') {
            onMemory(await botMemorySet(bot.name, text))
          } else {
            await update(bot.name, { persona: text })
          }
        }}
        title={`${bot.display_name} · ${card.title}`}
        value={file === 'memory' ? (memory?.memory_md ?? '') : bot.persona}
      />
    </Suspense>
  )
}

/**
 * Fingerprint: what makes the bot itself. Its soul and its memory as two
 * cards, each with the day it last changed; either opens full window to read
 * and edit.
 */
export function FingerprintTab({
  bot,
  memory,
  onOpen
}: {
  bot: Bot
  memory: BotMemory | null
  onOpen: (file: FingerprintFile) => void
}) {
  const navigate = useNavigate()

  return (
    <div className="grid gap-4">
      <div className="grid grid-cols-2 gap-2.5">
        <FileCard date={bot.persona_updated_at} file="soul" onOpen={() => onOpen('soul')} />
        <FileCard date={memory?.updated_at} file="memory" onOpen={() => onOpen('memory')} />
      </div>
      <p className="px-1 text-[length:var(--text-meta)] text-muted">
        {bot.display_name} and you both write these. Your chat takes changes after it summarises
        older messages.
      </p>
      <section>
        <h3 className={headingClass}>More</h3>
        <button
          className="hex-focus flex min-h-11 w-full items-center gap-3 rounded-[16px] bg-background px-3.5 py-2 text-left shadow-card transition-colors duration-[var(--hex-motion-fast)] hover:bg-foreground/[0.03]"
          onClick={() =>
            void navigate({ params: { bot: bot.name, tab: 'memory' }, to: '/b/$bot/settings/$tab' })
          }
          type="button"
        >
          <span className="flex-1 font-medium">Notes and dreaming</span>
          <ChevronRight className="shrink-0 text-muted" size={14} />
        </button>
      </section>
    </div>
  )
}
