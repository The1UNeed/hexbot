/**
 * Sections (= conversations = threads), keyed by id and grouped per bot.
 * Refreshed on `hexbot.sections.changed`. `liveSessionId` maps an open
 * section to the Hexbot live session its events arrive on.
 */

import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'

import {
  botsIntroduce,
  clarifyAnswered,
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
import type { Bot, BotStatus, ClarifyRequest, Message, Section } from '../lib/types'

import { draftsActions } from './drafts'
import { useRooms } from './rooms'
import { clarifyWaiting, type Transcript, transcriptRevision, useTranscripts } from './transcripts'

/**
 * A thread: the private conversation in which `peer_bot` asks `bot` for help.
 * The daemon leaves threads out of its lists; this guards every other path a
 * section can arrive by (a bot's recent sections, a changed event, an open).
 */
export const isThread = (section: Pick<Section, 'peer_bot'>) => Boolean(section.peer_bot)

function clarifySettled(transcript: Transcript | undefined, requestId: string | undefined) {
  return Boolean(
    requestId &&
    (transcript?.settledClarifyIds?.includes(requestId) ||
      transcript?.clarifies.some(card => card.requestId === requestId && !clarifyWaiting(card)))
  )
}

async function openSnapshot(id: string) {
  const revision = transcriptRevision()
  let snapshot = await sectionsOpen(id)
  let pendingClarifies = snapshot.pending_clarify ? [snapshot.pending_clarify] : []
  const live = snapshot.section.live_session_id
  const transcript = live ? useTranscripts.getState().bySession[live] : undefined
  const requestId = snapshot.pending_clarify?.request_id

  // Working can follow an unrelated approval while this question is still pending.
  if (
    snapshot.pending_clarify &&
    transcript &&
    transcript.authorityRevision > revision &&
    (transcript.liveStatus === 'working' || transcript.liveStatus === 'idle') &&
    !clarifySettled(transcript, requestId)
  ) {
    const card = transcript.clarifies.find(item => item.requestId === requestId)

    try {
      const verified = await sectionsOpen(id)
      pendingClarifies = verified.pending_clarify
        ? verified.section.live_session_id === live &&
          verified.pending_clarify.request_id !== requestId
          ? [...pendingClarifies, verified.pending_clarify]
          : [verified.pending_clarify]
        : []
      snapshot = verified
      const current = useTranscripts.getState().bySession[transcript.sessionId]

      if (
        requestId &&
        snapshot.section.live_session_id === live &&
        !snapshot.pending_clarify &&
        current?.epoch === transcript.epoch &&
        (card
          ? current.clarifies.includes(card)
          : !current.clarifies.some(item => item.requestId === requestId))
      ) {
        useTranscripts.getState().clarifyExpire(transcript.sessionId, requestId, {
          preserveEvidence: true
        })
      }
    } catch {
      // A failed verification leaves the question visible so it can still be answered.
    }
  }

  const currentLive = snapshot.section.live_session_id
  const current = currentLive ? useTranscripts.getState().bySession[currentLive] : undefined
  pendingClarifies = pendingClarifies.filter(
    pending => !clarifySettled(current, pending.request_id)
  )

  return { pendingClarifies, revision, snapshot }
}

export interface SectionsState {
  archive: (id: string) => Promise<void>
  byId: Record<string, Section>
  /** Live ids are process-scoped; a new daemon epoch invalidates them all. */
  clearLive: () => void
  create: (bot: string, title?: string) => Promise<Section>
  /** A successful delete reply or definitive notification retires this exact section. */
  drop: (id: string, bot?: string) => void
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

function sectionMetadata(section: Section) {
  return {
    archived_at: section.archived_at,
    title: section.title,
    title_by: section.title_by,
    updated_at: section.updated_at
  }
}

function mergeEditedSection(state: SectionsState, section: Section, rename = false) {
  const current = state.byId[section.id]

  return mergeSection(
    state,
    current
      ? {
          ...current,
          updated_at: section.updated_at,
          ...(rename
            ? { title: section.title, title_by: section.title_by }
            : { archived_at: section.archived_at })
        }
      : section
  )
}

let sectionsRequest = 0
let latestSectionsRefresh = 0
let fullSectionsRequest = 0
const botSectionsRequests = new Map<string, number>()
const sectionRequests = new Map<string, number>()
const boundSectionRequests = new Map<string, number>()
const removedSectionRequests = new Map<string, { active: boolean; bot?: string; request: number }>()

export function clearDeletedSections(): void {
  // A new daemon must not inherit status proof, but old promises stay fenced.
  for (const removed of removedSectionRequests.values()) {
    removed.active = false
  }
}

function removedAfter(id: string, request: number): boolean {
  return (removedSectionRequests.get(id)?.request ?? 0) > request
}

function acceptSection(id: string, request: number): void {
  sectionRequests.set(id, Math.max(sectionRequests.get(id) ?? 0, request))

  const removed = removedSectionRequests.get(id)

  if (removed && removed.request < request) {
    // A newer row retires status proof, while pre-delete requests stay fenced.
    removed.active = false
  }
}

function openedSection(section: Section, request: number): Section {
  if (removedAfter(section.id, request)) {
    throw new Error('This section was deleted.')
  }

  const current = useSections.getState().byId[section.id]

  return current && (sectionRequests.get(section.id) ?? 0) > request
    ? { ...section, ...sectionMetadata(current) }
    : section
}

/** A successful edit protects this row without discarding siblings from an in-flight list. */
function sectionChanged(id: string): void {
  acceptSection(id, ++sectionsRequest)
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
        // A full reply can still update other bots after a newer scoped reply.
        const preserve = (name: string) =>
          bot ? name !== bot : (botSectionsRequests.get(name) ?? 0) > request

        const openedAfter = (id: string) => (sectionRequests.get(id) ?? 0) > request

        const incoming = (result.sections ?? [])
          .filter(section => !preserve(section.bot) && !removedAfter(section.id, request))
          .map(section => {
            const opened = state.byId[section.id]
            const boundLive = state.liveSessionId[section.id]

            const current =
              openedAfter(section.id) && opened
                ? { ...opened, preview: section.preview || opened.preview }
                : section

            // A list already in flight can carry the live id from before this open completed.
            return (boundSectionRequests.get(section.id) ?? 0) > request && boundLive
              ? {
                  ...current,
                  live_session_id: boundLive,
                  message_count: opened?.message_count ?? current.message_count
                }
              : current
          })

        const newlyOpened = Object.values(state.byId).filter(
          section =>
            !preserve(section.bot) &&
            openedAfter(section.id) &&
            !incoming.some(item => item.id === section.id)
        )

        const indexed = indexSections([...newlyOpened, ...incoming], state.sendingTitles)

        for (const section of incoming) {
          acceptSection(section.id, request)
        }

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
    const request = ++sectionsRequest
    const { pendingClarifies, revision, snapshot } = await openSnapshot(id)
    const { context, messages } = snapshot
    const section = openedSection(snapshot.section, request)
    const live = section.live_session_id

    acceptSection(section.id, request)

    if (live) {
      boundSectionRequests.set(section.id, ++sectionsRequest)
    }

    set(state => ({
      ...mergeSection(state, section),
      liveSessionId: live ? { ...state.liveSessionId, [id]: live } : state.liveSessionId
    }))

    if (live) {
      const transcripts = useTranscripts.getState()
      transcripts.open(
        live,
        id,
        messagesFromHistory(messages ?? []).filter(
          // Hexbot replays an interrupted hidden kickoff as a plain user turn.
          message => !(message.role === 'user' && message.text.includes(KICKOFF_MARKER))
        ),
        revision,
        section.bot
      )

      if (context) {
        useTranscripts.getState().sessionContext(live, context)
      }

      for (const pending of pendingClarifies) {
        useTranscripts.getState().clarifyRequest(live, pending, {
          notify: false
        })
      }
    }

    return { liveSessionId: live, section }
  },

  async openThread(id, peer) {
    const request = ++sectionsRequest
    const { pendingClarifies, revision, snapshot } = await openSnapshot(id)
    const { messages } = snapshot
    const section = openedSection(snapshot.section, request)
    const live = section.live_session_id

    acceptSection(section.id, request)

    if (live) {
      boundSectionRequests.set(section.id, ++sectionsRequest)
    }

    if (live) {
      set(state => ({ liveSessionId: { ...state.liveSessionId, [id]: live } }))
      useTranscripts.getState().clearAnsweredWaiting([], [live], revision)
      useTranscripts.getState().setSectionId(live, id, section.bot)

      // The owner answers the receiving bot's questions here: threads have no other view.
      for (const pending of pendingClarifies) {
        useTranscripts.getState().clarifyRequest(live, pending, {
          notify: false
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

    sectionChanged(section.id)
    set(state => ({
      ...mergeSection(state, section),
      liveSessionId: section.live_session_id
        ? { ...state.liveSessionId, [section.id]: section.live_session_id }
        : state.liveSessionId
    }))

    return section
  },

  async rename(id, title) {
    const request = ++sectionsRequest
    const { section } = await sectionsRename(id, title)

    if (removedAfter(id, request)) {
      return
    }

    sectionChanged(section.id)
    set(state => mergeEditedSection(state, section, true))
  },

  async archive(id) {
    const request = ++sectionsRequest
    const { section } = await sectionsArchive(id)

    if (removedAfter(id, request)) {
      return
    }

    sectionChanged(section.id)
    set(state => mergeEditedSection(state, section))
  },

  async unarchive(id) {
    const request = ++sectionsRequest
    const { section } = await sectionsUnarchive(id)

    if (removedAfter(id, request)) {
      return
    }

    sectionChanged(section.id)
    set(state => mergeEditedSection(state, section))
  },

  async remove(id, purgeMemory = true) {
    const request = ++sectionsRequest

    const bot =
      get().byId[id]?.bot ??
      Object.values(useTranscripts.getState().bySession).find(
        transcript => transcript.sectionId === id
      )?.bot

    await sectionsDelete(id, purgeMemory)

    // The daemon can broadcast the deletion before this RPC's reply arrives.
    if (!removedAfter(id, request)) {
      get().drop(id, bot)
    }
  },

  drop(id, bot) {
    const previous = removedSectionRequests.get(id)

    const owner =
      bot ??
      get().byId[id]?.bot ??
      Object.values(useTranscripts.getState().bySession).find(
        transcript => transcript.sectionId === id
      )?.bot ??
      (previous?.active ? previous.bot : undefined)

    const request = ++sectionsRequest
    removedSectionRequests.set(id, { active: true, bot: owner, request })
    sectionRequests.set(id, request)

    draftsActions().clear(id)

    const live = get().liveSessionId[id]
    const transcripts = useTranscripts.getState()

    for (const transcript of Object.values(transcripts.bySession)) {
      if (transcript.sectionId === id || transcript.sessionId === live) {
        transcripts.drop(transcript.sessionId)
      }
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
    clearDeletedSections()
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
  BotStatus | 'answered' | { status: 'idle' | 'needs_you' | 'working'; retryResolved?: string }
>

function confirmedWaiting(transcript: Partial<Parameters<typeof liveSectionsOf>[0][string]>) {
  return Boolean(
    transcript.waitingRequests?.some(request =>
      request.kind === 'approval'
        ? transcript.approvals?.some(item => item.requestId === request.requestId && !item.decision)
        : transcript.clarifies?.some(
            item => item.requestId === request.requestId && clarifyWaiting(item)
          )
    )
  )
}

/** What each open transcript says about its section: a card waiting on you, a reply streaming, or neither. */
export function liveSectionsOf(
  bySession: Record<
    string,
    {
      bot?: string
      answeredWaiting?: { kind: 'approval' | 'clarify'; requestId: string }
      waitingRequests?: { kind: 'approval' | 'clarify'; requestId: string }[]
      retryResolved?: boolean
      roomTurnRunning?: boolean
      liveStatus?: 'idle' | 'needs_you' | 'working'
      approvals: { decision?: unknown; requestId?: string }[]
      clarifies: ClarifyRequest[]
      sectionId?: string
      sessionId?: string
      streamingMessageId: null | string
    }
  >
): LiveSections {
  const live: LiveSections = {}

  for (const transcript of Object.values(bySession)) {
    if (!transcript.sectionId) {
      continue
    }

    const asking = confirmedWaiting(transcript)

    const answered = transcript.answeredWaiting

    const hasAnswer =
      answered?.kind === 'approval'
        ? transcript.approvals.some(item => item.requestId === answered.requestId && item.decision)
        : answered?.kind === 'clarify' &&
          transcript.clarifies.some(
            item => item.requestId === answered.requestId && !item.expired && clarifyAnswered(item)
          )

    live[transcript.sectionId] =
      asking || transcript.liveStatus || transcript.retryResolved
        ? {
            status: asking
              ? 'needs_you'
              : (transcript.liveStatus ??
                (hasAnswer || transcript.streamingMessageId ? 'working' : 'idle')),
            ...(transcript.retryResolved ? { retryResolved: transcript.sessionId } : {})
          }
        : hasAnswer
          ? 'answered'
          : transcript.streamingMessageId
            ? 'working'
            : 'idle'
  }

  return live
}

function deletedRetry(bot: Bot | undefined): boolean {
  const detail = bot?.status_detail
  const removed = detail?.section_id ? removedSectionRequests.get(detail.section_id) : undefined

  return Boolean(
    bot?.status === 'stopped' &&
    detail?.action?.kind === 'retry' &&
    !detail.room_id &&
    removed?.active &&
    (!removed.bot || removed.bot === bot.name)
  )
}

/** The daemon's word on a bot; a record without the field is idle. */
export function botStatus(bot: Bot | undefined): BotStatus {
  return deletedRetry(bot) ? 'idle' : (bot?.status ?? 'idle')
}

function resolvedRetry(
  bot: Bot | undefined,
  sectionId: string | null,
  own: LiveSections[string] | undefined
) {
  const detail = bot?.status_detail

  return Boolean(
    sectionId &&
    detail?.section_id === sectionId &&
    !detail.room_id &&
    detail.action?.kind === 'retry' &&
    typeof own === 'object' &&
    own.retryResolved &&
    (!detail.session_id || detail.session_id === own.retryResolved)
  )
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
  if (deletedRetry(bot) && sectionId === bot?.status_detail?.section_id) {
    return 'idle'
  }

  const status = botStatus(bot)
  const own = sectionId ? live[sectionId] : undefined
  const fresh = typeof own === 'object' ? own.status : undefined

  if (status !== 'idle' && sectionId && bot?.status_detail?.section_id === sectionId) {
    return status === 'stopped' && !resolvedRetry(bot, sectionId, own)
      ? status
      : (fresh ?? (status === 'needs_you' && own === 'answered' ? 'working' : status))
  }

  return typeof own === 'object' ? own.status : own === 'answered' ? 'working' : (own ?? 'idle')
}

function freshSessionStatus(
  session: Partial<Parameters<typeof liveSectionsOf>[0][string]> | undefined
): BotStatus | undefined {
  if (!session?.sectionId) {
    return undefined
  }

  const fresh = liveSectionsOf({
    own: {
      ...session,
      approvals: session.approvals ?? [],
      clarifies: session.clarifies ?? [],
      streamingMessageId: null
    }
  })[session.sectionId]

  return fresh === 'answered' ? 'working' : typeof fresh === 'object' ? fresh.status : undefined
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

  if (
    status === 'stopped' &&
    !archivedRetry &&
    !resolvedRetry(bot, detail?.section_id ?? null, live[detail?.section_id ?? ''])
  ) {
    return status
  }

  const own = sections
    .filter(section => !section.archived_at)
    .map(section => sectionStatusOf(bot, section.id, live))

  const named = bot.status_detail?.section_id
  const rooms = useRooms.getState()
  const archivedRoom = detail?.room_id && rooms.byId[detail.room_id]?.archived_at

  // Rooms and private threads are absent from the section index but still count.
  if (
    !archivedRoom &&
    !deletedRetry(bot) &&
    (!named || !sections.some(section => section.id === named))
  ) {
    const session = detail?.session_id ? sessions[detail.session_id] : undefined

    const ownsSession =
      session &&
      (detail?.room_id
        ? session.sectionId === `room:${detail.room_id}`
        : named && session.sectionId === named)

    const fresh = ownsSession ? freshSessionStatus(session) : undefined

    own.push(fresh ?? (named ? sectionStatusOf(bot, named, live) : status))
  }

  const indexed = useSections.getState()

  for (const [sessionId, session] of Object.entries(sessions)) {
    const id = session.sectionId

    if (session.bot !== bot.name || !id || sections.some(section => section.id === id)) {
      continue
    }

    const row = indexed.byId[id]
    const removed = removedSectionRequests.get(id)

    if (
      row?.archived_at ||
      (row && row.bot !== bot.name) ||
      (removed?.active && (!removed.bot || removed.bot === bot.name))
    ) {
      continue
    }

    const roomId = id.startsWith('room:') ? id.slice('room:'.length) : undefined

    if (roomId && rooms.byId[roomId]?.archived_at) {
      continue
    }

    const current = roomId
      ? rooms.liveTurnsByRoom[roomId]?.[bot.name]?.live_session_id
      : indexed.liveSessionId[id]

    // A running turn certifies activity, not settlement of a human request.
    const running =
      roomId &&
      session.roomTurnRunning &&
      rooms.liveTurnsByRoom[roomId]?.[bot.name]?.status === 'running'

    const fresh = freshSessionStatus(session) ?? (running ? 'working' : undefined)

    // An unopened thread's trusted card ownership survives its answer and
    // fresh progress, until a roster or lifecycle update retires that evidence.
    if (
      fresh &&
      (current === sessionId ||
        (!roomId && !current && (fresh === 'needs_you' || fresh === 'working')))
    ) {
      own.push(fresh)
    }
  }

  return own.includes('needs_you') ? 'needs_you' : own.includes('working') ? 'working' : 'idle'
}
