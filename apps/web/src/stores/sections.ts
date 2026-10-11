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
import type { Bot, BotStatus, Message, Section } from '../lib/types'

import { draftsActions } from './drafts'
import { transcriptRevision, useTranscripts } from './transcripts'

/**
 * A thread: the private conversation in which `peer_bot` asks `bot` for help.
 * The daemon leaves threads out of its lists; this guards every other path a
 * section can arrive by (a bot's recent sections, a changed event, an open).
 */
export const isThread = (section: Pick<Section, 'peer_bot'>) => Boolean(section.peer_bot)

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
  /**
   * The user just sent `text`: list the section now, ahead of the daemon's count, and
   * title an unnamed one after it the way the daemon will.
   */
  markTouched: (id: string, text?: string) => void
  open: (id: string) => Promise<{ liveSessionId: null | string; section: Section }>
  /**
   * Open a thread for the side panel: its history with `peer`'s questions as
   * messages, and its live session registered so events stream in. The
   * thread itself stays out of the section index.
   */
  openThread: (
    id: string,
    peer: string
  ) => Promise<{ liveSessionId: null | string; messages: Message[]; section: Section }>
  refresh: (options?: { bot?: string; include_archived?: boolean }) => Promise<void>
  remove: (id: string, purgeMemory?: boolean) => Promise<void>
  rename: (id: string, title: string) => Promise<void>
  /** Titles from first messages still on their way to the daemon, by section id. */
  sendingTitles: Record<string, string>
  /** The first message reached the daemon, or failed: take the daemon's title again. */
  settleTitle: (id: string) => Promise<void>
  unarchive: (id: string) => Promise<void>
}

/** What the daemon calls a section nobody has named yet. */
const DEFAULT_TITLE = 'New section'

const QUOTES = /^["'“”]+|["'“”]+$/g

// Rust's char::is_whitespace, which its trim uses; JavaScript's trim differs at U+0085 and U+FEFF.
const SPACE = '[\\t-\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]+'
const EDGE_SPACE = new RegExp(`^${SPACE}|${SPACE}$`, 'g')
const trim = (text: string) => text.replace(EDGE_SPACE, '')

/** The title the daemon gives a section from its first message (`clean_title` in catalog.rs). */
export const titleFromPrompt = (text: string) =>
  [
    ...trim(
      trim(text)
        .replace(QUOTES, '')
        .replace(/[.!]+$/, '')
        .replace(QUOTES, '')
    ).replace(/[\n\r]/g, ' ')
  ]
    .slice(0, 60)
    .join('')

/** A section as the daemon reported it, keeping the title of a first message still being sent. */
function withSendingTitle(section: Section, titles: Record<string, string>): Section {
  const title = titles[section.id]

  return title && section.title === DEFAULT_TITLE && !section.title_by
    ? { ...section, title, title_by: 'bot' }
    : section
}

function indexSections(
  sections: Section[],
  titles: Record<string, string>
): Pick<SectionsState, 'byId' | 'idsByBot'> {
  const byId: Record<string, Section> = {}
  const idsByBot: Record<string, string[]> = {}

  for (const section of sections) {
    if (isThread(section)) {
      continue
    }

    byId[section.id] = withSendingTitle(section, titles)
    idsByBot[section.bot] = [...(idsByBot[section.bot] ?? []), section.id]
  }

  return { byId, idsByBot }
}

function mergeSection(state: SectionsState, section: Section): Partial<SectionsState> {
  if (isThread(section)) {
    return {}
  }

  const existing = state.idsByBot[section.bot] ?? []
  // Only the list carries the preview; a rename or archive reply must not blank it.
  const preview = section.preview || state.byId[section.id]?.preview || ''

  return {
    byId: {
      ...state.byId,
      [section.id]: { ...withSendingTitle(section, state.sendingTitles), preview }
    },
    idsByBot: {
      ...state.idsByBot,
      [section.bot]: existing.includes(section.id) ? existing : [section.id, ...existing]
    }
  }
}

let sectionsRequest = 0
let latestSectionsRefresh = 0
let fullSectionsRequest = 0
const botSectionsRequests = new Map<string, number>()
const openedSectionRequests = new Map<string, number>()

/** A successful edit is newer than any list already in flight for that bot. */
function sectionChanged(bot: string): void {
  botSectionsRequests.set(bot, ++sectionsRequest)
}

export const useSections = create<SectionsState>((set, get) => ({
  byId: {},
  error: null,
  idsByBot: {},
  liveSessionId: {},
  loading: false,
  sendingTitles: {},

  async refresh(options = {}) {
    const request = ++sectionsRequest
    latestSectionsRefresh = request
    const bot = options.bot

    set({ error: null, loading: true })

    try {
      const result = await sectionsList({ include_archived: true, ...options })

      const current =
        fullSectionsRequest < request && (!bot || (botSectionsRequests.get(bot) ?? 0) < request)

      if (!current) {
        return
      }

      // Only accepted data supersedes an older reply; failed requests do not hide it.
      if (bot) {
        botSectionsRequests.set(bot, request)
      } else {
        fullSectionsRequest = request
      }

      set(state => {
        // A full reply can still update other bots after a newer scoped reply or edit.
        const preserve = (name: string) =>
          bot ? name !== bot : (botSectionsRequests.get(name) ?? 0) > request

        const openedAfter = (id: string) => (openedSectionRequests.get(id) ?? 0) > request

        const incoming = (result.sections ?? [])
          .filter(section => !preserve(section.bot))
          .map(section => {
            const opened = state.byId[section.id]

            return openedAfter(section.id) && opened
              ? { ...opened, preview: section.preview || opened.preview }
              : section
          })

        const newlyOpened = Object.values(state.byId).filter(
          section =>
            !preserve(section.bot) &&
            openedAfter(section.id) &&
            !incoming.some(item => item.id === section.id)
        )

        const indexed = indexSections([...newlyOpened, ...incoming], state.sendingTitles)

        return {
          byId: {
            ...Object.fromEntries(
              Object.entries(state.byId).filter(([, section]) => preserve(section.bot))
            ),
            ...indexed.byId
          },
          idsByBot: {
            ...Object.fromEntries(
              Object.entries(state.idsByBot).filter(([name]) => preserve(name))
            ),
            ...indexed.idsByBot
          },
          liveSessionId: {
            ...state.liveSessionId,
            ...Object.fromEntries(
              incoming
                .filter(section => section.live_session_id)
                .map(section => [section.id, section.live_session_id as string])
            )
          }
        }
      })
    } catch (error) {
      if (request === latestSectionsRefresh) {
        set({ error: error instanceof Error ? error.message : String(error) })
      }
    } finally {
      if (request === latestSectionsRefresh) {
        set({ loading: false })
      }
    }
  },

  async open(id) {
    const revision = transcriptRevision()
    const { context, messages, pending_clarify, section } = await sectionsOpen(id)
    const live = section.live_session_id

    openedSectionRequests.set(section.id, ++sectionsRequest)
    set(state => ({
      ...mergeSection(state, section),
      liveSessionId: live ? { ...state.liveSessionId, [id]: live } : state.liveSessionId
    }))

    if (live) {
      const transcripts = useTranscripts.getState()
      const newer = (transcripts.bySession[live]?.authorityRevision ?? 0) > revision
      transcripts.open(
        live,
        id,
        messagesFromHistory(messages ?? []).filter(
          // Hexbot replays an interrupted hidden kickoff as a plain user turn.
          message => !(message.role === 'user' && message.text.includes(KICKOFF_MARKER))
        ),
        revision
      )

      if (context) {
        useTranscripts.getState().sessionContext(live, context)
      }

      if (pending_clarify) {
        useTranscripts.getState().clarifyRequest(live, pending_clarify, {
          notify: false,
          throughRevision: newer ? revision : undefined
        })
      }
    }

    return { liveSessionId: live, section }
  },

  async openThread(id, peer) {
    const revision = transcriptRevision()
    const { messages, pending_clarify, section } = await sectionsOpen(id)
    const live = section.live_session_id

    if (live) {
      const newer = (useTranscripts.getState().bySession[live]?.authorityRevision ?? 0) > revision
      set(state => ({ liveSessionId: { ...state.liveSessionId, [id]: live } }))
      useTranscripts.getState().clearAnsweredWaiting([], [live], revision)
      useTranscripts.getState().setSectionId(live, id)

      // The owner answers the receiving bot's questions here: threads have no other view.
      if (pending_clarify) {
        useTranscripts.getState().clarifyRequest(live, pending_clarify, {
          notify: false,
          throughRevision: newer ? revision : undefined
        })
      }
    }

    return {
      liveSessionId: live,
      messages: messagesFromHistory(messages ?? [], { sender: peer }),
      section
    }
  },

  markTouched(id, text = '') {
    set(state => {
      const section = state.byId[id]

      if (!section) {
        return state
      }

      const title =
        section.title === DEFAULT_TITLE && !section.title_by ? titleFromPrompt(text) : ''

      return section.message_count && !title
        ? state
        : {
            byId: {
              ...state.byId,
              [id]: {
                ...section,
                message_count: section.message_count || 1,
                ...(title ? { title, title_by: 'bot' as const } : {})
              }
            },
            sendingTitles: title ? { ...state.sendingTitles, [id]: title } : state.sendingTitles
          }
    })
  },

  async settleTitle(id) {
    if (!(id in get().sendingTitles)) {
      return
    }

    set(state => {
      const sendingTitles = { ...state.sendingTitles }
      delete sendingTitles[id]

      return { sendingTitles }
    })

    // The daemon titled the section before it answered, or kept its name, or refused the message.
    await get().refresh()
  },

  async create(bot, title) {
    const { section } = await sectionsCreate(bot, title)

    sectionChanged(section.bot)
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

    sectionChanged(section.bot)
    set(state => mergeSection(state, section))
  },

  async archive(id) {
    const { section } = await sectionsArchive(id)

    sectionChanged(section.bot)
    set(state => mergeSection(state, section))
  },

  async unarchive(id) {
    const { section } = await sectionsUnarchive(id)

    sectionChanged(section.bot)
    set(state => mergeSection(state, section))
  },

  async remove(id, purgeMemory = true) {
    const bot = get().byId[id]?.bot
    await sectionsDelete(id, purgeMemory)
    openedSectionRequests.delete(id)

    if (bot) {
      sectionChanged(bot)
    }

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

/** Fresh transitions and answer evidence expire on newer roster or lifecycle authority. */
export type LiveSections = Record<
  string,
  BotStatus | 'answered' | { status: 'idle' | 'needs_you' | 'working' }
>

/** What each open transcript says about its section: a card waiting on you, a reply streaming, or neither. */
export function liveSectionsOf(
  bySession: Record<
    string,
    {
      answeredWaiting?: { kind: 'approval' | 'clarify'; requestId: string }
      liveStatus?: 'idle' | 'needs_you' | 'working'
      approvals: { decision?: unknown; requestId?: string }[]
      clarifies: {
        answers: Record<string, string>
        expired?: boolean
        questions: unknown[]
        requestId?: string
      }[]
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

    const answered = transcript.answeredWaiting

    const hasAnswer =
      answered?.kind === 'approval'
        ? transcript.approvals.some(item => item.requestId === answered.requestId && item.decision)
        : answered?.kind === 'clarify' &&
          transcript.clarifies.some(
            item =>
              item.requestId === answered.requestId &&
              !item.expired &&
              Object.keys(item.answers).length >= item.questions.length
          )

    live[transcript.sectionId] = transcript.liveStatus
      ? { status: transcript.liveStatus }
      : asking
        ? 'needs_you'
        : hasAnswer
          ? 'answered'
          : transcript.streamingMessageId
            ? 'working'
            : 'idle'
  }

  return live
}

/** The daemon's word on a bot; a record without the field is idle. */
export function botStatus(bot: Bot | undefined): BotStatus {
  return bot?.status ?? 'idle'
}

/**
 * A section's state: the daemon's status when its detail names this section,
 * else what the live transcript says. An open transcript has your answer
 * before the daemon's next word, so a section waiting on a question you just
 * answered reads as working.
 */
export function sectionStatusOf(
  bot: Bot | undefined,
  sectionId: null | string,
  live: LiveSections = {}
): BotStatus {
  const status = botStatus(bot)
  const own = sectionId ? live[sectionId] : undefined
  const fresh = typeof own === 'object' ? own.status : undefined

  if (status !== 'idle' && sectionId && bot?.status_detail?.section_id === sectionId) {
    return status === 'stopped'
      ? status
      : (fresh ?? (status === 'needs_you' && own === 'answered' ? 'working' : status))
  }

  return typeof own === 'object' ? own.status : own === 'answered' ? 'working' : (own ?? 'idle')
}

/**
 * A bot's dot: the daemon's word for the section it names, unless a live
 * section is waiting on you right now. Archived sections no longer count.
 */
export function botStatusWithLive(
  bot: Bot,
  sections: Section[],
  live: LiveSections,
  sessions: Record<string, Partial<Parameters<typeof liveSectionsOf>[0][string]>> = {}
): BotStatus {
  const status = botStatus(bot)

  const detail = bot.status_detail

  const archivedRetry =
    detail?.action?.kind === 'retry' &&
    !detail.room_id &&
    sections.some(section => section.id === detail.section_id && section.archived_at)

  if (status === 'stopped' && !archivedRetry) {
    return status
  }

  const own = sections
    .filter(section => !section.archived_at)
    .map(section => sectionStatusOf(bot, section.id, live))

  const named = bot.status_detail?.section_id

  // Rooms and private threads are absent from the section index but still count.
  if (!named || !sections.some(section => section.id === named)) {
    const session = detail?.session_id ? sessions[detail.session_id] : undefined

    const ownsSession =
      session &&
      (detail?.room_id
        ? session.sectionId === `room:${detail.room_id}`
        : named && session.sectionId === named)

    const sessionLive = ownsSession
      ? liveSectionsOf({
          own: {
            ...session,
            approvals: session.approvals ?? [],
            clarifies: session.clarifies ?? [],
            streamingMessageId: null
          }
        })[session.sectionId!]
      : undefined

    const fresh =
      sessionLive === 'answered'
        ? 'working'
        : typeof sessionLive === 'object'
          ? sessionLive.status
          : undefined

    own.push(fresh ?? (named ? sectionStatusOf(bot, named, live) : status))
  }

  return own.includes('needs_you') ? 'needs_you' : own.includes('working') ? 'working' : 'idle'
}
