/**
 * Sections (= conversations = threads), keyed by id and grouped per bot.
 * Refreshed on `hexbot.sections.changed`. `liveSessionId` maps an open
 * section to the Hermes live session its events arrive on.
 */

import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'

import {
  messagesFromHistory,
  sectionsArchive,
  sectionsCreate,
  sectionsDelete,
  sectionsList,
  sectionsOpen,
  sectionsRename,
  sectionsUnarchive
} from '../lib/api'
import type { Section } from '../lib/types'

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

  return {
    byId: { ...state.byId, [section.id]: section },
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
    const { messages, section } = await sectionsOpen(id)
    const live = section.live_session_id

    set(state => ({
      ...mergeSection(state, section),
      liveSessionId: live ? { ...state.liveSessionId, [id]: live } : state.liveSessionId
    }))

    if (live) {
      useTranscripts.getState().open(live, id, messagesFromHistory(messages ?? []))
    }

    return { liveSessionId: live, section }
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
