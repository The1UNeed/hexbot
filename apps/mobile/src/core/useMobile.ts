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
import { parsePairing, normalizeOrigin } from './links'
import {
  approvalResponse,
  clarifyResponse,
  clearStatusProof,
  emptyChat,
  historyMessages,
  reduceChat,
  restoreChat,
  rosterChat,
  settledBot
} from './chat'
import { reduceRoom, restoreRoom, roomMessage } from './room-chat'
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
  state: ChatState
  pending: number
}
const statusProof = (state: TurnState) => ({
  resumedWaiting: state.resumedWaiting,
  waitingRevision: state.waitingRevision,
  retryResolution: state.retryResolution,
  settlements: state.settlements
})
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
  /** Only submitted, known cards retain answer proof after their route closes. */
  const submittedTurns = useRef(new Map<string, SubmittedTurn>())
  const pruneSubmitted = useCallback(() => {
    for (const [id, turn] of submittedTurns.current) {
      const bot = botsRef.current.find(bot => sameBot(bot, turn.bot))
      turn.state = rosterChat(
        turn.state,
        Math.max(rosterRevision.current, botStatusReads.current.get(turn.bot.name)?.revision ?? -1)
      )
      if (
        !turn.pending &&
        (!bot ||
          !turn.state.resumedWaiting ||
          settledBot(bot, turn.state, id, turn.section?.id, turn.roomId) === bot)
      )
        submittedTurns.current.delete(id)
    }
  }, [])
  /** Definitive deletions survive unavailable lists, but belong to this daemon epoch. */
  const deletedSections = useRef(new Map<string, { request: number; active: boolean }>())
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
        if (section && section.id === params.id && section.bot && acceptArchive(section, request)) {
          eventRef.current({
            type: 'hexbot.sections.changed',
            payload: { id: section.id, bot: section.bot }
          })
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
    pruneSubmitted()
    setChat(c => rosterChat(c, rosterRevision.current))
    setRooms(r.rooms)
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
    setInfo(i)
    setSettings(config)
    setUser(me)
    // The open conversation follows renames and edits, and closes once it is gone.
    // A route that changed while the lists loaded may be newer than them.
    if (!before || (routeRef.current !== before && !sameArchiveRoute(before, routeRef.current)))
      return
    const next = rebind(before, { bots: nextBots, rooms: r.rooms, sections: nextSections })
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
    pruneSubmitted
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
        const { room } = await rpc<{ room: Room }>('hexbot.rooms.get', { id })
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
        setChat(restoreRoom(room, events))
        routeRef.current = { kind: 'room', room }
        // Replayed approvals and events received during history loading go through the same reducer.
        for (const event of buffered) eventRef.current(event)
        const updated = { kind: 'room' as const, room }
        routeRef.current = updated
        setRoute(updated)
        if (events.length) await rpc('hexbot.rooms.mark_read', { id, seq: events.at(-1)!.seq })
      } finally {
        if (sequence === openSequence.current) loadingEvents.current = null
      }
    },
    [rpc]
  )
  const syncChat = useCallback(async () => {
    const target = routeRef.current
    if (!target) return
    if (target.kind === 'room') return syncRoom(target.room.id)
    let failure: string | null = null
    let carried:
      { sessionId: string; epoch: string | null; proof: ReturnType<typeof statusProof> } | undefined
    for (let attempt = 0; ; attempt++) {
      const sequence = ++openSequence.current
      const request = ++refreshSequence.current
      const archives = archiveSnapshot()
      const epoch = replayEpoch.current
      loadingEvents.current = []
      try {
        const result = await rpc<{
          section: Section
          messages: unknown[]
          pending_clarify?: Record<string, unknown>
        }>('hexbot.sections.open', { id: target.section.id })
        if (
          sequence !== openSequence.current ||
          routeRef.current?.kind !== 'section' ||
          routeRef.current.section.id !== target.section.id
        )
          return
        liveId.current = result.section.live_session_id
        setHasEarlier(false)
        const status = await rpc<{ status: string }>('session.status', {
          session_id: liveId.current
        })
        if (sequence !== openSequence.current) return
        const submitted = submittedTurns.current.get(liveId.current!)
        const owned =
          epoch === replayEpoch.current &&
          submitted?.section?.id === target.section.id &&
          sameBot(submitted.bot, target.bot)
            ? submitted
            : undefined
        const snapshot = {
          ...emptyChat(),
          settlements: owned?.state.settlements ?? {},
          ...(carried?.sessionId === liveId.current && carried.epoch === replayEpoch.current
            ? carried.proof
            : {}),
          busy: status.status === 'working',
          messages: historyMessages(result.messages)
        }
        const replay = restoreChat(
          snapshot,
          liveId.current!,
          result.pending_clarify,
          loadingEvents.current ?? []
        )
        if (owned) {
          if (result.pending_clarify)
            owned.state = reduceChat(owned.state, {
              type: 'clarify.request',
              session_id: liveId.current!,
              payload: result.pending_clarify
            })
          owned.state = {
            ...owned.state,
            busy: replay.state.busy,
            error: replay.state.error ?? owned.state.error
          }
          pruneSubmitted()
        }
        failure = replay.state.error ?? failure
        // A turn finished while the history loaded; read it again so its replies show once.
        if (replay.reread && attempt < 2) {
          carried = {
            sessionId: liveId.current!,
            epoch: replayEpoch.current,
            proof: statusProof(replay.state)
          }
          continue
        }
        straddling.current = replay.state.busy ? liveId.current : null
        const restored = { ...replay.state, error: failure }
        loadingEvents.current = null
        setChat(rosterChat(restored, rosterRevision.current))
        acceptArchive(result.section, request, archives, false)
        const newRoute: ChatRoute = { ...target, section: archiveSection(result.section) }
        routeRef.current = newRoute
        setRoute(newRoute)
        await rpc('hexbot.sections.mark_read', { id: target.section.id })
        return
      } finally {
        if (sequence === openSequence.current) loadingEvents.current = null
      }
    }
  }, [rpc, syncRoom, archiveSection, archiveSnapshot, acceptArchive, pruneSubmitted])
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
            pruneSubmitted()
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
    (event: GatewayEvent) => {
      // Preserve original receipt order when a loading buffer is replayed.
      if ((event as GatewayEvent & { mobileRevision?: number }).mobileRevision === undefined)
        event = { ...event, mobileRevision: ++eventRevision.current } as GatewayEvent
      const target = routeRef.current
      const p = (event.payload ?? {}) as Record<string, unknown>
      let removedRetry: Bot | undefined
      let repeatedDeletion = false
      if (event.type === 'gateway.ready' && typeof p.replay_epoch === 'string' && p.replay_epoch) {
        if (replayEpoch.current && replayEpoch.current !== p.replay_epoch) {
          setChat(clearStatusProof)
          botStatusReads.current.clear()
          botStatusChanges.current.clear()
          pendingBotStatus.current.clear()
          roomWorking.current.clear()
          submittedTurns.current.clear()
          sectionArchives.current.clear()
          for (const deleted of deletedSections.current.values()) deleted.active = false
          setBots(rows => [...rows])
          // Events from the previous process cannot restore cards or status in a fresh snapshot.
          if (loadingEvents.current) loadingEvents.current = []
        }
        replayEpoch.current = p.replay_epoch
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
          if (routeRef.current?.kind === 'section' && routeRef.current.section.id === p.id) leave()
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
      if (event.type === 'hexbot.bots.changed' && p.deleted !== true) {
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
          turn.state = reduceChat(turn.state, event)
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
          p.bot === turn.bot.name &&
          [
            'approval.request',
            'clarify.request',
            'message.start',
            'error',
            'hexbot.bots.incident',
            'hexbot.rooms.turn'
          ].includes(event.type)
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
      if (loadingEvents.current) {
        loadingEvents.current.push(event)
        return
      }
      if (!target) return
      if (target.kind === 'room') {
        if (p.room_id === target.room.id && event.type === 'hexbot.rooms.event') {
          const incoming = p.event as RoomEvent
          if (!incoming || roomEvents.current.some(e => e.seq === incoming.seq)) return
          roomEvents.current.push(incoming)
          void rpc('hexbot.rooms.mark_read', { id: target.room.id, seq: incoming.seq }).catch(
            () => {}
          )
        }
        setChat(c => {
          const next = reduceRoom(
            c,
            event,
            target.room,
            id => botsRef.current.find(b => b.name === id)?.display_name || id
          )
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
        setChat(c => rosterChat(reduceChat(c, event), rosterRevision.current))
      }
    },
    [rpc, verifyBotStatus, leave, pruneSubmitted]
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
        busy: target.kind === 'room' && Object.keys(c.turns).length > 0,
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
    if (!owned) {
      owned = {
        bot,
        section: target.kind === 'section' ? target.section : undefined,
        roomId: target.kind === 'room' ? target.room.id : undefined,
        sessionId,
        // A tap follows prior reads even when no gateway event arrived between them.
        revision: ++eventRevision.current,
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

  const inactiveSectionBot = (bot: Bot, siblings: TurnState[] = []): Bot => {
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
      !(
        bot.status === 'working' ||
        bot.status === 'needs_you' ||
        (bot.status === 'stopped' && detail?.action?.kind === 'retry')
      ) ||
      detail?.room_id ||
      !detail?.section_id ||
      (!deletedSections.current.get(detail.section_id)?.active &&
        !(archived && saved && saved.proofRequest > statusRead))
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
    if (section && archiveSection(section).archived_at) return inactiveSectionBot(bot)
    const read = botStatusReads.current.get(bot.name)
    const current = read ? rosterChat({ ...emptyChat(), ...state }, read.revision) : state
    const neutral = inactiveSectionBot(bot, [current])
    const restored = section && sectionArchives.current.get(section.id)
    const detail = neutral.status_detail
    const active =
      restored?.restoredAt &&
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
        bot = projectBot(bot, turn.state, turn.sessionId, turn.section, turn.roomId)
    if (route?.kind === 'section' && route.bot.name === bot.name)
      return projectBot(bot, chat, liveId.current, route.section)
    if (route?.kind === 'room') {
      const siblings = Object.values(chat.turns).filter(turn => turn.bot === bot.name)
      let neutral = inactiveSectionBot(bot, siblings)
      const named = siblings.find(turn => turn.sessionId === bot.status_detail?.session_id)
      if (named) neutral = projectBot(neutral, named, named.sessionId, undefined, route.room.id)
      const pending = siblings.find(turn =>
        [...turn.approvals, ...turn.questions].some(card => card.sessionId === turn.sessionId)
      )
      const cutoff = Math.max(
        rosterRevision.current,
        botStatusReads.current.get(bot.name)?.revision ?? -1
      )
      const working = siblings.find(
        turn => turn.busy && !turn.error && (roomWorking.current.get(turn.sessionId) ?? -1) > cutoff
      )
      const answered = !siblings.some(turn => turn.error)
        ? siblings.find(turn => turn.busy && turn.resumedWaiting && turn.waitingRevision > cutoff)
        : undefined
      const turn = pending ?? working ?? answered ?? named
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
    return inactiveSectionBot(bot)
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
