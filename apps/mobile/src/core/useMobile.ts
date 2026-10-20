import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState } from 'react-native'
import * as Crypto from 'expo-crypto'
import type { GatewayEvent } from '@hermes/shared'
import { MobileSession, type MobileConnectionState } from './session'
import {
  activeDaemonId,
  forgetDaemon,
  loadDaemons,
  loadToken,
  saveDaemon,
  selectDaemon
} from './storage'
import { pair } from './transport'
import { registerPush } from './push'
import { parsePairing, normalizeOrigin } from './links'
import {
  approvalResponse,
  clarifyResponse,
  checkinMessage,
  clearStatusProof,
  emptyChat,
  emptyTurn,
  historyMessages,
  reduceChat,
  restoreChat,
  rosterChat,
  settledBot
} from './chat'
import {
  acceptsRoomSession,
  completedRoomRetry,
  reduceRoom,
  restoreRoom,
  roomChat,
  roomMessage
} from './room-chat'
import { attachmentPrompt } from './chat-send'
import { modelLists, providerModels } from './models'
import { ROOMS_QUERY, SECTIONS_QUERY, defaultSection, rebind, type ChatRoute } from './routes'
import type {
  Bot,
  Section,
  Room,
  RoomEvent,
  CurrentUser,
  DaemonInfo,
  Settings,
  SavedDaemon,
  TurnState,
  ChatState,
  Rpc
} from './types'
export type { ChatRoute }
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))
/** A room opens at its latest events and pages back this many at a time. */
const ROOM_PAGE = 200
type BotReadContext = { sessionId: string; sectionId: string; revision: number; archive?: boolean }
type SubmittedTurn = {
  bot: Bot
  section?: Section
  roomId?: string
  sessionId: string
  revision: number
  cards: Map<string, number>
  /** An exact daemon start owns this activity until a later status read or turn end. */
  workingRevision?: number
  state: ChatState
  pending: number
}
const statusProof = (state: TurnState) => ({
  resumedWaiting: state.resumedWaiting,
  waitingRevision: state.waitingRevision,
  retryResolution: state.retryResolution,
  settlements: state.settlements
})
const pendingKeys = (state: TurnState) => [
  ...state.approvals.map(card => JSON.stringify(['approval', card.sessionId, card.requestId])),
  ...state.questions.flatMap(card =>
    card.questions.map(question =>
      JSON.stringify(['clarify', card.sessionId, card.requestId, question.id])
    )
  )
]
/** Keep readable cards separate from the exact pending keys that can still establish status. */
const confirmedCards = (state: ChatState, receipts: Map<string, number>, cutoff: number) => ({
  ...state,
  approvals: state.approvals.filter(
    card =>
      (receipts.get(JSON.stringify(['approval', card.sessionId, card.requestId])) ?? -1) > cutoff
  ),
  questions: state.questions.flatMap(card => {
    const questions = card.questions.filter(
      question =>
        (receipts.get(JSON.stringify(['clarify', card.sessionId, card.requestId, question.id])) ??
          -1) > cutoff
    )
    return questions.length ? [{ ...card, questions }] : []
  })
})
const requestReceipts = (
  before: TurnState,
  after: TurnState,
  revision: number,
  receipts: Map<string, number> = new Map()
) => {
  const known = new Set(pendingKeys(before))
  return new Map(
    pendingKeys(after).map(key => [key, receipts.get(key) ?? (known.has(key) ? -1 : revision)])
  )
}
const sameBot = (left: Bot | undefined, right: Bot) =>
  left?.name === right.name &&
  left.owner_id === right.owner_id &&
  left.created_at === right.created_at
const statusOf = (current: Bot, verified: Bot): Bot => ({
  ...current,
  status: verified.status,
  status_detail: verified.status_detail
})
/** Display text and the read-time timestamp do not identify a waiting request. */
const sameCause = (left: Bot, right: Bot) =>
  left.status === right.status &&
  (['session_id', 'section_id', 'room_id'] as const).every(
    key => left.status_detail?.[key] === right.status_detail?.[key]
  ) &&
  left.status_detail?.action?.kind === right.status_detail?.action?.kind &&
  (left.status_detail?.action?.kind !== 'fix_connector' ||
    (right.status_detail?.action?.kind === 'fix_connector' &&
      left.status_detail.action.connector === right.status_detail.action.connector))
const sameArchiveRoute = (before: ChatRoute, current: ChatRoute | null) =>
  before.kind === 'section' &&
  current?.kind === 'section' &&
  before.bot === current.bot &&
  Object.keys({ ...before.section, ...current.section }).every(
    key =>
      key === 'archived_at' ||
      before.section[key as keyof Section] === current.section[key as keyof Section]
  )
export function useMobile() {
  const [saved, setSaved] = useState<SavedDaemon[]>([])
  const [active, setActive] = useState<SavedDaemon | null>(null)
  const [connection, setConnection] = useState<MobileConnectionState>('offline')
  const [error, setError] = useState<string | null>(null)
  const [bots, setBots] = useState<Bot[]>([])
  const botsRef = useRef(bots)
  botsRef.current = bots
  const [rooms, setRooms] = useState<Room[]>([])
  const [sections, setSections] = useState<Section[]>([])
  const sectionsRef = useRef(sections)
  sectionsRef.current = sections
  const [info, setInfo] = useState<DaemonInfo | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [user, setUser] = useState<CurrentUser | null>(null)
  const [route, setRoute] = useState<ChatRoute | null>(null)
  const [chat, setChat] = useState(emptyChat)
  const [loading, setLoading] = useState(false)
  const [hasEarlier, setHasEarlier] = useState(false)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const session = useRef<MobileSession | null>(null)
  const routeRef = useRef<ChatRoute | null>(null)
  const liveId = useRef<string | null>(null)
  const roomEvents = useRef<RoomEvent[]>([])
  const loadingEvents = useRef<GatewayEvent[] | null>(null)
  const openSequence = useRef(0)
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mounted = useRef(true)
  /** Sessions holding files uploaded here for a message that was not sent. */
  const unsent = useRef(new Set<string>())
  /** The live session whose running turn was half in the history when it loaded. */
  const straddling = useRef<string | null>(null)
  const eventRevision = useRef(0)
  const rosterRevision = useRef(-1)
  const refreshSequence = useRef(0)
  const acceptedRefresh = useRef(0)
  const replayEpoch = useRef<string | null>(null)
  const botStatusReads = useRef(new Map<string, { request: number; revision: number }>())
  const botStatusChanges = useRef(new Map<string, number>())
  const pendingBotStatus = useRef(new Map<string, BotReadContext & { next?: BotReadContext }>())
  /** Only current room turns can project Working over an older status read. */
  const roomWorking = useRef(new Map<string, number>())
  /** Exact pending cards, starts, and retries retain proof after their route closes. */
  const submittedTurns = useRef(new Map<string, SubmittedTurn>())
  const pruneSubmitted = useCallback(() => {
    for (const [id, turn] of submittedTurns.current) {
      const bot = botsRef.current.find(bot => sameBot(bot, turn.bot))
      const cutoff = Math.max(
        rosterRevision.current,
        botStatusReads.current.get(turn.bot.name)?.revision ?? -1
      )
      turn.state = rosterChat(turn.state, cutoff)
      const archive = turn.section && sectionArchives.current.get(turn.section.id)
      const statusRead = Math.max(
        acceptedRefresh.current,
        botStatusReads.current.get(turn.bot.name)?.request ?? 0
      )
      const archived = archive?.archived_at && archive.cardArchiveRequest <= statusRead
      for (const [key, revision] of turn.cards)
        if (!archived && revision <= cutoff) turn.cards.set(key, -1)
      const pendingCards =
        turn.state.busy &&
        turn.state.waiting &&
        !turn.state.error &&
        pendingKeys(turn.state).some(key => (turn.cards.get(key) ?? -1) > (archived ? -1 : cutoff))
      const retry =
        turn.state.retryResolution?.resolved &&
        bot &&
        settledBot(bot, turn.state, id, turn.section?.id, turn.roomId) !== bot
      const working = turn.state.busy && !turn.state.error && (turn.workingRevision ?? -1) > cutoff
      if (
        !turn.pending &&
        (!bot ||
          (!pendingCards &&
            !working &&
            !retry &&
            (!turn.state.resumedWaiting ||
              settledBot(bot, turn.state, id, turn.section?.id, turn.roomId) === bot)))
      )
        submittedTurns.current.delete(id)
    }
  }, [])
  const retireSectionTurns = useCallback((section: Section, revision: number) => {
    if (!section.live_session_id) return
    for (const [id, turn] of submittedTurns.current)
      if (
        turn.section?.id === section.id &&
        turn.bot.name === section.bot &&
        id !== section.live_session_id &&
        turn.revision <= revision
      )
        submittedTurns.current.delete(id)
  }, [])
  const retainTurn = useCallback(
    (
      state: ChatState,
      bot: Bot,
      sessionId: string,
      section?: Section,
      roomId?: string,
      receipts?: Map<string, number>
    ) => {
      const proof = state.retryResolution
      const retry =
        proof?.resolved &&
        proof.sessionId === sessionId &&
        proof.bot === bot.name &&
        (roomId ? proof.roomId === roomId : proof.sectionId === section?.id)
      const owned = submittedTurns.current.get(sessionId)
      const pending = new Map(
        pendingKeys(state).map(key => [key, receipts?.get(key) ?? owned?.cards.get(key) ?? -1])
      )
      const receipt = Math.max(-1, ...pending.values())
      const cutoff = Math.max(
        rosterRevision.current,
        botStatusReads.current.get(bot.name)?.revision ?? -1
      )
      const answered =
        state.busy && !state.error && state.resumedWaiting && state.waitingRevision > cutoff
      const cards =
        receipt > cutoff &&
        state.busy &&
        state.waiting &&
        !state.error &&
        [...state.approvals, ...state.questions].some(card => card.sessionId === sessionId)
      if (!retry && !cards && !answered) return
      if (
        owned &&
        (!sameBot(owned.bot, bot) || owned.section?.id !== section?.id || owned.roomId !== roomId)
      )
        return
      if ((cards || answered) && section) {
        const here = routeRef.current
        const current =
          here?.kind === 'section' && here.section.id === section.id
            ? here.section
            : (sectionsRef.current.find(row => row.id === section.id) ?? section)
        if (
          current.bot !== bot.name ||
          current.archived_at ||
          sectionArchives.current.get(section.id)?.archived_at ||
          deletedSections.current.get(section.id)?.active ||
          (current.live_session_id && current.live_session_id !== sessionId)
        )
          return
      }
      const current = { ...state, messages: [], turns: {} }
      if (owned) {
        owned.state = current
        owned.cards = pending
      } else
        submittedTurns.current.set(sessionId, {
          bot,
          section,
          roomId,
          sessionId,
          revision: retry ? proof!.revision : answered ? state.waitingRevision : receipt,
          cards: pending,
          state: current,
          pending: 0
        })
    },
    []
  )
  /** Definitive deletions survive unavailable lists, but belong to this daemon epoch. */
  const deletedSections = useRef(new Map<string, { request: number; active: boolean }>())
  const deletedRooms = useRef(new Map<string, { request: number; active: boolean }>())
  /** Exact accepted archive fields survive an older list or open response. */
  const sectionArchives = useRef(
    new Map<
      string,
      {
        request: number
        bot: string
        archived_at: number | null
        generation: number
        mutationRequest?: number
        readChangeRequest?: number
        proofRequest: number
        /** The archive transition, without renewing it on unchanged catalog reads. */
        cardArchiveRequest: number
        restoredAt: number
      }
    >()
  )
  const archiveSnapshot = useCallback(
    () => new Map([...sectionArchives.current].map(([id, saved]) => [id, saved.generation])),
    []
  )
  const archiveSection = useCallback((section: Section): Section => {
    const saved = sectionArchives.current.get(section.id)
    return saved?.bot === section.bot ? { ...section, archived_at: saved.archived_at } : section
  }, [])
  const acceptArchive = useCallback(
    (section: Section, request: number, started?: Map<string, number>, mergeRoute = true) => {
      const saved = sectionArchives.current.get(section.id)
      if (
        !section.id ||
        !section.bot ||
        !(section.archived_at === null || typeof section.archived_at === 'number') ||
        deletedSections.current.get(section.id)?.active ||
        (started
          ? (started.get(section.id) ?? 0) !== (saved?.generation ?? 0) ||
            request < acceptedRefresh.current ||
            request < (saved?.request ?? 0)
          : request < Math.max(saved?.mutationRequest ?? 0, saved?.readChangeRequest ?? 0))
      )
        return
      const prior = saved
        ? saved.archived_at
        : sectionsRef.current.find(row => row.id === section.id && row.bot === section.bot)
            ?.archived_at
      const reflected = !started && saved?.bot === section.bot && prior === section.archived_at
      if (prior && section.archived_at === null && !reflected && !started)
        for (const turn of submittedTurns.current.values())
          if (
            turn.section?.id === section.id &&
            turn.bot.name === section.bot &&
            turn.state.busy &&
            turn.state.waiting &&
            !turn.state.error &&
            pendingKeys(turn.state).length
          )
            for (const [key, revision] of turn.cards)
              if (revision >= 0) turn.cards.set(key, ++eventRevision.current)
      const proofRequest = reflected
        ? saved.proofRequest
        : started
          ? request
          : ++refreshSequence.current
      const statusRead = Math.max(
        acceptedRefresh.current,
        botStatusReads.current.get(section.bot)?.request ?? 0
      )
      sectionArchives.current.set(section.id, {
        request: reflected ? Math.max(saved.request, request) : request,
        bot: section.bot,
        archived_at: section.archived_at,
        generation: (saved?.generation ?? 0) + (started || reflected ? 0 : 1),
        mutationRequest: started ? saved?.mutationRequest : request,
        // A verified later transition wins an old acknowledgment; an unchanged snapshot does not.
        readChangeRequest:
          started && prior !== undefined && prior !== section.archived_at
            ? request
            : saved?.readChangeRequest,
        proofRequest,
        cardArchiveRequest: section.archived_at
          ? saved && prior === section.archived_at
            ? saved.cardArchiveRequest
            : proofRequest
          : (saved?.cardArchiveRequest ?? 0),
        restoredAt: reflected
          ? saved.restoredAt
          : section.archived_at === null
            ? prior
              ? statusRead >= proofRequest
                ? 0
                : proofRequest
              : (saved?.restoredAt ?? 0)
            : 0
      })
      const before = sectionsRef.current
      const rows = before.map(row =>
        row.id === section.id && row.bot === section.bot && row.archived_at !== section.archived_at
          ? { ...row, archived_at: section.archived_at }
          : row
      )
      if (rows.some((row, i) => row !== before[i])) {
        sectionsRef.current = rows
        setSections(rows)
      }
      const here = routeRef.current
      if (
        mergeRoute &&
        here?.kind === 'section' &&
        here.section.id === section.id &&
        here.bot.name === section.bot &&
        here.section.archived_at !== section.archived_at
      ) {
        const next = { ...here, section: { ...here.section, archived_at: section.archived_at } }
        routeRef.current = next
        setRoute(next)
      }
      return true
    },
    []
  )
  const retireArchiveActivity = useCallback((name: string, request: number) => {
    for (const saved of sectionArchives.current.values())
      if (saved.bot === name && request >= saved.restoredAt) saved.restoredAt = 0
  }, [])
  const rpc: Rpc = useCallback(
    async (method, params = {}) => {
      const current = session.current
      const epoch = replayEpoch.current
      const archive = method === 'hexbot.sections.archive' || method === 'hexbot.sections.unarchive'
      const target = archive ? routeRef.current : null
      const opening = openSequence.current
      const beforeArchive =
        archive && typeof params.id === 'string'
          ? sectionArchives.current.get(params.id)
          : undefined
      const request = archive ? ++refreshSequence.current : 0
      if (!current || current.client.connectionState !== 'open')
        throw new Error('Connect to a daemon first.')
      let value: unknown
      try {
        value = await current.client.request(method, params)
      } catch (error) {
        if (
          (method === 'attachments.clear' || method.startsWith('hexbot.jobs.')) &&
          /unknown method|method not found|unsupported method|not implemented/i.test(
            errorText(error)
          )
        )
          throw new Error('This daemon is older than this app. Update it on that computer.')
        throw error
      }
      if (session.current !== current)
        throw new Error('The selected daemon changed. Retry on this daemon.')
      if (
        replayEpoch.current !== epoch &&
        (archive ||
          ['hexbot.sections.delete', 'approval.respond', 'clarify.respond'].includes(method))
      )
        throw new Error('The daemon restarted. Retry on this daemon.')
      if (method === 'hexbot.sections.delete') {
        if (
          mounted.current &&
          typeof params.id === 'string' &&
          (value as { deleted?: boolean })?.deleted === true
        )
          eventRef.current({
            type: 'hexbot.sections.changed',
            payload: { id: params.id, deleted: true }
          })
      }
      if (archive && mounted.current) {
        const section = (value as { section?: Section })?.section
        const here = routeRef.current
        const restoring =
          method === 'hexbot.sections.unarchive' &&
          target?.kind === 'section' &&
          here?.kind === 'section' &&
          target.section.id === params.id &&
          here.section.id === target.section.id &&
          sameBot(here.bot, target.bot) &&
          target.section.archived_at &&
          opening === openSequence.current
        if (section && section.id === params.id && section.bot) {
          const accepted = acceptArchive(section, request)
          const saved = sectionArchives.current.get(section.id)
          const reflectedRestore =
            !accepted &&
            saved?.bot === section.bot &&
            saved.archived_at === null &&
            saved.generation === beforeArchive?.generation &&
            saved.cardArchiveRequest === beforeArchive?.cardArchiveRequest
          if (accepted)
            eventRef.current({
              type: 'hexbot.sections.changed',
              payload: { id: section.id, bot: section.bot }
            })
          if (
            restoring &&
            (accepted || reflectedRestore) &&
            section.bot === target.bot.name &&
            section.archived_at === null
          ) {
            const accepted = sectionArchives.current.get(section.id)!
            const catalogSession = sectionsRef.current.find(
              row => row.id === section.id
            )?.live_session_id
            const catalogRead = refreshSequence.current
            const stillCurrent = (openedSession = liveId.current, read = catalogRead) => {
              const route = routeRef.current
              const saved = sectionArchives.current.get(section.id)
              const row = sectionsRef.current.find(row => row.id === section.id)
              return (
                session.current === current &&
                replayEpoch.current === epoch &&
                route?.kind === 'section' &&
                route.section.id === section.id &&
                sameBot(route.bot, target.bot) &&
                (acceptedRefresh.current <= read ||
                  row?.live_session_id === catalogSession ||
                  row?.live_session_id === openedSession) &&
                saved?.generation === accepted.generation &&
                saved.readChangeRequest === accepted.readChangeRequest &&
                saved.archived_at === null &&
                !deletedSections.current.get(section.id)?.active
              )
            }
            // Opening reconfirms exact pending keys, including cards received while archived.
            await syncChatRef.current(stillCurrent).catch(e => {
              if (stillCurrent()) setError(errorText(e))
            })
          }
        }
      }
      return value as never
    },
    [acceptArchive]
  )
  // Forgotten when the lists reload or the daemon changes, so new keys and models show.
  const [models] = useState(() => modelLists(provider => providerModels(rpc, provider)))
  // Each clear hands out a new reader, so a model line already on screen loads again.
  const [listModels, setListModels] = useState(() => models.get)
  const clearModels = useCallback(() => {
    models.clear()
    setListModels(() => models.get)
  }, [models])
  // Messages sent from here name their files, and the daemon drops the rest.
  // Clearing on leave keeps an abandoned upload off a message sent from
  // another app; it is best effort.
  const releaseStaged = useCallback((except?: string) => {
    const current = session.current
    for (const id of unsent.current) {
      if (id === except) continue
      unsent.current.delete(id)
      if (current?.client.connectionState === 'open')
        void current.client.request('attachments.clear', { session_id: id }).catch(() => {})
    }
  }, [])
  const leave = useCallback(() => {
    releaseStaged()
    openSequence.current++
    loadingEvents.current = null
    roomWorking.current.clear()
    routeRef.current = null
    liveId.current = null
    setRoute(null)
    setHasEarlier(false)
  }, [releaseStaged])
  const refresh = useCallback(async () => {
    const current = session.current
    const epoch = replayEpoch.current
    const request = ++refreshSequence.current
    const revision = eventRevision.current
    const archives = archiveSnapshot()
    clearModels()
    const before = routeRef.current
    const [b, r, s, i, config, me] = await Promise.all([
      rpc<{ bots: Bot[] }>('hexbot.bots.list'),
      rpc<{ rooms: Room[] }>('hexbot.rooms.list', ROOMS_QUERY),
      rpc<{ sections: Section[] }>('hexbot.sections.list', SECTIONS_QUERY),
      rpc<DaemonInfo>('hexbot.info'),
      rpc<Settings>('hexbot.settings.get'),
      rpc<CurrentUser>('hexbot.users.me')
    ])
    if (
      !mounted.current ||
      session.current !== current ||
      replayEpoch.current !== epoch ||
      request < acceptedRefresh.current
    )
      return
    // A newer successful read wins; a failed read leaves older useful results eligible.
    acceptedRefresh.current = request
    rosterRevision.current = Math.max(rosterRevision.current, revision)
    // A later verified bot read survives an older list, while other profiles still refresh.
    const nextBots = b.bots.map(bot => {
      const current = botsRef.current.find(row => row.name === bot.name)
      if (!sameBot(current, bot)) botStatusReads.current.delete(bot.name)
      retireArchiveActivity(bot.name, request)
      return (botStatusReads.current.get(bot.name)?.request ?? 0) > request && sameBot(current, bot)
        ? statusOf(bot, current!)
        : bot
    })
    for (const [name, read] of botStatusReads.current)
      if (read.request <= request || !nextBots.some(bot => bot.name === name))
        botStatusReads.current.delete(name)
    for (const name of botStatusChanges.current.keys())
      if (!nextBots.some(bot => bot.name === name)) botStatusChanges.current.delete(name)
    for (const name of pendingBotStatus.current.keys())
      if (!nextBots.some(bot => bot.name === name)) pendingBotStatus.current.delete(name)
    botsRef.current = nextBots
    setBots(nextBots)
    const nextRooms = r.rooms.filter(room => {
      const deleted = deletedRooms.current.get(room.id)
      return !deleted || (!deleted.active && deleted.request < request)
    })
    setRooms(nextRooms)
    const nextSections = s.sections
      .filter(section => {
        const deleted = deletedSections.current.get(section.id)
        return !deleted || (!deleted.active && deleted.request < request)
      })
      .map(section => {
        acceptArchive(section, request, archives, false)
        return archiveSection(section)
      })
    sectionsRef.current = nextSections
    setSections(nextSections)
    for (const section of nextSections) retireSectionTurns(section, revision)
    pruneSubmitted()
    setChat(c => rosterChat(c, rosterRevision.current))
    setInfo(i)
    setSettings(config)
    setUser(me)
    // The open conversation follows renames and edits, and closes once it is gone.
    // A route that changed while the lists loaded may be newer than them.
    if (!before || (routeRef.current !== before && !sameArchiveRoute(before, routeRef.current)))
      return
    const next = rebind(before, { bots: nextBots, rooms: nextRooms, sections: nextSections })
    if (!next) return leave()
    routeRef.current = next
    setRoute(next)
  }, [
    rpc,
    clearModels,
    leave,
    archiveSection,
    archiveSnapshot,
    acceptArchive,
    retireArchiveActivity,
    pruneSubmitted,
    retireSectionTurns
  ])
  const syncRoom = useCallback(
    async (id: string) => {
      const sequence = ++openSequence.current
      loadingEvents.current = []
      const stale = () =>
        sequence !== openSequence.current ||
        routeRef.current?.kind !== 'room' ||
        routeRef.current.room.id !== id
      try {
        const latest = await rpc<{ events: RoomEvent[] }>('hexbot.rooms.log', {
          id,
          before_seq: Number.MAX_SAFE_INTEGER,
          limit: ROOM_PAGE
        })
        if (stale()) return
        const events = latest.events
        // Older daemons ignore before_seq and answer from the start; read the rest.
        if (events.length === ROOM_PAGE && events[0]?.seq === 1)
          for (;;) {
            const page = await rpc<{ events: RoomEvent[] }>('hexbot.rooms.log', {
              id,
              after_seq: events.at(-1)!.seq,
              limit: 1000
            })
            if (stale()) return
            events.push(...page.events)
            if (page.events.length < 1000) break
          }
        const revision = ++eventRevision.current
        const epoch = replayEpoch.current
        let { room } = await rpc<{ room: Room }>('hexbot.rooms.get', { id })
        if (stale()) return
        roomWorking.current = new Map(
          epoch === replayEpoch.current
            ? (room.turns ?? []).flatMap(turn =>
                turn.live_session_id ? [[turn.live_session_id, revision] as const] : []
              )
            : []
        )
        roomEvents.current = events
        setHasEarlier((events[0]?.seq ?? 1) > 1)
        const buffered = loadingEvents.current ?? []
        loadingEvents.current = null
        const restored = restoreRoom(room, events)
        const priorTurns = new Map(submittedTurns.current)
        const ownedCards: { sessionId: string; bot: string; state: ChatState }[] = []
        for (const [sessionId, owned] of submittedTurns.current) {
          if (owned.roomId !== id) continue
          const turn = restored.turns[sessionId]
          const valid =
            epoch === replayEpoch.current &&
            !room.archived_at &&
            (!room.owner_id || !owned.bot.owner_id || room.owner_id === owned.bot.owner_id) &&
            sameBot(
              botsRef.current.find(bot => bot.name === owned.bot.name),
              owned.bot
            ) &&
            !room.members.some(
              member =>
                member.member_kind === 'bot' &&
                member.member_id === owned.bot.name &&
                member.left_at != null
            )
          const completed = completedRoomRetry(owned.state, id)
          const completedDuringRead =
            completed &&
            turn?.bot === owned.bot.name &&
            buffered.some(event => {
              const payload = (event.payload ?? {}) as Record<string, unknown>
              return (
                ((event as GatewayEvent & { mobileRevision?: number }).mobileRevision ?? 0) >
                  revision &&
                (!payload.bot || payload.bot === owned.bot.name) &&
                (!payload.room_id || payload.room_id === id) &&
                ((event.type === 'message.complete' &&
                  event.session_id === sessionId &&
                  !payload.error &&
                  payload.status !== 'error') ||
                  (event.type === 'hexbot.rooms.turn' &&
                    payload.room_id === id &&
                    payload.bot === owned.bot.name &&
                    payload.live_session_id === sessionId &&
                    payload.status === 'complete'))
              )
            })
          if (
            valid &&
            completed &&
            (!turn || completedDuringRead) &&
            owned.state.retryResolution?.bot === owned.bot.name &&
            owned.state.retryResolution.sessionId === sessionId &&
            room.members.some(
              member =>
                member.member_kind === 'bot' &&
                member.member_id === owned.bot.name &&
                member.left_at === null
            ) &&
            !room.turns?.some(
              turn =>
                turn.bot === owned.bot.name &&
                (!completedDuringRead || turn.live_session_id !== sessionId)
            )
          ) {
            if (completedDuringRead) {
              room = {
                ...room,
                turns: room.turns?.filter(
                  turn => turn.bot !== owned.bot.name || turn.live_session_id !== sessionId
                )
              }
              roomWorking.current.delete(sessionId)
            }
            restored.turns[sessionId] = {
              ...emptyTurn(),
              bot: owned.bot.name,
              sessionId,
              retryResolution: owned.state.retryResolution
            }
            continue
          }
          if (
            !valid ||
            completed ||
            !turn ||
            !sameBot(
              botsRef.current.find(bot => bot.name === turn.bot),
              owned.bot
            )
          ) {
            submittedTurns.current.delete(sessionId)
            continue
          }
          ownedCards.push({ sessionId, bot: turn.bot, state: owned.state })
        }
        setChat(roomChat(restored))
        routeRef.current = { kind: 'room', room }
        // Replayed approvals and events received during history loading go through the same reducer.
        for (const event of buffered) {
          const payload = (event.payload ?? {}) as Record<string, unknown>
          const beforeRead =
            ((event as GatewayEvent & { mobileRevision?: number }).mobileRevision ?? 0) <= revision
          // An older failed startup had no session to bind; the later snapshot owns this bot.
          if (
            beforeRead &&
            event.type === 'hexbot.rooms.turn' &&
            payload.room_id === id &&
            payload.live_session_id == null &&
            room.turns?.some(turn => turn.bot === payload.bot && turn.live_session_id)
          )
            continue
          if (
            event.type === 'hexbot.rooms.turn' &&
            payload.room_id === id &&
            ['running', 'working', 'waiting'].includes(String(payload.status)) &&
            typeof payload.live_session_id === 'string' &&
            room.turns?.some(
              turn => turn.bot === payload.bot && turn.live_session_id === payload.live_session_id
            )
          )
            priorTurns.delete(payload.live_session_id)
          const terminal =
            event.type === 'message.complete' ||
            event.type === 'error' ||
            (event.type === 'status.update' &&
              ['idle', 'done', 'error', 'interrupted'].includes(String(payload.kind))) ||
            (event.type === 'hexbot.rooms.turn' &&
              payload.room_id === id &&
              !['running', 'working', 'waiting'].includes(String(payload.status)))
          const sessionId =
            event.type === 'hexbot.rooms.turn' ? payload.live_session_id : event.session_id
          const active = terminal && room.turns?.find(turn => turn.live_session_id === sessionId)
          const prior =
            typeof sessionId === 'string' &&
            (submittedTurns.current.get(sessionId) ?? priorTurns.get(sessionId))
          if (
            active &&
            ((payload.bot && payload.bot !== active.bot) ||
              (payload.room_id && payload.room_id !== id) ||
              (!payload.bot && prior && prior.roomId === id && prior.bot.name !== active.bot))
          )
            continue
          if (active && typeof sessionId === 'string' && beforeRead) {
            // Keep exact card settlements without ending a newer snapshot's running turn.
            setChat(c => {
              const turn = c.turns[sessionId]
              if (!turn || turn.bot !== active.bot) return c
              const settled = reduceChat(
                { ...emptyChat(), ...turn },
                event.type === 'hexbot.rooms.turn'
                  ? { type: 'message.complete', session_id: sessionId, payload: {} }
                  : event
              )
              return roomChat({
                ...c,
                turns: {
                  ...c.turns,
                  [sessionId]: {
                    ...turn,
                    streaming: settled.streaming,
                    interim: settled.interim,
                    tools: settled.tools,
                    activity: '',
                    approvals: settled.approvals,
                    questions: settled.questions,
                    settlements: settled.settlements,
                    waiting: settled.waiting,
                    resumedWaiting: false,
                    waitingRevision: 0,
                    retryResolution: undefined
                  }
                }
              })
            })
          } else eventRef.current(event)
        }
        if (stale()) return
        // Owned cards already include live receipts; older replay must finish before copying them.
        setChat(c => {
          const turns = { ...c.turns }
          for (const { sessionId, bot, state } of ownedCards) {
            const turn = turns[sessionId]
            if (!turn || turn.bot !== bot) continue
            turns[sessionId] = {
              ...turn,
              approvals: state.approvals,
              questions: state.questions,
              waiting: state.waiting,
              activity: state.activity,
              settlements: { ...turn.settlements, ...state.settlements }
            }
          }
          return roomChat({ ...c, turns })
        })
        const updated = routeRef.current
        setRoute(updated)
        if (events.length) await rpc('hexbot.rooms.mark_read', { id, seq: events.at(-1)!.seq })
      } finally {
        if (sequence === openSequence.current) loadingEvents.current = null
      }
    },
    [rpc]
  )
  const syncChat = useCallback(
    async (stillCurrent?: (openedSession?: string | null, read?: number) => boolean) => {
      const target = routeRef.current
      if (!target || (stillCurrent && !stillCurrent())) return
      if (target.kind === 'room') return syncRoom(target.room.id)
      let failure: string | null = null
      let carried:
        | {
            sessionId: string
            epoch: string | null
            proof: ReturnType<typeof statusProof>
            state: ChatState
            cards: Map<string, number>
          }
        | undefined
      for (let attempt = 0; ; attempt++) {
        const sequence = ++openSequence.current
        const request = ++refreshSequence.current
        const archives = archiveSnapshot()
        const epoch = replayEpoch.current
        const cardsRevision = ++eventRevision.current
        let folded = false
        loadingEvents.current = []
        try {
          const result = await rpc<{
            section: Section
            messages: unknown[]
            pending_clarify?: Record<string, unknown>
          }>('hexbot.sections.open', { id: target.section.id })
          if (
            (stillCurrent &&
              (!stillCurrent(result.section.live_session_id, request) ||
                result.section.id !== target.section.id ||
                result.section.bot !== target.bot.name ||
                result.section.archived_at)) ||
            sequence !== openSequence.current ||
            routeRef.current?.kind !== 'section' ||
            routeRef.current.section.id !== target.section.id
          )
            return
          const snapshotRevision = eventRevision.current
          if (!stillCurrent) liveId.current = result.section.live_session_id
          const status = await rpc<{ status: string }>('session.status', {
            session_id: result.section.live_session_id
          })
          if (
            sequence !== openSequence.current ||
            (stillCurrent && !stillCurrent(result.section.live_session_id, request))
          )
            return
          liveId.current = result.section.live_session_id
          setHasEarlier(false)
          const submitted = submittedTurns.current.get(liveId.current!)
          const owned =
            epoch === replayEpoch.current &&
            submitted?.section?.id === target.section.id &&
            sameBot(submitted.bot, target.bot)
              ? submitted
              : undefined
          const previous =
            carried?.sessionId === liveId.current && carried.epoch === replayEpoch.current
              ? carried
              : undefined
          const pendingState =
            previous?.state ?? (owned && owned.revision <= cardsRevision ? owned.state : undefined)
          const snapshot = {
            ...emptyChat(),
            ...(owned ? statusProof(owned.state) : {}),
            ...(previous?.proof ?? {}),
            settlements: { ...previous?.proof.settlements, ...owned?.state.settlements },
            busy: status.status === 'working',
            ...(pendingState && status.status === 'working'
              ? {
                  approvals: pendingState.approvals,
                  questions: pendingState.questions,
                  waiting: pendingState.waiting,
                  activity: pendingState.activity
                }
              : {}),
            messages: historyMessages(result.messages)
          }
          // Receipt proof follows the accepted pending keys, not the age of their history read.
          const receipts = new Map(previous?.cards)
          for (const key of pendingKeys(snapshot))
            receipts.set(key, owned?.cards.get(key) ?? receipts.get(key) ?? cardsRevision)
          const received = new Set(pendingKeys(snapshot))
          if (result.pending_clarify) {
            const pending = reduceChat(
              { ...emptyChat(), settlements: snapshot.settlements },
              {
                type: 'clarify.request',
                session_id: liveId.current!,
                payload: result.pending_clarify
              }
            )
            for (const key of pendingKeys(pending))
              if (!previous?.cards.has(key))
                receipts.set(key, Math.max(receipts.get(key) ?? -1, cardsRevision))
          }
          const replay = restoreChat(
            snapshot,
            liveId.current!,
            result.pending_clarify,
            loadingEvents.current ?? [],
            (before, after, event) => {
              if (!['approval.request', 'clarify.request'].includes(event.type)) return
              const payload = (event.payload ?? {}) as Record<string, unknown>
              if (
                (payload.bot && payload.bot !== target.bot.name) ||
                (payload.section_id && payload.section_id !== target.section.id) ||
                payload.room_id
              )
                return
              const revision = (event as GatewayEvent & { mobileRevision?: number }).mobileRevision
              if (revision === undefined) return
              const known = new Set(pendingKeys(before))
              const requested = new Set(pendingKeys(reduceChat(emptyChat(), event)))
              for (const key of pendingKeys(after))
                if (
                  requested.has(key) &&
                  (!known.has(key) || (!received.has(key) && revision <= snapshotRevision))
                )
                  receipts.set(key, revision)
              for (const key of requested) received.add(key)
            }
          )
          folded = true
          const pendingReceipts = new Map(
            pendingKeys(replay.state).map(key => [key, receipts.get(key) ?? cardsRevision])
          )
          const latestCard = Math.max(-1, ...pendingReceipts.values())
          if (
            replay.state.retryResolution?.sessionId === liveId.current &&
            epoch === replayEpoch.current &&
            result.section.id === target.section.id &&
            result.section.bot === target.bot.name &&
            sameBot(
              botsRef.current.find(bot => bot.name === target.bot.name),
              target.bot
            )
          )
            replay.state.retryResolution = {
              ...replay.state.retryResolution,
              bot: target.bot.name,
              sectionId: target.section.id,
              roomId: undefined
            }
          if (owned) {
            owned.state = {
              ...replay.state,
              messages: [],
              turns: {},
              error: replay.state.error ?? owned.state.error
            }
            owned.cards = pendingReceipts
            pruneSubmitted()
          }
          failure = replay.state.error ?? failure
          straddling.current = replay.state.busy ? liveId.current : null
          let restored = { ...replay.state, error: failure }
          // Check-ins have no session id, so restore only this section's messages.
          for (const event of loadingEvents.current ?? []) {
            const payload = (event.payload ?? {}) as Record<string, unknown>
            if (
              event.type === 'hexbot.checkins.message' &&
              payload.section_id === target.section.id &&
              typeof payload.row_id === 'string' &&
              typeof payload.text === 'string'
            )
              restored = checkinMessage(restored, payload.row_id, payload.text)
          }
          const bot = botsRef.current.find(bot => sameBot(bot, target.bot))
          loadingEvents.current = null
          setChat(rosterChat(restored, rosterRevision.current))
          acceptArchive(result.section, request, archives, false)
          const newRoute: ChatRoute = { ...target, section: archiveSection(result.section) }
          if (
            epoch === replayEpoch.current &&
            request >= acceptedRefresh.current &&
            result.section.id === target.section.id &&
            result.section.bot === target.bot.name
          )
            retireSectionTurns(result.section, cardsRevision)
          routeRef.current = newRoute
          setRoute(newRoute)
          if (
            bot &&
            liveId.current &&
            epoch === replayEpoch.current &&
            result.section.id === target.section.id &&
            result.section.bot === bot.name &&
            (request >= acceptedRefresh.current ||
              (latestCard > cardsRevision &&
                sectionsRef.current.some(
                  section =>
                    section.id === result.section.id &&
                    section.bot === bot.name &&
                    !archiveSection(section).archived_at &&
                    (!section.live_session_id || section.live_session_id === liveId.current)
                )))
          )
            retainTurn(restored, bot, liveId.current, newRoute.section, undefined, pendingReceipts)
          // Keep accepted events visible even if the follow-up history read fails or is superseded.
          if (replay.reread && attempt < 2) {
            carried = {
              sessionId: liveId.current!,
              epoch: replayEpoch.current,
              proof: statusProof(replay.state),
              state: replay.state,
              cards: pendingReceipts
            }
            continue
          }
          await rpc('hexbot.sections.mark_read', { id: target.section.id })
          return
        } finally {
          if (sequence === openSequence.current) {
            const buffered = loadingEvents.current
            loadingEvents.current = null
            // A superseding archive can reject this read while the same chat still receives events.
            if (
              (stillCurrent || carried) &&
              !folded &&
              buffered &&
              epoch === replayEpoch.current &&
              routeRef.current?.kind === 'section' &&
              routeRef.current.section.id === target.section.id &&
              sameBot(routeRef.current.bot, target.bot)
            ) {
              const sessionId = liveId.current
              const receipts = new Map(carried?.cards)
              let requested = false
              for (const event of buffered) {
                const payload = (event.payload ?? {}) as Record<string, unknown>
                if (
                  event.session_id === sessionId &&
                  ['approval.request', 'clarify.request'].includes(event.type) &&
                  (!payload.bot || payload.bot === target.bot.name) &&
                  (!payload.section_id || payload.section_id === target.section.id) &&
                  !payload.room_id
                )
                  for (const key of pendingKeys(reduceChat(emptyChat(), event))) {
                    requested = true
                    if (!receipts.has(key))
                      receipts.set(
                        key,
                        (event as GatewayEvent & { mobileRevision?: number }).mobileRevision ?? -1
                      )
                  }
                eventRef.current(event, true)
              }
              // Existing turns already received the whole buffer. Only legacy unbound events
              // need a new record, and only after their final chat state has been installed.
              setChat(state => {
                const here = routeRef.current
                const bot = botsRef.current.find(bot => sameBot(bot, target.bot))
                if (
                  requested &&
                  sessionId &&
                  bot &&
                  sequence === openSequence.current &&
                  epoch === replayEpoch.current &&
                  liveId.current === sessionId &&
                  here?.kind === 'section' &&
                  here.section.id === target.section.id &&
                  sameBot(here.bot, target.bot) &&
                  !submittedTurns.current.has(sessionId)
                )
                  retainTurn(
                    { ...state, retryResolution: undefined },
                    bot,
                    sessionId,
                    here.section,
                    undefined,
                    receipts
                  )
                return state
              })
            }
          }
        }
      }
    },
    [
      rpc,
      syncRoom,
      archiveSection,
      archiveSnapshot,
      acceptArchive,
      pruneSubmitted,
      retainTurn,
      retireSectionTurns
    ]
  )
  const syncChatRef = useRef(syncChat)
  syncChatRef.current = syncChat
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh
  const verifyBotStatus = useCallback(
    async function verify(
      name: string,
      sessionId: string,
      sectionId: string,
      receipt: number,
      archive = false
    ) {
      const cached = botsRef.current.find(bot => bot.name === name)
      if (!cached) return
      const queued = pendingBotStatus.current.get(name)
      if (queued) {
        queued.next = {
          sessionId,
          sectionId,
          revision: receipt,
          archive: archive || queued.next?.archive || queued.archive
        }
        return
      }
      const current = session.current
      const epoch = replayEpoch.current
      const change = botStatusChanges.current.get(name)
      const request = ++refreshSequence.current
      const archives = archiveSnapshot()
      const revision = Math.max(receipt, eventRevision.current)
      const pending: BotReadContext & { next?: BotReadContext } = {
        sessionId,
        sectionId,
        revision,
        archive
      }
      pendingBotStatus.current.set(name, pending)
      const stale = () =>
        !mounted.current ||
        session.current !== current ||
        replayEpoch.current !== epoch ||
        pendingBotStatus.current.get(name) !== pending ||
        botStatusChanges.current.get(name) !== change ||
        request < acceptedRefresh.current ||
        request < (botStatusReads.current.get(name)?.request ?? 0) ||
        !sameBot(
          botsRef.current.find(bot => bot.name === name),
          cached
        )
      try {
        await Promise.allSettled([
          rpc<{ bot: Bot }>('hexbot.bots.get', { name }).then(result => {
            if (
              stale() ||
              !sameBot(result.bot, cached) ||
              !['working', 'idle', 'needs_you', 'stopped'].includes(String(result.bot.status))
            )
              return
            botStatusReads.current.set(name, { request, revision })
            retireArchiveActivity(name, request)
            const nextBots = botsRef.current.map(bot =>
              bot.name === name ? statusOf(bot, result.bot) : bot
            )
            botsRef.current = nextBots
            setBots(nextBots)
          }),
          archive
            ? rpc<{ sections: Section[] }>('hexbot.sections.list', {
                ...SECTIONS_QUERY,
                bot: name
              }).then(result => {
                if (stale()) return
                for (const row of result.sections)
                  if (row.bot === name) acceptArchive(row, request, archives)
              })
            : Promise.resolve()
        ])
        if (archive && !stale()) {
          const statusRead = Math.max(
            acceptedRefresh.current,
            botStatusReads.current.get(name)?.request ?? 0
          )
          for (const turn of submittedTurns.current.values()) {
            const saved = turn.section && sectionArchives.current.get(turn.section.id)
            if (
              turn.bot.name === name &&
              saved?.request === request &&
              saved.restoredAt > statusRead &&
              turn.state.busy &&
              turn.state.waiting &&
              !turn.state.error &&
              pendingKeys(turn.state).length
            )
              for (const [key, revision] of turn.cards)
                if (revision >= 0) turn.cards.set(key, ++eventRevision.current)
          }
        }
        pruneSubmitted()
      } finally {
        if (pendingBotStatus.current.get(name) === pending) {
          pendingBotStatus.current.delete(name)
          if (
            pending.next &&
            mounted.current &&
            session.current === current &&
            replayEpoch.current === epoch
          )
            void verify(
              name,
              pending.next.sessionId,
              pending.next.sectionId,
              pending.next.revision,
              pending.next.archive
            )
        }
      }
    },
    [rpc, acceptArchive, archiveSnapshot, retireArchiveActivity, pruneSubmitted]
  )
  const onEvent = useCallback(
    (event: GatewayEvent, chatOnly = false) => {
      // Preserve original receipt order when a loading buffer is replayed.
      if ((event as GatewayEvent & { mobileRevision?: number }).mobileRevision === undefined)
        event = { ...event, mobileRevision: ++eventRevision.current } as GatewayEvent
      const target = routeRef.current
      const p = (event.payload ?? {}) as Record<string, unknown>
      // Loading events already updated the roster and submitted turns on receipt.
      if (!chatOnly) {
        let removedRetry: Bot | undefined
        let removedRoomBots: Bot[] = []
        let repeatedDeletion = false
        if (
          event.type === 'gateway.ready' &&
          typeof p.replay_epoch === 'string' &&
          p.replay_epoch
        ) {
          if (replayEpoch.current && replayEpoch.current !== p.replay_epoch) {
            setChat(clearStatusProof)
            botStatusReads.current.clear()
            botStatusChanges.current.clear()
            pendingBotStatus.current.clear()
            roomWorking.current.clear()
            submittedTurns.current.clear()
            sectionArchives.current.clear()
            for (const deleted of deletedSections.current.values()) deleted.active = false
            for (const deleted of deletedRooms.current.values()) deleted.active = false
            setBots(rows => [...rows])
            // Events from the previous process cannot restore cards or status in a fresh snapshot.
            if (loadingEvents.current) loadingEvents.current = []
          }
          replayEpoch.current = p.replay_epoch
        }
        if (
          event.type === 'hexbot.rooms.changed' &&
          p.deleted === true &&
          typeof p.id === 'string' &&
          p.id
        ) {
          repeatedDeletion = Boolean(deletedRooms.current.get(p.id)?.active)
          if (!repeatedDeletion) {
            deletedRooms.current.set(p.id, { request: ++refreshSequence.current, active: true })
            removedRoomBots = botsRef.current.filter(bot => bot.status_detail?.room_id === p.id)
            setRooms(rows => rows.filter(room => room.id !== p.id))
            setBots(rows => [...rows])
            if (target?.kind === 'room' && p.id === target.room.id) {
              setChat(clearStatusProof)
              leave()
            }
          }
        }
        if (
          event.type === 'hexbot.sections.changed' &&
          p.deleted === true &&
          typeof p.id === 'string' &&
          p.id
        ) {
          repeatedDeletion = Boolean(deletedSections.current.get(p.id)?.active)
          if (!repeatedDeletion) {
            removedRetry = botsRef.current.find(
              bot =>
                bot.status === 'stopped' &&
                bot.status_detail?.section_id === p.id &&
                !bot.status_detail?.room_id &&
                bot.status_detail?.action?.kind === 'retry'
            )
            deletedSections.current.set(p.id, { request: ++refreshSequence.current, active: true })
            sectionArchives.current.delete(p.id)
            sectionsRef.current = sectionsRef.current.filter(section => section.id !== p.id)
            setSections(sectionsRef.current)
            setBots(rows => [...rows])
            if (routeRef.current?.kind === 'section' && routeRef.current.section.id === p.id)
              leave()
          }
        }
        const contradicts =
          !repeatedDeletion &&
          ([
            'approval.request',
            'clarify.request',
            'message.start',
            'message.complete',
            'error',
            'hexbot.bots.incident',
            'hexbot.sections.changed',
            'hexbot.rooms.changed',
            'hexbot.rooms.turn'
          ].includes(event.type) ||
            event.type === 'hexbot.bots.changed' ||
            (event.type === 'status.update' &&
              ['idle', 'done', 'error', 'interrupted'].includes(String(p.kind))))
        if (contradicts) {
          const revision = (event as GatewayEvent & { mobileRevision: number }).mobileRevision
          for (const bot of botsRef.current) {
            const detail = bot.status_detail
            const pending = pendingBotStatus.current.get(bot.name)
            if (
              p.bot === bot.name ||
              (event.type === 'hexbot.bots.changed' && p.name === bot.name) ||
              (event.session_id &&
                (event.session_id === detail?.session_id ||
                  event.session_id === pending?.sessionId ||
                  event.session_id === pending?.next?.sessionId)) ||
              (event.type === 'hexbot.sections.changed' &&
                typeof p.id === 'string' &&
                (p.id === detail?.section_id ||
                  p.id === pending?.sectionId ||
                  p.id === pending?.next?.sectionId)) ||
              (event.type === 'hexbot.rooms.changed' &&
                typeof p.id === 'string' &&
                p.id === detail?.room_id) ||
              (event.type === 'hexbot.rooms.turn' &&
                typeof p.room_id === 'string' &&
                p.room_id === detail?.room_id)
            )
              botStatusChanges.current.set(
                bot.name,
                Math.max(botStatusChanges.current.get(bot.name) ?? 0, revision)
              )
          }
        }
        if (
          event.type === 'hexbot.bots.changed' &&
          p.deleted !== true &&
          !(event as GatewayEvent & { mobileStatusRead?: boolean }).mobileStatusRead
        ) {
          event = { ...event, mobileStatusRead: true } as GatewayEvent
          const name = typeof p.name === 'string' ? p.name : typeof p.bot === 'string' ? p.bot : ''
          const bot = botsRef.current.find(bot => bot.name === name)
          if (bot) {
            const pending = pendingBotStatus.current.get(name)
            const context = pending?.next ?? pending
            void verifyBotStatus(
              name,
              context?.sessionId ?? bot.status_detail?.session_id ?? '',
              context?.sectionId ?? bot.status_detail?.section_id ?? '',
              (event as GatewayEvent & { mobileRevision: number }).mobileRevision,
              context?.archive
            )
          }
        }
        if (removedRetry)
          void verifyBotStatus(
            removedRetry.name,
            removedRetry.status_detail?.session_id ?? '',
            p.id as string,
            (event as GatewayEvent & { mobileRevision: number }).mobileRevision
          )
        for (const bot of removedRoomBots)
          void verifyBotStatus(
            bot.name,
            bot.status_detail?.session_id ?? '',
            bot.status_detail?.section_id ?? '',
            (event as GatewayEvent & { mobileRevision: number }).mobileRevision
          )
        if (
          event.type === 'hexbot.sections.changed' &&
          p.deleted !== true &&
          typeof p.id === 'string' &&
          p.id
        ) {
          const name =
            typeof p.bot === 'string'
              ? p.bot
              : (sectionsRef.current.find(row => row.id === p.id)?.bot ??
                (target?.kind === 'section' && target.section.id === p.id
                  ? target.bot.name
                  : undefined) ??
                botsRef.current.find(bot => bot.status_detail?.section_id === p.id)?.name)
          if (name) {
            const revision = (event as GatewayEvent & { mobileRevision: number }).mobileRevision
            botStatusChanges.current.set(
              name,
              Math.max(botStatusChanges.current.get(name) ?? 0, revision)
            )
            void verifyBotStatus(
              name,
              '',
              p.id,
              (event as GatewayEvent & { mobileRevision: number }).mobileRevision,
              true
            )
          }
        }
        const canonical =
          event.type === 'approval.resolved'
            ? typeof p.choice === 'string' && ['once', 'session', 'deny'].includes(p.choice)
            : event.type === 'clarify.resolved' &&
              typeof p.status === 'string' &&
              ['waiting', 'answered'].includes(p.status) &&
              p.answers &&
              typeof p.answers === 'object' &&
              !Array.isArray(p.answers) &&
              Object.values(p.answers).every(answer => typeof answer === 'string')
        if (
          canonical &&
          event.session_id &&
          typeof p.request_id === 'string' &&
          p.request_id &&
          typeof p.bot === 'string' &&
          p.bot &&
          typeof p.section_id === 'string' &&
          p.section_id &&
          !(event as GatewayEvent & { mobileStatusRead?: boolean }).mobileStatusRead
        ) {
          event = { ...event, mobileStatusRead: true } as GatewayEvent
          void verifyBotStatus(
            p.bot,
            event.session_id!,
            p.section_id,
            (event as GatewayEvent & { mobileRevision: number }).mobileRevision
          )
        }
        let submittedChanged = false
        if (
          event.type === 'message.start' &&
          event.session_id &&
          typeof p.bot === 'string' &&
          p.bot &&
          typeof p.section_id === 'string' &&
          p.section_id &&
          !p.section_id.startsWith('room:') &&
          p.room_id === null &&
          !deletedSections.current.get(p.section_id)?.active
        ) {
          const bot = botsRef.current.find(bot => bot.name === p.bot)
          const section =
            sectionsRef.current.find(section => section.id === p.section_id) ??
            (target?.kind === 'section' && target.section.id === p.section_id
              ? target.section
              : undefined)
          const bound = submittedTurns.current.get(event.session_id)
          const sibling = [...submittedTurns.current.values()].find(
            turn =>
              bot &&
              sameBot(turn.bot, bot) &&
              turn.section?.id === p.section_id &&
              turn.sessionId !== event.session_id
          )
          if (
            bot &&
            (!section ||
              (section.bot === bot.name &&
                !archiveSection(section).archived_at &&
                (!section.live_session_id || section.live_session_id === event.session_id))) &&
            !sectionArchives.current.get(p.section_id)?.archived_at &&
            (!sibling ||
              sibling.revision <
                (event as GatewayEvent & { mobileRevision: number }).mobileRevision) &&
            (!bound ||
              (sameBot(bound.bot, bot) && !bound.roomId && bound.section?.id === p.section_id))
          ) {
            const owner = {
              ...section,
              id: p.section_id,
              bot: bot.name,
              archived_at: section?.archived_at ?? null,
              live_session_id: event.session_id
            } as Section
            retireSectionTurns(
              owner,
              (event as GatewayEvent & { mobileRevision: number }).mobileRevision
            )
            submittedTurns.current.set(event.session_id, {
              bot,
              section: owner,
              sessionId: event.session_id,
              revision: (event as GatewayEvent & { mobileRevision: number }).mobileRevision,
              cards: bound?.cards ?? new Map(),
              workingRevision: (event as GatewayEvent & { mobileRevision: number }).mobileRevision,
              state: bound?.state ?? emptyChat(),
              pending: bound?.pending ?? 0
            })
            submittedChanged = true
          }
        }
        for (const [id, turn] of submittedTurns.current) {
          if (
            (event.type === 'hexbot.sections.changed' &&
              p.deleted === true &&
              p.id === turn.section?.id) ||
            (event.type === 'hexbot.bots.changed' &&
              p.deleted === true &&
              (p.name === turn.bot.name || p.bot === turn.bot.name)) ||
            (event.type === 'hexbot.rooms.changed' && p.deleted === true && p.id === turn.roomId)
          ) {
            submittedTurns.current.delete(id)
            submittedChanged = true
          } else if (event.session_id === id) {
            if (
              (p.bot && p.bot !== turn.bot.name) ||
              (turn.roomId
                ? (p.room_id && p.room_id !== turn.roomId) || !acceptsRoomSession(turn.state, event)
                : p.room_id || (p.section_id && p.section_id !== turn.section?.id))
            )
              continue
            const before = turn.state
            turn.state = reduceChat(before, event)
            if (
              event.type === 'message.start' &&
              turn.state.retryResolution &&
              turn.section &&
              p.bot === turn.bot.name &&
              p.section_id === turn.section.id &&
              p.room_id === null
            )
              turn.state.retryResolution = {
                ...turn.state.retryResolution,
                bot: turn.bot.name,
                sectionId: turn.section.id,
                roomId: undefined
              }
            turn.cards = requestReceipts(
              before,
              turn.state,
              ['approval.request', 'clarify.request'].includes(event.type)
                ? (event as GatewayEvent & { mobileRevision: number }).mobileRevision
                : -1,
              turn.cards
            )
            submittedChanged = true
          } else if (
            event.type === 'hexbot.rooms.turn' &&
            turn.roomId &&
            p.room_id === turn.roomId &&
            p.bot === turn.bot.name &&
            typeof p.live_session_id === 'string' &&
            p.live_session_id !== id &&
            ['running', 'working', 'waiting'].includes(String(p.status))
          ) {
            submittedTurns.current.delete(id)
            submittedChanged = true
          } else if (
            event.type === 'hexbot.rooms.turn' &&
            p.room_id === turn.roomId &&
            p.live_session_id === id
          ) {
            turn.state =
              p.status === 'complete'
                ? reduceChat(turn.state, { type: 'message.complete', session_id: id, payload: {} })
                : clearStatusProof(turn.state)
            submittedChanged = true
          } else if (
            (p.bot === turn.bot.name &&
              [
                'approval.request',
                'clarify.request',
                'message.start',
                'error',
                'hexbot.bots.incident'
              ].includes(event.type)) ||
            (p.bot === turn.bot.name &&
              event.type === 'hexbot.rooms.turn' &&
              ['running', 'working', 'waiting'].includes(String(p.status)))
          ) {
            turn.state = clearStatusProof(turn.state)
            submittedChanged = true
          }
        }
        if (event.type === 'hexbot.rooms.changed' && p.deleted !== true)
          for (const turn of submittedTurns.current.values())
            if (turn.roomId === p.id)
              void verifyBotStatus(
                turn.bot.name,
                turn.sessionId,
                '',
                (event as GatewayEvent & { mobileRevision: number }).mobileRevision
              )
        pruneSubmitted()
        if (submittedChanged) setBots(rows => [...rows])
        if (event.type.endsWith('.changed')) {
          if (!refreshTimer.current)
            refreshTimer.current = setTimeout(() => {
              refreshTimer.current = null
              void refreshRef.current().catch(e => setError(errorText(e)))
            }, 200)
        }
      }
      if (loadingEvents.current) {
        loadingEvents.current.push(event)
        return
      }
      if (!target) return
      if (target.kind === 'room') {
        let currentRoom = target.room
        if (
          event.type === 'hexbot.rooms.turn' &&
          p.room_id === target.room.id &&
          typeof p.bot === 'string'
        ) {
          const id = typeof p.live_session_id === 'string' ? p.live_session_id : undefined
          const turns = (target.room.turns ?? []).filter(
            turn =>
              turn.bot !== p.bot ||
              (id &&
                turn.live_session_id !== id &&
                !['running', 'working', 'waiting'].includes(String(p.status)))
          )
          if (id && ['running', 'working', 'waiting'].includes(String(p.status)))
            turns.push({ bot: p.bot, live_session_id: id })
          currentRoom = { ...target.room, turns }
          routeRef.current = { kind: 'room', room: currentRoom }
          setRoute(routeRef.current)
        }
        if (p.room_id === target.room.id && event.type === 'hexbot.rooms.event') {
          const incoming = p.event as RoomEvent
          if (!incoming || roomEvents.current.some(e => e.seq === incoming.seq)) return
          roomEvents.current.push(incoming)
          void rpc('hexbot.rooms.mark_read', { id: target.room.id, seq: incoming.seq }).catch(
            () => {}
          )
        }
        setChat(c => {
          const known = new Set(pendingKeys(c))
          const next = reduceRoom(
            c,
            event,
            currentRoom,
            id => botsRef.current.find(b => b.name === id)?.display_name || id
          )
          if (event.type === 'message.start' && p.retry_resolved === true && event.session_id) {
            const turn = next.turns[event.session_id]
            const bot = turn && botsRef.current.find(bot => bot.name === turn.bot)
            if (turn && bot)
              retainTurn(
                { ...emptyChat(), ...turn },
                bot,
                event.session_id,
                undefined,
                currentRoom.id
              )
          }
          if (
            ['approval.request', 'clarify.request'].includes(event.type) &&
            event.session_id &&
            pendingKeys(next).some(key => !known.has(key))
          ) {
            const turn = next.turns[event.session_id]
            const bot = turn && botsRef.current.find(bot => bot.name === turn.bot)
            if (
              turn &&
              bot &&
              !currentRoom.archived_at &&
              currentRoom.turns?.some(
                active => active.bot === bot.name && active.live_session_id === event.session_id
              ) &&
              (!p.bot || p.bot === bot.name) &&
              (!p.room_id || p.room_id === currentRoom.id)
            )
              retainTurn(
                { ...emptyChat(), ...turn },
                bot,
                event.session_id,
                undefined,
                currentRoom.id,
                requestReceipts(
                  c,
                  next,
                  (event as GatewayEvent & { mobileRevision: number }).mobileRevision,
                  submittedTurns.current.get(event.session_id)?.cards
                )
              )
          }
          const id =
            event.type === 'hexbot.rooms.turn' &&
            p.room_id === target.room.id &&
            ['running', 'working'].includes(String(p.status))
              ? p.live_session_id
              : event.type === 'message.start' ||
                  (event.type === 'status.update' && p.kind === 'working')
                ? event.session_id
                : undefined
          if (typeof id === 'string' && next.turns[id]?.busy && !next.turns[id].error)
            roomWorking.current.set(
              id,
              Math.max(
                roomWorking.current.get(id) ?? -1,
                (event as GatewayEvent & { mobileRevision: number }).mobileRevision
              )
            )
          for (const id of roomWorking.current.keys())
            if (!next.turns[id]?.busy) roomWorking.current.delete(id)
          return rosterChat(next, rosterRevision.current)
        })
      } else {
        if (event.type === 'hexbot.checkins.message') {
          if (
            p.section_id === target.section.id &&
            typeof p.row_id === 'string' &&
            typeof p.text === 'string'
          ) {
            const [id, text] = [p.row_id, p.text]
            setChat(c => checkinMessage(c, id, text))
            // Seen as it arrived, so it is read.
            void rpc('hexbot.sections.mark_read', { id: target.section.id }).catch(() => {})
          }
          return
        }
        if (!event.session_id || event.session_id !== liveId.current) return
        if (event.type === 'message.complete' && straddling.current === event.session_id) {
          // Part of this turn was already in the history; the history now has all of it.
          straddling.current = null
          const failed = typeof p.error === 'string' ? p.error : null
          setChat(c =>
            rosterChat({ ...reduceChat(c, event), messages: c.messages }, rosterRevision.current)
          )
          void syncChatRef
            .current()
            .then(() => {
              if (failed && liveId.current === event.session_id)
                setChat(c => ({ ...c, error: failed }))
            })
            .catch(e => setError(errorText(e)))
          return
        }
        setChat(c => {
          const known = new Set(pendingKeys(c))
          let next = reduceChat(c, event)
          if (
            next.retryResolution?.sessionId === liveId.current &&
            sameBot(
              botsRef.current.find(bot => bot.name === target.bot.name),
              target.bot
            )
          )
            next = {
              ...next,
              retryResolution: {
                ...next.retryResolution,
                bot: target.bot.name,
                sectionId: target.section.id,
                roomId: undefined
              }
            }
          const bot = botsRef.current.find(bot => sameBot(bot, target.bot))
          if (
            !chatOnly &&
            event.session_id &&
            bot &&
            ((event.type === 'message.start' && p.retry_resolved === true) ||
              (['approval.request', 'clarify.request'].includes(event.type) &&
                (!p.bot || p.bot === bot.name) &&
                (!p.section_id || p.section_id === target.section.id) &&
                pendingKeys(next).some(key => !known.has(key))))
          )
            retainTurn(
              next,
              bot,
              event.session_id,
              target.section,
              undefined,
              ['approval.request', 'clarify.request'].includes(event.type)
                ? requestReceipts(
                    c,
                    next,
                    (event as GatewayEvent & { mobileRevision: number }).mobileRevision,
                    submittedTurns.current.get(event.session_id)?.cards
                  )
                : undefined
            )
          return rosterChat(next, rosterRevision.current)
        })
      }
    },
    [rpc, verifyBotStatus, leave, pruneSubmitted, retainTurn, archiveSection, retireSectionTurns]
  )
  const acknowledgedApprovals = useRef(new Set<string>())
  useEffect(() => {
    const visible = new Set<string>()
    for (const pending of chat.approvals) {
      const key = `${active?.id}:${connection}:${pending.sessionId}:${pending.requestId}`
      visible.add(key)
      if (acknowledgedApprovals.current.has(key)) continue
      void rpc('approval.received', {
        session_id: pending.sessionId,
        request_id: pending.requestId
      }).catch(() => acknowledgedApprovals.current.delete(key))
    }
    // Other room sessions can stream while a card waits; acknowledge it once per connection.
    acknowledgedApprovals.current = visible
  }, [chat.approvals, connection, active?.id, rpc])
  const eventRef = useRef(onEvent)
  eventRef.current = onEvent
  const activate = useCallback(
    async (daemon: SavedDaemon, suppliedToken?: string) => {
      const token = suppliedToken ?? (await loadToken(daemon.id))
      if (!token) throw new Error('This saved connection has no credential. Pair it again.')
      releaseStaged()
      session.current?.stop()
      setError(null)
      setActive(daemon)
      setBots([])
      setRooms([])
      setSections([])
      sectionsRef.current = []
      setInfo(null)
      setSettings(null)
      setUser(null)
      openSequence.current++
      loadingEvents.current = null
      eventRevision.current = 0
      rosterRevision.current = -1
      refreshSequence.current = 0
      acceptedRefresh.current = 0
      replayEpoch.current = null
      botStatusReads.current.clear()
      botStatusChanges.current.clear()
      pendingBotStatus.current.clear()
      roomWorking.current.clear()
      submittedTurns.current.clear()
      deletedSections.current.clear()
      deletedRooms.current.clear()
      sectionArchives.current.clear()
      routeRef.current = null
      liveId.current = null
      setRoute(null)
      setChat(emptyChat())
      const next = new MobileSession(
        daemon,
        token,
        (state, failure) => {
          if (session.current !== next || !mounted.current) return
          setConnection(state)
          if (failure) setError(failure.message)
          if (state === 'connected') setError(null)
          if (state === 'revoked') {
            void forgetDaemon(daemon.id).then(loadDaemons).then(setSaved)
            setActive(null)
            setRoute(null)
            routeRef.current = null
          }
        },
        async () => {
          if (session.current !== next || !mounted.current) return
          await refreshRef.current()
          if (session.current !== next || !mounted.current) return
          await syncChatRef.current()
          void registerPush(rpc, daemon.deviceId).catch(() => undefined)
        },
        event => {
          if (session.current === next && mounted.current) onEvent(event)
        }
      )
      session.current = next
      clearModels()
      await selectDaemon(daemon.id)
      await next.connect()
    },
    [onEvent, releaseStaged, clearModels]
  )
  useEffect(() => {
    mounted.current = true
    void (async () => {
      const list = await loadDaemons()
      setSaved(list)
      const last = await activeDaemonId()
      const daemon = list.find(d => d.id === last)
      if (daemon) await activate(daemon)
    })().catch(e => setError(errorText(e)))
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') void session.current?.connect().catch(e => setError(errorText(e)))
      else if (state === 'background') session.current?.suspend()
    })
    return () => {
      mounted.current = false
      subscription.remove()
      session.current?.stop()
      if (refreshTimer.current) clearTimeout(refreshTimer.current)
    }
  }, [activate])
  const accept = useCallback(
    async (result: { daemon: SavedDaemon; token: string }) => {
      await saveDaemon(result.daemon, result.token)
      setSaved(await loadDaemons())
      await activate(result.daemon, result.token)
    },
    [activate]
  )
  const pairing = async (address: string, code: string) => {
    setLoading(true)
    setError(null)
    try {
      const parsed = parsePairing(address)
      await accept(await pair(parsed?.origin ?? normalizeOrigin(address), parsed?.code ?? code))
    } catch (e) {
      setError(errorText(e))
      throw e
    } finally {
      setLoading(false)
    }
  }
  const openSection = async (bot: Bot, section?: Section) => {
    const request = ++refreshSequence.current
    setLoading(true)
    setError(null)
    try {
      const selected =
        section ??
        defaultSection(sections, bot.name) ??
        (await rpc<{ section: Section }>('hexbot.sections.create', { bot: bot.name })).section
      const deleted = deletedSections.current.get(selected.id)
      if (deleted && (deleted.active || deleted.request > request))
        throw new Error('This conversation was deleted.')
      const here = routeRef.current
      if (here?.kind !== 'section' || here.section.id !== selected.id) releaseStaged()
      const target: ChatRoute = { kind: 'section', section: selected, bot }
      routeRef.current = target
      setRoute(target)
      liveId.current = selected.live_session_id
      setChat(emptyChat())
      await syncChat()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setLoading(false)
    }
  }
  const openRoom = async (room: Room) => {
    setLoading(true)
    setError(null)
    if (deletedRooms.current.get(room.id)?.active) {
      setError('This room was deleted.')
      setLoading(false)
      return
    }
    releaseStaged()
    roomEvents.current = []
    setHasEarlier(false)
    routeRef.current = { kind: 'room', room }
    setRoute(routeRef.current)
    setChat(emptyChat())
    try {
      await syncRoom(room.id)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setLoading(false)
    }
  }
  /**
   * `attachments` are the ids of the files uploaded for this message; the
   * daemon sends only those. Undefined leaves every staged file attached, for
   * daemons that do not give uploads an id.
   */
  const send = async (input: string, hasAttachments = false, attachments?: string[]) => {
    const text = attachmentPrompt(input, hasAttachments)
    const target = routeRef.current
    if (!target || !text) throw new Error('Enter a message or attach a file.')
    const messageId = Crypto.randomUUID()
    setChat(c => ({
      ...c,
      busy: true,
      error: null,
      messages:
        target.kind === 'section'
          ? [...c.messages, { id: messageId, role: 'user', text }]
          : c.messages
    }))
    try {
      if (target.kind === 'room') await rpc('hexbot.rooms.send', { id: target.room.id, text })
      else {
        if (!liveId.current) throw new Error('Open this thread again before sending.')
        const sessionId = liveId.current
        await rpc('prompt.submit', { session_id: sessionId, text, attachments })
        unsent.current.delete(sessionId)
      }
    } catch (e) {
      // Another app cleared this thread's files after they were uploaded.
      const error = /attachment not found/i.test(errorText(e))
        ? new Error('A file was removed from the daemon before sending. Send again.')
        : e
      setChat(c => ({
        ...c,
        messages: c.messages.filter(m => m.id !== messageId),
        busy: target.kind === 'room' && Object.values(c.turns).some(turn => turn.busy),
        error: errorText(error)
      }))
      throw error
    }
  }
  const loadEarlier = async () => {
    const target = routeRef.current
    const first = roomEvents.current[0]
    if (target?.kind !== 'room' || !first || loadingEarlier) return
    setLoadingEarlier(true)
    try {
      const events: RoomEvent[] = []
      const visible = () => events.some(e => roomMessage(e, target.room))
      // Keep going back past pages that show nothing, such as runs of turn events.
      for (let before = first.seq; before > 1 && !visible();) {
        const page = await rpc<{ events: RoomEvent[] }>('hexbot.rooms.log', {
          id: target.room.id,
          before_seq: before,
          limit: ROOM_PAGE
        })
        if (!page.events.length) break
        events.unshift(...page.events)
        before = page.events[0].seq
      }
      const here = routeRef.current
      if (here?.kind !== 'room' || here.room.id !== target.room.id) return
      if (roomEvents.current[0] !== first) return
      roomEvents.current = [...events, ...roomEvents.current]
      const older = events.flatMap(e => {
        const m = roomMessage(e, here.room)
        return m ? [m] : []
      })
      setChat(c => ({
        ...c,
        messages: [...older.filter(m => !c.messages.some(x => x.id === m.id)), ...c.messages]
      }))
      setHasEarlier((events[0]?.seq ?? 1) > 1)
    } finally {
      setLoadingEarlier(false)
    }
  }
  const stop = async () => {
    const target = routeRef.current
    if (target?.kind === 'room') await rpc('hexbot.rooms.stop', { id: target.room.id })
    else if (liveId.current) await rpc('session.interrupt', { session_id: liveId.current })
  }
  const submitTurn = (sessionId: string): SubmittedTurn | undefined => {
    const target = routeRef.current
    const state =
      target?.kind === 'section' && liveId.current === sessionId
        ? chat
        : target?.kind === 'room'
          ? chat.turns[sessionId]
          : undefined
    const name = target?.kind === 'section' ? target.bot.name : chat.turns[sessionId]?.bot
    const bot = botsRef.current.find(bot => bot.name === name)
    if (!target || !state || !bot || (target.kind === 'section' && !sameBot(bot, target.bot)))
      return
    let owned = submittedTurns.current.get(sessionId)
    if (owned && !owned.pending) {
      owned.revision = ++eventRevision.current
    }
    if (!owned) {
      owned = {
        bot,
        section: target.kind === 'section' ? target.section : undefined,
        roomId: target.kind === 'room' ? target.room.id : undefined,
        sessionId,
        // A tap follows prior reads even when no gateway event arrived between them.
        revision: ++eventRevision.current,
        cards: new Map(),
        state: { ...emptyChat(), ...state, messages: [], turns: {} },
        pending: 0
      }
      submittedTurns.current.set(sessionId, owned)
    }
    owned.pending++
    return owned
  }
  const acceptSubmitted = (owned: SubmittedTurn | undefined, event: GatewayEvent) => {
    if (!owned) return eventRef.current(event)
    if (submittedTurns.current.get(owned.sessionId) !== owned) return
    const latest = botsRef.current.find(bot => sameBot(bot, owned.bot))
    // A delayed callback settles its card, but cannot resume a newer accepted wait cause.
    if (
      (owned.bot.status === 'needs_you' &&
        owned.bot.status_detail?.session_id === owned.sessionId &&
        latest?.status === 'needs_you' &&
        latest.status_detail?.session_id === owned.sessionId &&
        !sameCause(latest, owned.bot)) ||
      (latest?.status === 'idle' &&
        Math.max(rosterRevision.current, botStatusReads.current.get(latest.name)?.revision ?? -1) >=
          owned.revision)
    )
      event = { ...event, mobileRevision: owned.revision } as GatewayEvent
    const sectionId =
      owned.section?.id ??
      (owned.bot.status_detail?.session_id === owned.sessionId &&
      owned.bot.status_detail.room_id === owned.roomId
        ? owned.bot.status_detail.section_id
        : '') ??
      ''
    eventRef.current({
      ...event,
      payload: {
        ...(event.payload as Record<string, unknown>),
        bot: owned.bot.name,
        section_id: sectionId
      }
    })
    if (!sectionId) void verifyBotStatus(owned.bot.name, owned.sessionId, '', eventRevision.current)
  }
  const approval = async (requestId: string, choice: string, sessionId?: string) => {
    const pending = chat.approvals.find(
      a => a.requestId === requestId && (!sessionId || a.sessionId === sessionId)
    )
    if (!pending) return
    const owned = submitTurn(pending.sessionId)
    try {
      const result = await rpc<Record<string, unknown>>('approval.respond', {
        session_id: pending.sessionId,
        request_id: requestId,
        choice
      })
      const accepted = approvalResponse(pending, choice, result)
      if (accepted) acceptSubmitted(owned, accepted)
    } finally {
      if (owned) owned.pending--
      pruneSubmitted()
    }
  }
  const answer = async (
    requestId: string,
    questionId: string,
    answer: string,
    sessionId?: string
  ) => {
    const pending = chat.questions.find(
      q => q.requestId === requestId && (!sessionId || q.sessionId === sessionId)
    )
    if (!pending) return
    const owned = submitTurn(pending.sessionId)
    try {
      const result = await rpc<Record<string, unknown>>('clarify.respond', {
        session_id: pending.sessionId,
        request_id: requestId,
        question_id: questionId,
        answer
      })
      acceptSubmitted(owned, clarifyResponse(pending, questionId, answer, result))
    } finally {
      if (owned) owned.pending--
      pruneSubmitted()
    }
  }

  const inactiveConversationBot = (bot: Bot, siblings: TurnState[] = []): Bot => {
    const detail = bot.status_detail
    const section = sectionsRef.current.find(
      row => row.id === detail?.section_id && row.bot === bot.name
    )
    const saved = detail?.section_id && sectionArchives.current.get(detail.section_id)
    const archived = saved && saved.bot === bot.name ? saved.archived_at : section?.archived_at
    const statusRead = Math.max(
      acceptedRefresh.current,
      botStatusReads.current.get(bot.name)?.request ?? 0
    )
    if (
      !detail ||
      !(
        bot.status === 'working' ||
        bot.status === 'needs_you' ||
        (bot.status === 'stopped' && detail?.action?.kind === 'retry')
      ) ||
      !(detail?.room_id
        ? deletedRooms.current.get(detail.room_id)?.active
        : detail?.section_id &&
          (deletedSections.current.get(detail.section_id)?.active ||
            (archived && saved && saved.proofRequest > statusRead)))
    )
      return bot
    const failure = siblings.find(state => state.error)?.error
    return {
      ...bot,
      status: failure
        ? 'stopped'
        : siblings.some(state => state.approvals.length || state.questions.length)
          ? 'needs_you'
          : siblings.some(state => state.busy)
            ? 'working'
            : 'idle',
      status_detail: failure
        ? {
            action: null,
            section_id: null,
            room_id: null,
            session_id: null,
            since: detail.since,
            text: failure
          }
        : null
    }
  }
  const projectBot = (
    bot: Bot,
    state: TurnState,
    sessionId: string | null,
    section?: Section,
    roomId?: string
  ) => {
    if (section && archiveSection(section).archived_at) return inactiveConversationBot(bot)
    if (
      roomId &&
      ((route?.kind === 'room' && route.room.id === roomId && route.room.archived_at) ||
        rooms.find(room => room.id === roomId)?.archived_at)
    )
      return bot
    const read = botStatusReads.current.get(bot.name)
    let current = read ? rosterChat({ ...emptyChat(), ...state }, read.revision) : state
    const neutral = inactiveConversationBot(bot, [current])
    if (
      roomId &&
      current.retryResolution?.roomId === roomId &&
      ((route?.kind === 'room' && route.room.id === roomId && route.room.archived_at) ||
        rooms.find(room => room.id === roomId)?.archived_at ||
        sectionsRef.current.some(
          section => section.bot === bot.name && section.id === neutral.status_detail?.section_id
        ))
    )
      current = { ...current, retryResolution: { ...current.retryResolution, resolved: false } }
    const restored = section && sectionArchives.current.get(section.id)
    const detail = neutral.status_detail
    const working = sessionId ? submittedTurns.current.get(sessionId)?.workingRevision : undefined
    const cutoff = Math.max(rosterRevision.current, read?.revision ?? -1)
    const active =
      (restored?.restoredAt || (working !== undefined && working !== null && working > cutoff)) &&
      current.busy &&
      sessionId &&
      neutral.status === 'idle' &&
      (!detail ||
        (!detail.room_id &&
          (!detail.section_id || detail.section_id === section?.id) &&
          (!detail.session_id || detail.session_id === sessionId)))
        ? {
            ...neutral,
            status: 'working' as const,
            status_detail: {
              section_id: section?.id ?? null,
              session_id: sessionId,
              room_id: null,
              since: detail?.since ?? 0,
              text: current.activity,
              action: null
            }
          }
        : neutral
    return settledBot(active, current, sessionId, section?.id, roomId)
  }
  const visibleBots = bots.map(bot => {
    for (const turn of submittedTurns.current.values())
      if (sameBot(bot, turn.bot))
        bot = projectBot(
          bot,
          confirmedCards(
            turn.state,
            turn.cards,
            Math.max(rosterRevision.current, botStatusReads.current.get(bot.name)?.revision ?? -1)
          ),
          turn.sessionId,
          turn.section,
          turn.roomId
        )
    if (route?.kind === 'section' && route.bot.name === bot.name)
      return projectBot(bot, chat, liveId.current, route.section)
    if (route?.kind === 'room') {
      const siblings = Object.values(chat.turns).filter(turn => turn.bot === bot.name)
      let neutral = inactiveConversationBot(bot, siblings)
      const named = siblings.find(turn => turn.sessionId === bot.status_detail?.session_id)
      if (named) neutral = projectBot(neutral, named, named.sessionId, undefined, route.room.id)
      const pending = siblings.find(turn =>
        [...turn.approvals, ...turn.questions].some(card => card.sessionId === turn.sessionId)
      )
      const cutoff = Math.max(
        rosterRevision.current,
        botStatusReads.current.get(bot.name)?.revision ?? -1
      )
      const retried = siblings.find(
        turn =>
          turn.retryResolution?.roomId === route.room.id &&
          turn.retryResolution.sessionId === turn.sessionId &&
          turn.retryResolution.resolved &&
          turn.retryResolution.revision > cutoff &&
          !turn.error
      )
      if (retried)
        neutral = projectBot(neutral, retried, retried.sessionId, undefined, route.room.id)
      const working = siblings.find(
        turn => turn.busy && !turn.error && (roomWorking.current.get(turn.sessionId) ?? -1) > cutoff
      )
      const answered = !siblings.some(turn => turn.error)
        ? siblings.find(turn => turn.busy && turn.resumedWaiting && turn.waitingRevision > cutoff)
        : undefined
      const turn = pending ?? retried ?? working ?? answered ?? named
      const active =
        turn === working &&
        working &&
        !siblings.some(turn => turn.error) &&
        (neutral.status === 'idle' || neutral.status === 'working')
          ? {
              ...neutral,
              status: 'working' as const,
              status_detail: {
                session_id: working.sessionId,
                section_id: null,
                room_id: route.room.id,
                since: neutral.status_detail?.since ?? 0,
                text: working.activity,
                action: null
              }
            }
          : neutral
      return turn ? projectBot(active, turn, turn.sessionId, undefined, route.room.id) : neutral
    }
    return inactiveConversationBot(bot)
  })
  const cachedRouteBot =
    route?.kind === 'section' && visibleBots.find(bot => sameBot(bot, route.bot))
  const visibleRoute =
    route?.kind === 'section'
      ? {
          ...route,
          bot: projectBot(
            cachedRouteBot ? statusOf(route.bot, cachedRouteBot) : route.bot,
            chat,
            liveId.current,
            route.section
          )
        }
      : route

  return {
    saved,
    active,
    connection,
    error,
    setError,
    bots: visibleBots,
    rooms,
    sections,
    info,
    settings,
    user,
    route: visibleRoute,
    chat,
    loading,
    hasEarlier,
    loadingEarlier,
    loadEarlier,
    rpc,
    /** A provider's models, fetched once for every screen showing them. */
    models: listModels,
    refresh,
    syncChat,
    accept,
    activate,
    pairing,
    openSection,
    openRoom,
    send,
    stop,
    approval,
    answer,
    liveSessionId: () => liveId.current,
    /** A file reached the daemon and waits for that session's next message. */
    stage: (sessionId: string) => {
      unsent.current.add(sessionId)
      // The upload finished after its conversation was left.
      releaseStaged(liveId.current ?? undefined)
    },
    back: leave,
    disconnect: async () => {
      releaseStaged()
      session.current?.stop()
      session.current = null
      setActive(null)
      setRoute(null)
      routeRef.current = null
      setConnection('offline')
    },
    remove: async (id: string) => {
      // A forgotten daemon stops pushing to this phone. Only the connected one
      // can be told; revoking this device on another daemon stops it there.
      if (active?.id === id)
        await rpc('hexbot.devices.set_push', { token: null }).catch(() => undefined)
      if (active?.id === id) {
        releaseStaged()
        session.current?.stop()
        session.current = null
        setActive(null)
        setRoute(null)
        routeRef.current = null
      }
      await forgetDaemon(id)
      setSaved(await loadDaemons())
    },
    retry: () => session.current?.connect()
  }
}
