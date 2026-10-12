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

import { useConnection } from './connection'
import { draftsActions } from './drafts'
import { clearDeletedRooms, completedRoomRetry, useRooms } from './rooms'
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
  /** A daemon start can bind an active private section without opening it. */
  bindTurn: (sessionId: string, id: string, bot: string) => boolean
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
  /** Confirm an unlisted session against real private section metadata, without opening it. */
  verifySessionOwner: (sessionId: string, refresh?: boolean) => Promise<void>
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

function withoutSection(state: SectionsState, id: string): Partial<SectionsState> {
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
type MetadataField = 'archive' | 'title'
const sectionMetadataRequests = new Map<string, Record<MetadataField, number>>()
// Opens bind a fresh runtime with earlier metadata; exact lookups also observe its lifecycle.
const boundSectionRequests = new Map<string, { request: number; lifecycle: number }>()
const removedSectionRequests = new Map<string, { active: boolean; bot?: string; request: number }>()

const pendingSectionReads = new Set<{
  bot?: string
  request: number
  snapshot: Promise<Section[]>
}>()

/** A bot read can race the metadata read triggered by the same archive notification. */
export function pendingSectionSnapshots(bot: string): Promise<Section[]>[] {
  const reads = [...pendingSectionReads].filter(
    read =>
      (!read.bot || read.bot === bot) &&
      fullSectionsRequest < read.request &&
      (botSectionsRequests.get(bot) ?? 0) < read.request
  )

  if (!reads.length) {
    return []
  }

  const acceptedSections = new Map(sectionRequests)
  const observedLifecycle = new Map(boundSectionRequests)

  return [
    Promise.all(reads.map(read => read.snapshot)).then(snapshots =>
      reads.flatMap((read, index) =>
        fullSectionsRequest <= read.request && (botSectionsRequests.get(bot) ?? 0) <= read.request
          ? snapshots[index]!.filter(
              section =>
                section.bot === bot &&
                (acceptedSections.get(section.id) ?? 0) <= read.request &&
                (observedLifecycle.get(section.id)?.lifecycle ?? 0) <= read.request
            )
          : []
      )
    )
  ]
}

export function clearDeletedSections(): void {
  clearDeletedRooms()

  // A new daemon must not inherit status proof, but old promises stay fenced.
  for (const removed of removedSectionRequests.values()) {
    removed.active = false
  }
}

function removedAfter(id: string, request: number): boolean {
  return (removedSectionRequests.get(id)?.request ?? 0) > request
}

function acceptMetadata(id: string, request: number, field?: MetadataField): void {
  const current = sectionMetadataRequests.get(id) ?? { archive: 0, title: 0 }

  sectionMetadataRequests.set(id, {
    archive: field === 'title' ? current.archive : Math.max(current.archive, request),
    title: field === 'archive' ? current.title : Math.max(current.title, request)
  })
}

function acceptSection(id: string, request: number, metadata = true): void {
  sectionRequests.set(id, Math.max(sectionRequests.get(id) ?? 0, request))

  if (metadata) {
    acceptMetadata(id, request)
  }

  const removed = removedSectionRequests.get(id)

  if (removed && removed.request < request) {
    // A newer row retires status proof, while pre-delete requests stay fenced.
    removed.active = false
  }
}

function acceptBinding(id: string, request: number, lifecycle = false): void {
  boundSectionRequests.set(id, {
    request,
    lifecycle: lifecycle ? request : (boundSectionRequests.get(id)?.lifecycle ?? 0)
  })
}

function openedSection(section: Section, request: number): Section {
  if (removedAfter(section.id, request)) {
    throw new Error('This section was deleted.')
  }

  const current = useSections.getState().byId[section.id]

  return current && (sectionRequests.get(section.id) ?? 0) > request
    ? { ...section, ...sectionMetadata(current) }
    : current && (boundSectionRequests.get(section.id)?.lifecycle ?? 0) > request
      ? { ...section, archived_at: current.archived_at }
      : section
}

function sectionBinding(
  state: SectionsState,
  section: Section,
  includeIndexed = false,
  request = Infinity
): Partial<SectionsState> {
  if (!includeIndexed && !isThread(section)) {
    return {}
  }

  const liveSessionId = { ...state.liveSessionId }
  const current = state.byId[section.id]

  const live =
    (boundSectionRequests.get(section.id)?.request ?? 0) > request
      ? (liveSessionId[section.id] ?? current?.live_session_id)
      : section.live_session_id

  delete liveSessionId[section.id]

  if (!section.archived_at && live) {
    liveSessionId[section.id] = live
  }

  return {
    liveSessionId,
    ...(current || (isThread(section) && section.archived_at)
      ? {
          byId: {
            ...state.byId,
            [section.id]: {
              ...(current ?? section),
              archived_at: section.archived_at,
              updated_at: section.updated_at,
              live_session_id: live ?? null
            }
          }
        }
      : {})
  }
}

/** A successful edit protects this row without discarding siblings from an in-flight list. */
function sectionChanged(id: string, request?: number, field?: MetadataField): void {
  const completed = ++sectionsRequest
  acceptSection(id, completed, false)
  acceptMetadata(id, request ?? completed, field)
}

export const useSections = create<SectionsState>((set, get) => ({
  byId: {},
  error: null,
  idsByBot: {},
  liveSessionId: {},
  loading: false,
  sendingTitles: {},

  bindTurn(sessionId, id, bot) {
    const section = get().byId[id]
    const bound = get().liveSessionId[id]
    const transcript = useTranscripts.getState().bySession[sessionId]

    if (
      !sessionId ||
      !id ||
      !bot ||
      id.startsWith('room:') ||
      removedSectionRequests.get(id)?.active ||
      section?.archived_at ||
      (section && section.bot !== bot) ||
      (bound && bound !== sessionId) ||
      (!bound && section?.live_session_id && section.live_session_id !== sessionId) ||
      (transcript?.sectionId && transcript.sectionId !== id) ||
      (transcript?.bot && transcript.bot !== bot)
    ) {
      return false
    }

    acceptBinding(id, ++sectionsRequest)
    set(state => ({ liveSessionId: { ...state.liveSessionId, [id]: sessionId } }))
    useTranscripts.getState().setSectionId(sessionId, id, bot)
    useTranscripts.getState().bindPrivateSession(id, sessionId)

    return true
  },

  async verifySessionOwner(sessionId, refresh = false) {
    const transcript = useTranscripts.getState().bySession[sessionId]
    const id = transcript?.sectionId
    const bot = transcript?.bot

    if (
      !id ||
      !bot ||
      id.startsWith('room:') ||
      (!refresh && get().liveSessionId[id] === sessionId)
    ) {
      return
    }

    const boundAtRead = get().liveSessionId[id]
    const revision = transcriptRevision()
    const request = ++sectionsRequest
    const connection = useConnection.getState()

    try {
      const result = await sectionsList({ bot, include_archived: true, include_threads: true })

      if (
        !Array.isArray(result.sections) ||
        result.sections.some(
          row => !row || typeof row.id !== 'string' || typeof row.bot !== 'string'
        )
      ) {
        return
      }

      const section = result.sections.find(row => row.id === id && row.bot === bot)
      const current = useTranscripts.getState().bySession[sessionId]
      const target = useConnection.getState()
      const bound = get().liveSessionId[id]

      if (
        current?.epoch !== transcript.epoch ||
        current.sectionId !== id ||
        current.bot !== bot ||
        target.target !== connection.target ||
        target.epoch !== connection.epoch ||
        removedSectionRequests.get(id)?.active ||
        (sectionMetadataRequests.get(id)?.archive ?? 0) > request ||
        (boundSectionRequests.get(id)?.request ?? 0) > request ||
        (bound && bound !== sessionId && bound !== boundAtRead) ||
        (get().byId[id] && get().byId[id]?.bot !== bot)
      ) {
        return
      }

      // Ownership reads can hide archived activity without superseding pending edits.
      acceptBinding(id, request, Boolean(section))

      if (!section) {
        // Absence can retire known private ownership, not an unclassified room card.
        if (
          (!boundAtRead && !get().byId[id]) ||
          result.sections.some(row => row.id === id) ||
          (sectionRequests.get(id) ?? 0) > request ||
          Object.values(useTranscripts.getState().bySession).some(
            item => item.sectionId === id && item.authorityRevision > revision
          )
        ) {
          return
        }

        removedSectionRequests.set(id, { active: true, bot, request })
        sectionRequests.set(id, request)
        useTranscripts.getState().clearAnsweredWaiting([id], [], revision, { idle: true })
        set(state => withoutSection(state, id))

        return
      }

      set(state => {
        const liveSessionId = { ...state.liveSessionId }

        delete liveSessionId[id]

        if (!section.archived_at && section.live_session_id) {
          liveSessionId[id] = section.live_session_id
        }

        return {
          liveSessionId,
          ...(state.byId[id] || section.archived_at
            ? {
                byId: {
                  ...state.byId,
                  [id]: {
                    ...(state.byId[id] ?? section),
                    archived_at: section.archived_at,
                    live_session_id: section.live_session_id,
                    message_count: section.message_count || state.byId[id]?.message_count || 0,
                    preview: section.preview || state.byId[id]?.preview || ''
                  }
                }
              }
            : {})
        }
      })

      if (section.live_session_id) {
        useTranscripts.getState().bindPrivateSession(id, section.live_session_id, revision)
      }

      if (!section.archived_at && !section.live_session_id) {
        // A closed runtime retires old activity, while cards remain readable.
        useTranscripts.getState().clearAnsweredWaiting([id], [], revision, { idle: true })
      }
    } catch {
      // Failed metadata cannot establish ownership or retire a pending card.
    }
  },

  async refresh(options = {}) {
    const request = ++sectionsRequest
    const revision = transcriptRevision()
    latestSectionsRefresh = request
    const bot = options.bot
    const reading = sectionsList({ include_archived: true, ...options })

    const read = {
      bot,
      request,
      snapshot: reading.then(
        result => result.sections ?? [],
        () => []
      )
    }

    pendingSectionReads.add(read)

    set({ error: null, loading: true })

    try {
      const result = await reading

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

      const adoptedSessions: { id: string; live: string }[] = []

      set(state => {
        // A full reply can still update other bots after a newer scoped reply.
        const preserve = (name: string) =>
          bot ? name !== bot : (botSectionsRequests.get(name) ?? 0) > request

        const openedAfter = (id: string) => (sectionRequests.get(id) ?? 0) > request
        const boundAfter = (id: string) => (boundSectionRequests.get(id)?.request ?? 0) > request

        const preserveArchive = (id: string) =>
          boundAfter(id) &&
          (state.liveSessionId[id]
            ? (boundSectionRequests.get(id)?.lifecycle ?? 0) > request
            : Boolean(state.byId[id]))

        const incoming = (result.sections ?? [])
          .filter(section => !preserve(section.bot) && !removedAfter(section.id, request))
          .map(section => {
            const opened = state.byId[section.id]
            const boundLive = state.liveSessionId[section.id]

            const current =
              openedAfter(section.id) && opened
                ? { ...opened, preview: section.preview || opened.preview }
                : section

            // Older inventory must also preserve a verified closed or archived runtime.
            return boundAfter(section.id) && (boundLive || opened)
              ? {
                  ...current,
                  archived_at: preserveArchive(section.id)
                    ? (opened?.archived_at ?? null)
                    : current.archived_at,
                  live_session_id: boundLive ?? opened?.live_session_id ?? null,
                  message_count: boundLive
                    ? (opened?.message_count ?? current.message_count)
                    : current.message_count
                }
              : current
          })

        const newlyOpened = Object.values(state.byId).filter(
          section =>
            !preserve(section.bot) &&
            (openedAfter(section.id) || boundAfter(section.id)) &&
            !incoming.some(item => item.id === section.id)
        )

        const indexed = indexSections([...newlyOpened, ...incoming], state.sendingTitles)

        for (const section of incoming) {
          if (section.live_session_id && !boundAfter(section.id)) {
            adoptedSessions.push({ id: section.id, live: section.live_session_id })
          }

          // Advance each editable field only if this reply installed it.
          const metadata = !openedAfter(section.id) || !state.byId[section.id]
          acceptSection(section.id, request, false)

          if (metadata) {
            acceptMetadata(section.id, request, preserveArchive(section.id) ? 'title' : undefined)
          }
        }

        return {
          byId: {
            ...Object.fromEntries(
              Object.entries(state.byId).filter(
                ([, section]) => preserve(section.bot) || isThread(section)
              )
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
                .filter(section => section.live_session_id && !boundAfter(section.id))
                .map(section => [section.id, section.live_session_id as string])
            )
          }
        }
      })

      for (const { id, live } of adoptedSessions) {
        useTranscripts.getState().bindPrivateSession(id, live, revision)
      }
    } catch (error) {
      if (request === latestSectionsRefresh) {
        set({ error: error instanceof Error ? error.message : String(error) })
      }
    } finally {
      pendingSectionReads.delete(read)

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

    // Open metadata is captured before the daemon awaits its fresh runtime binding.
    acceptSection(section.id, request, false)

    if (live) {
      acceptBinding(section.id, ++sectionsRequest)
    }

    set(state => ({
      ...mergeSection(state, section),
      liveSessionId: live ? { ...state.liveSessionId, [id]: live } : state.liveSessionId
    }))

    if (live) {
      const transcripts = useTranscripts.getState()
      transcripts.bindPrivateSession(id, live, revision)
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

    acceptSection(section.id, request, false)

    if (live) {
      acceptBinding(section.id, ++sectionsRequest)
    }

    if (live) {
      useTranscripts.getState().clearAnsweredWaiting([], [live], revision)
      useTranscripts.getState().setSectionId(live, id, section.bot)
      set(state => sectionBinding(state, section, true))
      useTranscripts.getState().bindPrivateSession(id, live, revision)

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

    if (removedAfter(id, request) || (sectionMetadataRequests.get(id)?.title ?? 0) > request) {
      return
    }

    sectionChanged(section.id, request, 'title')
    set(state => mergeEditedSection(state, section, true))
  },

  async archive(id) {
    const request = ++sectionsRequest
    const { section } = await sectionsArchive(id)

    if (removedAfter(id, request) || (sectionMetadataRequests.get(id)?.archive ?? 0) > request) {
      return
    }

    sectionChanged(section.id, request, 'archive')
    set(state => ({
      ...mergeEditedSection(state, section),
      ...sectionBinding(state, section, false, request)
    }))
    acceptBinding(id, sectionsRequest, true)
  },

  async unarchive(id) {
    const request = ++sectionsRequest
    const revision = transcriptRevision()
    const connection = useConnection.getState()
    const { section } = await sectionsUnarchive(id)

    const target = useConnection.getState()

    if (
      removedAfter(id, request) ||
      (sectionMetadataRequests.get(id)?.archive ?? 0) > request ||
      target.target !== connection.target ||
      target.epoch !== connection.epoch
    ) {
      return
    }

    sectionChanged(section.id, request, 'archive')
    set(state => ({
      ...mergeEditedSection(state, section),
      ...sectionBinding(state, section, true, request)
    }))

    if (
      !section.archived_at &&
      !section.live_session_id &&
      (boundSectionRequests.get(id)?.request ?? 0) <= request
    ) {
      useTranscripts.getState().clearAnsweredWaiting([id], [], revision, { idle: true })
    }

    const current = get().liveSessionId[id] ?? get().byId[id]?.live_session_id

    if (current) {
      useTranscripts.getState().bindPrivateSession(id, current, revision)
    }

    acceptBinding(id, sectionsRequest, true)
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

    set(state => withoutSection(state, id))
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
      superseded?: boolean
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
    if (!transcript.sectionId || transcript.superseded) {
      continue
    }

    const indexed = useSections.getState()
    const current = indexed.liveSessionId[transcript.sectionId]

    if (indexed.byId[transcript.sectionId]?.archived_at && !current) {
      continue
    }

    if (
      current &&
      transcript.sessionId &&
      !transcript.sectionId.startsWith('room:') &&
      current !== transcript.sessionId
    ) {
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

function deletedSectionStatus(bot: Bot | undefined): boolean {
  const detail = bot?.status_detail
  const removed = detail?.section_id ? removedSectionRequests.get(detail.section_id) : undefined

  return Boolean(
    (bot?.status === 'working' ||
      bot?.status === 'needs_you' ||
      (bot?.status === 'stopped' && detail?.action?.kind === 'retry')) &&
    !detail?.room_id &&
    removed?.active &&
    (!removed.bot || removed.bot === bot.name)
  )
}

/** The daemon's word on a bot; a record without the field is idle. */
export function botStatus(bot: Bot | undefined): BotStatus {
  return deletedSectionStatus(bot) ? 'idle' : (bot?.status ?? 'idle')
}

function resolvedRetry(
  bot: Bot | undefined,
  sectionId: string | null,
  own: LiveSections[string] | undefined
) {
  const detail = bot?.status_detail
  const indexed = useSections.getState()

  return Boolean(
    sectionId &&
    detail?.section_id === sectionId &&
    !detail.room_id &&
    detail.action?.kind === 'retry' &&
    typeof own === 'object' &&
    own.retryResolved &&
    (!indexed.liveSessionId[sectionId] || indexed.liveSessionId[sectionId] === own.retryResolved) &&
    (!indexed.byId[sectionId] || indexed.byId[sectionId]?.bot === bot?.name) &&
    (!detail.session_id ||
      detail.session_id === own.retryResolved ||
      (indexed.byId[sectionId]?.bot === bot?.name &&
        indexed.liveSessionId[sectionId] === own.retryResolved))
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
  if (deletedSectionStatus(bot) && sectionId === bot?.status_detail?.section_id) {
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
  session: Partial<Parameters<typeof liveSectionsOf>[0][string]> | undefined,
  running = false
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

  if (
    running &&
    session.retryResolved &&
    session.liveStatus !== 'idle' &&
    typeof fresh === 'object' &&
    fresh.status === 'idle'
  ) {
    return 'working'
  }

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
  const rooms = useRooms.getState()
  const indexed = useSections.getState()

  // Native turn failures can omit room_id; only an exact current room session
  // identifies that stored-session cause without guessing from its section id.
  const completed = detail?.session_id ? sessions[detail.session_id] : undefined

  const completedRoom = completed?.sectionId?.startsWith('room:')
    ? completed.sectionId.slice('room:'.length)
    : undefined

  const roomId =
    detail?.room_id ??
    (detail?.action?.kind === 'retry' &&
    detail.section_id &&
    detail.session_id &&
    !indexed.byId[detail.section_id]
      ? (Object.entries(rooms.liveTurnsByRoom).find(
          ([, turns]) => turns[bot.name]?.live_session_id === detail.session_id
        )?.[0] ??
        (completedRoom &&
        rooms.byId[completedRoom] &&
        completedRoomRetry(completed, completedRoom, bot.name)
          ? completedRoom
          : undefined))
      : undefined)

  const archivedRoom = roomId && rooms.byId[roomId]?.archived_at
  const roomTurn = roomId ? rooms.liveTurnsByRoom[roomId]?.[bot.name] : undefined

  const completedRoomSession =
    roomId && !roomTurn && rooms.byId[roomId]
      ? Object.entries(sessions).find(
          ([id, session]) =>
            session.sessionId === id && completedRoomRetry(session, roomId, bot.name)
        )?.[1]
      : undefined

  const roomSession = roomTurn?.live_session_id
    ? sessions[roomTurn.live_session_id]
    : completedRoomSession

  // A room's stored session id is not its virtual section key. The current turn
  // certifies this bot's retry, including a new live id after the daemon restarts.
  const roomRetry = Boolean(
    roomId &&
    detail?.action?.kind === 'retry' &&
    detail.section_id &&
    !indexed.byId[detail.section_id] &&
    !archivedRoom &&
    roomSession?.bot === bot.name &&
    roomSession.sectionId === `room:${roomId}` &&
    roomSession.retryResolved &&
    (completedRoomSession ||
      (roomTurn?.bot === bot.name &&
        roomTurn.room_id === roomId &&
        roomTurn.status === 'running' &&
        roomTurn.live_session_id &&
        (!roomSession.sessionId || roomSession.sessionId === roomTurn.live_session_id)))
  )

  const archivedRetry =
    detail?.action?.kind === 'retry' &&
    !detail.room_id &&
    sections.some(section => section.id === detail.section_id && section.archived_at)

  if (
    status === 'stopped' &&
    !archivedRetry &&
    !roomRetry &&
    !resolvedRetry(bot, detail?.section_id ?? null, live[detail?.section_id ?? ''])
  ) {
    return status
  }

  const own = sections
    .filter(section => !section.archived_at)
    .map(section => {
      if (status === 'needs_you' && detail?.section_id === section.id && detail.session_id) {
        const session = sessions[detail.session_id]

        return session?.sectionId === section.id ? (freshSessionStatus(session) ?? status) : status
      }

      return sectionStatusOf(bot, section.id, live)
    })

  const named = bot.status_detail?.section_id

  // Rooms and private threads are absent from the section index but still count.
  if (
    !archivedRoom &&
    !deletedSectionStatus(bot) &&
    (!named || !sections.some(section => section.id === named))
  ) {
    const session = roomRetry
      ? roomSession
      : detail?.session_id
        ? sessions[detail.session_id]
        : undefined

    const ownsSession =
      session &&
      (roomId ? session.sectionId === `room:${roomId}` : named && session.sectionId === named)

    const fresh = ownsSession
      ? freshSessionStatus(session, Boolean(roomRetry && roomTurn && session.roomTurnRunning))
      : undefined

    own.push(
      fresh ?? (detail?.session_id ? status : named ? sectionStatusOf(bot, named, live) : status)
    )
  }

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

    const fresh = freshSessionStatus(session, Boolean(running)) ?? (running ? 'working' : undefined)

    // Only a current room turn or verified private section owns this activity.
    if (fresh && current === sessionId) {
      own.push(fresh)
    }
  }

  return own.includes('needs_you') ? 'needs_you' : own.includes('working') ? 'working' : 'idle'
}
