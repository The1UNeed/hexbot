/**
 * Sections (= conversations = threads), keyed by id and grouped per bot.
 * Refreshed on `hexbot.sections.changed`. `liveSessionId` maps an open
 * section to the Hexbot live session its events arrive on.
 */

import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'

import {
  botsIntroduce,
  daemonInfo,
  messagesFromHistory,
  sectionsCreate,
  sectionsList,
  sectionsOpen,
  sectionsUnarchive
} from '../lib/api'
import { KICKOFF_MARKER } from '../lib/bot-kickoff'
import type { Bot, BotStatus, Message, Section } from '../lib/types'

import { useConnection } from './connection'
import { useTranscripts } from './transcripts'

/**
 * A thread: the private conversation in which `peer_bot` asks `bot` for help.
 * The daemon leaves threads out of its lists; this guards every other path a
 * section can arrive by (a bot's recent sections, a changed event, an open).
 */
export const isThread = (section: Pick<Section, 'peer_bot'>) => Boolean(section.peer_bot)

/**
 * A bot's chat on a daemon from before one chat per bot, which keeps many
 * sections and makes another on every create. Its update keeps the one with
 * the latest conversation, giving way only for report-only logs, which its
 * list cannot tell apart, renamed or not. So the chat is certain only while at
 * most one section has something said; otherwise those are the choices,
 * open ones first, newest first. Null for a bot with none: create makes it.
 * Never a thread.
 */
export function legacyChat(
  sections: Section[],
  bot: string
): { choices: Section[] } | { section: Section } | null {
  const chats = sections
    .filter(section => section.bot === bot && !isThread(section))
    .sort(
      (a, b) =>
        Number(Boolean(a.archived_at)) - Number(Boolean(b.archived_at)) ||
        (b.updated_at ?? 0) - (a.updated_at ?? 0)
    )

  const said = chats.filter(section => section.message_count > 0)

  if (said.length > 1) {
    return { choices: said }
  }

  const section = said[0] ?? chats[0]

  return section ? { section } : null
}

/** An older daemon's sections the user picks a bot's chat from, while asked. */
export interface ChatChoice {
  bot: string
  choices: Section[]
  /** Whether this lookup still belongs to the current navigation and daemon. */
  current: () => boolean
  /** The section picked, or null when the user picks none. */
  pick: (section: null | Section) => void
}

export interface SectionsState {
  byId: Record<string, Section>
  /**
   * A bot's one chat with you, made on first use. On an older daemon the
   * user may be asked to pick it; null when they pick none.
   */
  chat: (bot: string, current?: () => boolean) => Promise<null | Section>
  /** The choice `chat` is waiting on, if any. */
  choosing: ChatChoice | null
  /** Live ids are process-scoped; a new daemon epoch invalidates them all. */
  clearLive: () => void
  /** The daemon closed this section's live session; an open view reads it again. */
  forgetLive: (id: string) => void
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
  /** Titles from first messages still on their way to the daemon, by section id. */
  sendingTitles: Record<string, string>
  /** The first message reached the daemon, or failed: take the daemon's title again. */
  settleTitle: (id: string) => Promise<void>
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

/** Reloads asked for by section, so an open already under way reads it again. */
const reloads = new Map<string, number>()
/** Share history reads so a slower concurrent snapshot cannot replace a newer one. */
const opening = new Map<string, ReturnType<SectionsState['open']>>()

/** Each bot's chat on an older daemon, remembered for the current connection. */
const picked = new Map<string, string>()
let chatGeneration = 0

/** Whether the daemon names each bot's one chat; one from before keeps many sections per bot. */
export async function oneChat(): Promise<boolean> {
  return Boolean((useConnection.getState().daemon ?? (await daemonInfo())).one_chat)
}

/**
 * A bot's chat on a daemon from before one chat per bot: the one its list
 * makes certain, else the one the user picks, brought back if archived. Made
 * only for a bot with none, since create there makes another every time.
 */
async function olderChat(
  bot: string,
  ask: (choices: Section[]) => Promise<null | Section>,
  current: () => boolean
): Promise<null | Section> {
  const found = legacyChat(
    (await sectionsList({ bot, include_archived: true })).sections ?? [],
    bot
  )

  if (!current()) {
    return null
  }

  if (!found) {
    return (await sectionsCreate(bot)).section
  }

  const section =
    'section' in found
      ? found.section
      : (found.choices.find(choice => choice.id === picked.get(bot)) ?? (await ask(found.choices)))

  if (!section || !current()) {
    return null
  }

  // Older daemons update recency even for an open section. Persist the pick
  // before remembering it, so an upgrade keeps it without another message.
  const opened = (await sectionsUnarchive(section.id)).section

  if (!current()) {
    return null
  }

  picked.set(bot, section.id)

  return opened
}

export const useSections = create<SectionsState>((set, get) => ({
  byId: {},
  choosing: null,
  error: null,
  idsByBot: {},
  liveSessionId: {},
  loading: false,
  sendingTitles: {},

  async refresh(options = {}) {
    set({ error: null, loading: true })

    try {
      const result = await sectionsList({ include_archived: true, ...options })

      set(state => ({
        ...indexSections(result.sections ?? [], state.sendingTitles),
        loading: false
      }))
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error), loading: false })
    }
  },

  open(id) {
    const pending = opening.get(id)

    if (pending) {
      return pending
    }

    const { target, epoch } = useConnection.getState()

    const current = () =>
      target === useConnection.getState().target && epoch === useConnection.getState().epoch

    const read = async (): ReturnType<SectionsState['open']> => {
      const asked = reloads.get(id) ?? 0
      let result

      try {
        result = await sectionsOpen(id)
      } catch (error) {
        // A report can supersede a failed read as well as a successful snapshot.
        if (current() && (reloads.get(id) ?? 0) !== asked) {
          return read()
        }

        throw error
      }

      if (!current()) {
        throw new Error('The selected daemon changed. Open this chat again.')
      }

      if ((reloads.get(id) ?? 0) !== asked) {
        return read()
      }

      const { context, messages, pending_clarify, section } = result
      const live = section.live_session_id

      if (live) {
        useTranscripts.getState().open(
          live,
          id,
          messagesFromHistory(messages ?? []).filter(
            message => !(message.role === 'user' && message.text.includes(KICKOFF_MARKER))
          )
        )

        if (context) {
          useTranscripts.getState().sessionContext(live, context)
        }

        if (pending_clarify) {
          useTranscripts.getState().clarifyRequest(live, pending_clarify, { notify: false })
        }
      }

      // Only a history read establishes a loaded chat. Catalog live IDs are
      // metadata; a list refresh or canonical lookup cannot restore its transcript.
      set(state => ({
        ...mergeSection(state, section),
        liveSessionId: live ? { ...state.liveSessionId, [id]: live } : state.liveSessionId
      }))

      return { liveSessionId: live, section }
    }

    const request = read().finally(() => {
      if (opening.get(id) === request) {
        opening.delete(id)
      }
    })

    opening.set(id, request)

    return request
  },

  async openThread(id, peer) {
    const { messages, pending_clarify, section } = await sectionsOpen(id)
    const live = section.live_session_id

    if (live) {
      set(state => ({ liveSessionId: { ...state.liveSessionId, [id]: live } }))

      // The owner answers the receiving bot's questions here: threads have no other view.
      if (pending_clarify) {
        useTranscripts.getState().clarifyRequest(live, pending_clarify, { notify: false })
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

  async chat(bot, active = () => true) {
    get().choosing?.pick(null)
    const generation = ++chatGeneration
    const { target, epoch } = useConnection.getState()

    const current = () =>
      generation === chatGeneration &&
      target === useConnection.getState().target &&
      epoch === useConnection.getState().epoch &&
      active()

    const ask = (choices: Section[]) =>
      new Promise<null | Section>(resolve => {
        get().choosing?.pick(null)
        set({
          choosing: {
            bot,
            choices,
            current,
            pick: choice => {
              if (get().choosing?.choices === choices) {
                set({ choosing: null })
              }

              resolve(current() ? choice : null)
            }
          }
        })
      })

    // The daemon names the chat, never one recovery set aside.
    const modern = await oneChat()

    if (!current()) {
      return null
    }

    const section = modern
      ? (await sectionsCreate(bot)).section
      : await olderChat(bot, ask, current)

    if (!section || !current()) {
      return null
    }

    set(state => mergeSection(state, section))

    return section
  },

  clearLive() {
    set({ liveSessionId: {} })
    useTranscripts.getState().dropAll()
  },

  forgetLive(id) {
    reloads.set(id, (reloads.get(id) ?? 0) + 1)
    const closed = get().liveSessionId[id] ?? get().byId[id]?.live_session_id

    if (!closed) {
      return
    }

    set(state => {
      const { [id]: _closed, ...liveSessionId } = state.liveSessionId

      return { liveSessionId }
    })
    useTranscripts.getState().drop(closed)
  }
}))

useConnection.subscribe((next, previous) => {
  const changed = next.target !== previous.target || next.epoch !== previous.epoch

  if (changed || (!next.daemon && previous.daemon)) {
    useSections.getState().choosing?.pick(null)
    chatGeneration++
    picked.clear()
  }

  if (changed) {
    opening.clear()

    if (next.target !== previous.target) {
      useSections.getState().clearLive()
    }
  }
})

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
