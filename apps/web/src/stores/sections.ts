/**
 * Sections (= conversations = threads), keyed by id and grouped per bot.
 * Refreshed on `hexbot.sections.changed`. `liveSessionId` maps an open
 * section to the Hexbot live session its events arrive on.
 */

import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'

import {
  botsIntroduce,
  messagesFromHistory,
  sectionsArchive,
  sectionsCreate,
  sectionsDelete,
  sectionsList,
  sectionsOpen,
  sectionsRename,
  sectionsUnarchive
} from '../lib/api'
import { KICKOFF_MARKER } from '../lib/bot-kickoff'
import type { Bot, BotStatus, Section } from '../lib/types'

import { draftsActions } from './drafts'
import { useTranscripts } from './transcripts'

export interface SectionsState {
  archive: (id: string) => Promise<void>
  byId: Record<string, Section>
  /** Live ids are process-scoped; a new daemon epoch invalidates them all. */
  clearLive: () => void
  create: (bot: string, title?: string) => Promise<Section>
  error: null | string
  idsByBot: Record<string, string[]>
  liveSessionId: Record<string, string>
  loading: boolean
  /** The user just sent a message: list the section now, ahead of the daemon's count. */
  markTouched: (id: string) => void
  open: (id: string) => Promise<{ liveSessionId: null | string; section: Section }>
  refresh: (options?: { bot?: string; include_archived?: boolean }) => Promise<void>
  remove: (id: string, purgeMemory?: boolean) => Promise<void>
  rename: (id: string, title: string) => Promise<void>
  unarchive: (id: string) => Promise<void>
}

function indexSections(sections: Section[]): Pick<SectionsState, 'byId' | 'idsByBot'> {
  const byId: Record<string, Section> = {}
  const idsByBot: Record<string, string[]> = {}

  for (const section of sections) {
    byId[section.id] = section
    idsByBot[section.bot] = [...(idsByBot[section.bot] ?? []), section.id]
  }

  return { byId, idsByBot }
}

function mergeSection(state: SectionsState, section: Section): Partial<SectionsState> {
  const existing = state.idsByBot[section.bot] ?? []
  // Only the list carries the preview; a rename or archive reply must not blank it.
  const preview = section.preview || state.byId[section.id]?.preview || ''

  return {
    byId: { ...state.byId, [section.id]: { ...section, preview } },
    idsByBot: {
      ...state.idsByBot,
      [section.bot]: existing.includes(section.id) ? existing : [section.id, ...existing]
    }
  }
}

export const useSections = create<SectionsState>((set, get) => ({
  byId: {},
  error: null,
  idsByBot: {},
  liveSessionId: {},
  loading: false,

  async refresh(options = {}) {
    set({ error: null, loading: true })

    try {
      const result = await sectionsList({ include_archived: true, ...options })

      set(state => ({
        ...indexSections(result.sections ?? []),
        liveSessionId: {
          ...state.liveSessionId,
          ...Object.fromEntries(
            (result.sections ?? [])
              .filter(section => section.live_session_id)
              .map(section => [section.id, section.live_session_id as string])
          )
        },
        loading: false
      }))
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error), loading: false })
    }
  },

  async open(id) {
    const { messages, pending_clarify, section } = await sectionsOpen(id)
    const live = section.live_session_id

    set(state => ({
      ...mergeSection(state, section),
      liveSessionId: live ? { ...state.liveSessionId, [id]: live } : state.liveSessionId
    }))

    if (live) {
      useTranscripts
        .getState()
        .open(
          live,
          id,
          messagesFromHistory(messages ?? []).filter(
            // Hexbot replays an interrupted hidden kickoff as a plain user turn.
            message => !(message.role === 'user' && message.text.includes(KICKOFF_MARKER))
          )
        )

      if (pending_clarify) {
        useTranscripts.getState().clarifyRequest(live, pending_clarify, { notify: false })
      }
    }

    return { liveSessionId: live, section }
  },

  markTouched(id) {
    set(state => {
      const section = state.byId[id]

      return section && !section.message_count
        ? { byId: { ...state.byId, [id]: { ...section, message_count: 1 } } }
        : state
    })
  },

  async create(bot, title) {
    const { section } = await sectionsCreate(bot, title)

    set(state => ({
      ...mergeSection(state, section),
      liveSessionId: section.live_session_id
        ? { ...state.liveSessionId, [section.id]: section.live_session_id }
        : state.liveSessionId
    }))

    return section
  },

  async rename(id, title) {
    const { section } = await sectionsRename(id, title)

    set(state => mergeSection(state, section))
  },

  async archive(id) {
    const { section } = await sectionsArchive(id)

    set(state => mergeSection(state, section))
  },

  async unarchive(id) {
    const { section } = await sectionsUnarchive(id)

    set(state => mergeSection(state, section))
  },

  async remove(id, purgeMemory = true) {
    await sectionsDelete(id, purgeMemory)
    draftsActions().clear(id)

    const live = get().liveSessionId[id]

    if (live) {
      useTranscripts.getState().drop(live)
    }

    set(state => {
      const byId = { ...state.byId }
      const section = byId[id]
      delete byId[id]

      const liveSessionId = { ...state.liveSessionId }
      delete liveSessionId[id]

      return {
        byId,
        idsByBot: section
          ? {
              ...state.idsByBot,
              [section.bot]: (state.idsByBot[section.bot] ?? []).filter(item => item !== id)
            }
          : state.idsByBot,
        liveSessionId
      }
    })
  },

  clearLive() {
    set({ liveSessionId: {} })
    useTranscripts.getState().dropAll()
  }
}))

export function sectionsActions(): SectionsState {
  return useSections.getState()
}

export function selectSectionsForBot(bot: null | string) {
  return (state: SectionsState): Section[] =>
    bot
      ? (state.idsByBot[bot] ?? [])
          .map(id => state.byId[id])
          .filter((item): item is Section => Boolean(item))
      : []
}

export function useSectionsForBot(bot: null | string): Section[] {
  return useSections(useShallow(selectSectionsForBot(bot)))
}

export function useSection(id: null | string): Section | undefined {
  return useSections(state => (id ? state.byId[id] : undefined))
}

export function useLiveSessionId(sectionId: null | string): null | string {
  return useSections(state => (sectionId ? (state.liveSessionId[sectionId] ?? null) : null))
}

/**
 * Ask the daemon to hand a fresh bot its hidden first prompt, so it greets
 * you and asks its questions. The daemon attaches this client to the section
 * before it submits, so the greeting streams here.
 */
export async function introduceBot(section: Section, bot: Pick<Bot, 'name'>): Promise<void> {
  try {
    await botsIntroduce(bot.name, section.id)
  } catch {
    // The bot exists either way; the user can just start typing.
  }
}

/** Per-section state the open transcripts know before the daemon does. */
export type LiveSections = Record<string, BotStatus>

/** What each open transcript says about its section: a card waiting on you, or a reply streaming. */
export function liveSectionsOf(
  bySession: Record<
    string,
    {
      approvals: { decision?: unknown }[]
      clarifies: { answers: Record<string, string>; expired?: boolean; questions: unknown[] }[]
      sectionId?: string
      streamingMessageId: null | string
    }
  >
): LiveSections {
  const live: LiveSections = {}

  for (const transcript of Object.values(bySession)) {
    if (!transcript.sectionId) {
      continue
    }

    const asking =
      transcript.clarifies.some(
        item => !item.expired && Object.keys(item.answers).length < item.questions.length
      ) || transcript.approvals.some(item => !item.decision)

    if (asking) {
      live[transcript.sectionId] = 'needs_you'
    } else if (transcript.streamingMessageId) {
      live[transcript.sectionId] = 'working'
    }
  }

  return live
}

/** The daemon's word on a bot; a record without the field is idle. */
export function botStatus(bot: Bot | undefined): BotStatus {
  return bot?.status ?? 'idle'
}

/**
 * A section's state: the daemon's status when its detail names this section,
 * else what the live transcript says.
 */
export function sectionStatusOf(
  bot: Bot | undefined,
  sectionId: null | string,
  live: LiveSections = {}
): BotStatus {
  const status = botStatus(bot)

  if (status !== 'idle' && sectionId && bot?.status_detail?.section_id === sectionId) {
    return status
  }

  return (sectionId && live[sectionId]) || 'idle'
}

/** A bot's dot: the daemon's word, unless a live section is waiting on you right now. */
export function botStatusWithLive(bot: Bot, sections: Section[], live: LiveSections): BotStatus {
  const status = botStatus(bot)

  if (status === 'stopped') {
    return status
  }

  const own = sections.map(section => live[section.id])

  if (own.includes('needs_you')) {
    return 'needs_you'
  }

  return status !== 'idle' ? status : own.includes('working') ? 'working' : 'idle'
}
