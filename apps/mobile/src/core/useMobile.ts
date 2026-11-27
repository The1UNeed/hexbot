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
  answeredApproval,
  bufferedRunEnded,
  emptyChat,
  heartbeatMessage,
  historyMessages,
  isFailedCompletion,
  latestRunEvents,
  mergeTurnTools,
  pendingTurnTools,
  reduceChat,
  replayChat,
  settleTurnTools,
  unconfirmedTurnTools
} from './chat'
import {
  afterRead,
  cursorFor,
  fingerprint,
  keep,
  prefetchOrder,
  readAhead,
  type HeldRows,
  type HistoryRead
} from './chat-cache'
import { mergeAsked, reduceRoom, restoreRoom, roomChat, roomMessage } from './room-chat'
import { attachmentPrompt, unknownMethod } from './chat-send'
import { addNotice, type ComputersListed, latestReads } from './computer'
import {
  applyReactions,
  emptyReactions,
  indexReactions,
  restoreReactions,
  toggleReaction
} from './reactions'
import { modelLists, providerModels } from './models'
import {
  ROOMS_QUERY,
  SECTIONS_QUERY,
  botChat,
  listSections,
  ownerChat,
  rebind,
  stoppedIn,
  type ChatRoute
} from './routes'
import type {
  Bot,
  ChatMessage,
  ChatState,
  ChatTool,
  ComputerQuality,
  Computer,
  ComputerStatus,
  Reaction,
  ReactionsChanged,
  Section,
  Room,
  RoomEvent,
  CurrentUser,
  DaemonInfo,
  PendingApproval,
  Settings,
  SavedDaemon,
  Rpc
} from './types'
import { draftAnswerError, forgetUnsentDraft } from '../../../web/src/lib/draft-card'
import type { EmailDraftAnswer, PluginAnswer } from '../../../web/src/lib/types'
export type { ChatRoute }
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))
/** A room opens at its latest events and pages back this many at a time. */
const ROOM_PAGE = 200
/** A bot posted on its own: its heartbeat, or a check-in on a daemon from before it. */
const postedOnItsOwn = (type: string) =>
  type === 'hexbot.heartbeat.message' || type === 'hexbot.checkins.message'

export function useMobile() {
  const [saved, setSaved] = useState<SavedDaemon[]>([])
  const [active, setActive] = useState<SavedDaemon | null>(null)
  const [connection, setConnection] = useState<MobileConnectionState>('offline')
  const [error, setError] = useState<string | null>(null)
  const [bots, setBots] = useState<Bot[]>([])
  const botsRef = useRef(bots)
  botsRef.current = bots
  const [rooms, setRooms] = useState<Room[]>([])
  const roomsRef = useRef(rooms)
  roomsRef.current = rooms
  const [sections, setSections] = useState<Section[]>([])
  const sectionsRef = useRef(sections)
  sectionsRef.current = sections
  const [info, setInfo] = useState<DaemonInfo | null>(null)
  const infoRef = useRef<DaemonInfo | null>(null)
  const refreshSequence = useRef(0)
  const [settings, setSettings] = useState<Settings | null>(null)
  /** The bots' shared computer, once something shows it; events keep it current. */
  const [computer, setComputer] = useState<ComputerStatus | null>(null)
  const [computers, setComputersState] = useState<Computer[] | null>(null)
  // Whether something showed the computers, so a change reads them again.
  const computersShown = useRef(false)
  /**
   * What the latest read of the computers said on this connection: the
   * Computer card trusts `computers` only once it says 'listed'. A reconnect
   * makes it 'loading' again, since grants may have changed meanwhile.
   */
  const [computersListed, setComputersListed] = useState<ComputersListed>('loading')
  // Each read's number: an answer to any but the latest, from before a
  // reconnect, or from a daemon the phone has since left may name a grant
  // since taken back, so it's dropped.
  const computersRead = useRef(latestReads()).current
  /**
   * What computer actions left the user to do (Forget on a computer that
   * didn't confirm), kept for this daemon until each one's OK, wherever the
   * user goes meanwhile; a daemon switch clears them.
   */
  const [computerNotices, setComputerNotices] = useState<string[]>([])
  const readComputers = async (): Promise<Computer[]> => {
    const current = session.current
    const isLatest = computersRead.start()
    const latest = () => session.current === current && isLatest()
    // Shown even when it fails, so a change reads it again.
    computersShown.current = true
    try {
      const result = await rpc<{ computers: Computer[] }>('hexbot.computers.list')
      if (latest()) {
        setComputersState(result.computers)
        setComputersListed('listed')
      }
      return result.computers
    } catch (e) {
      if (latest()) setComputersListed(unknownMethod(e) ? 'older' : { error: errorText(e) })
      throw e
    }
  }
  /** Counts connections, so what a daemon forgets on restart is asked for again. */
  const [connects, setConnects] = useState(0)
  /** Counts heartbeat changes, so an open heartbeat card reads its status again. */
  const [heartbeats, setHeartbeats] = useState(0)
  /** Counts Discord changes, so an open Discord page shows the connection as it is. */
  const [discordChanges, setDiscordChanges] = useState(0)
  const [user, setUser] = useState<CurrentUser | null>(null)
  const [route, setRoute] = useState<ChatRoute | null>(null)
  const [chat, setChat] = useState(emptyChat)
  const chatRef = useRef(chat)
  chatRef.current = chat
  // The open chat's reactions; a room or a thread between bots has none.
  const [reactions, setReactions] = useState(emptyReactions)
  const [loading, setLoading] = useState(false)
  // The chat whose history the transcript shows; until then it is still opening.
  const [readId, setReadIdRaw] = useState<null | string>(null)
  const readIdRef = useRef<null | string>(null)
  const setReadId = useCallback((id: null | string) => {
    readIdRef.current = id
    setReadIdRaw(id)
  }, [])
  const [hasEarlier, setHasEarlier] = useState(false)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const session = useRef<MobileSession | null>(null)
  const routeRef = useRef<ChatRoute | null>(null)
  /** Originating chats/rooms behind an opened bot-to-bot thread so Back returns there. */
  const returnStack = useRef<ChatRoute[]>([])
  const [hasThreadReturn, setHasThreadReturn] = useState(false)
  const setReturn = useCallback((next: ChatRoute[]) => {
    returnStack.current = next
    setHasThreadReturn(next.length > 0)
  }, [])
  /** A profile or settings page is over the open chat, so what lands there is unseen. */
  const chatCovered = useRef(false)
  const liveId = useRef<string | null>(null)
  // Live events for the open session's current in-flight turn, preserved across same-section reloads.
  const liveTurnEvents = useRef<{ sessionId: string; events: GatewayEvent[] } | null>(null)
  // A reconnect cannot restore an old owner row until canonical lookup succeeds.
  const ownerPending = useRef(false)
  const roomEvents = useRef<RoomEvent[]>([])
  const loadingEvents = useRef<GatewayEvent[] | null>(null)
  const loadingForSection = useRef<string | null>(null)
  const pendingSectionEvents = useRef<{ sectionId: string; events: GatewayEvent[] } | null>(null)
  // Completed asks awaiting stored history confirmation, scoped by section so superseding reloads keep them.
  const pendingAsksBySection = useRef(new Map<string, ChatTool[]>())
  // Live turns and completing asks for any room behind an open peer thread, kept current while away so Back preserves them.
  const roomLiveByRoom = useRef(
    new Map<string, { lastSeq: number; room: Room; state: ChatState }>()
  )
  // Live turn events for any section behind an open peer thread, kept current while away so Back preserves running asks.
  const sectionLiveBySection = useRef(
    new Map<string, { events: GatewayEvent[]; sessionId: string }>()
  )
  // Events captured while an uncached openThread looks up a section from another screen.
  const threadLookupCapture = useRef<{ events: GatewayEvent[] } | null>(null)
  const replayingRoom = useRef(false)
  const threadLoading = useRef(false)
  const openSequence = useRef(0)
  // Navigation starts before canonical lookup; history sync and thread lookups have their own sequences.
  const navigation = useRef(0)
  const threadLookupSequence = useRef(0)
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /**
   * Changes shown before the daemon answered, by `bot:<name>` or `room:<id>`.
   * Lists read before the change settled keep showing them; `settled` is the
   * refresh count when the daemon took it, so only a later list replaces them.
   */
  const shown = useRef(new Map<string, { patch: object; settled?: number; token: object }>())
  const mounted = useRef(true)
  /**
   * Files uploaded here for a message that was not sent, by session: their
   * ids, or `all` on a daemon from before `attachments.remove`.
   */
  const unsent = useRef(new Map<string, Set<string> | 'all'>())
  /** The live session whose running turn was half in the history when it loaded. */
  const straddling = useRef<string | null>(null)
  /** An older daemon's sections to pick a bot's chat from, while asked. */
  const [choosing, setChoosing] = useState<{
    bot: Bot
    choices: Section[]
    current: () => boolean
  } | null>(null)
  /** Each bot's chat on an older daemon, so the user is asked once while the app runs. */
  const picked = useRef(new Map<string, string>())
  /**
   * Each bot's chat as the daemon last named it on this connection. A tap
   * opens it at once and asks the daemon again, which may name another.
   */
  const named = useRef(new Map<string, Section>())
  /** Each chat's rows as last read on this daemon, so it shows at once (chat-cache.ts). */
  const held = useRef(new Map<string, HeldRows>())
  /** The daemon `held` came from; another one at the same address never sees it. */
  const heldFor = useRef<string | null>(null)
  /** Held rows of the daemon now connected, once `hexbot.info` named it. */
  const heldRows = (id: string) => {
    const daemon = infoRef.current?.install_id
    return daemon && daemon === heldFor.current ? held.current.get(id) : undefined
  }
  const keepRows = (id: string, rows: HeldRows) => {
    const daemon = infoRef.current?.install_id
    if (!daemon || daemon !== heldFor.current) return
    keep(held.current, id, rows)
  }
  /** What each bot looked like when its chat was last read ahead. */
  const prefetched = useRef(new Map<string, string>())
  const prefetchRef = useRef<(bots: Bot[]) => void>(() => {})
  /** Chats that changed on screen since their rows were held: never drawn from them. */
  const changed = useRef(new Set<string>())
  const leftRef = useRef<(id: string) => void>(() => {})
  const cancelNavigation = useCallback((keepCapture?: { events: GatewayEvent[] }) => {
    const left = routeRef.current
    if (left?.kind === 'section') leftRef.current(left.section.id)
    navigation.current++
    openSequence.current++
    loadingEvents.current = null
    loadingForSection.current = null
    pendingSectionEvents.current = null
    if (!keepCapture || threadLookupCapture.current !== keepCapture)
      threadLookupCapture.current = null
    threadLoading.current = false
    setChoosing(null)
    setLoading(false)
  }, [])
  const rpc: Rpc = useCallback(async (method, params = {}) => {
    const current = session.current
    if (!current || current.client.connectionState !== 'open')
      throw new Error('Connect to a daemon first.')
    let value: unknown
    try {
      value = await current.client.request(method, params)
    } catch (error) {
      if (
        (method === 'attachments.clear' || method.startsWith('hexbot.jobs.')) &&
        /unknown method|method not found|unsupported method|not implemented/i.test(errorText(error))
      )
        throw new Error('This daemon is older than this app. Update it on that computer.')
      throw error
    }
    if (session.current !== current)
      throw new Error('The selected daemon changed. Retry on this daemon.')
    return value as never
  }, [])
  // Forgotten when the lists reload or the daemon changes, so new keys and models show.
  const [models] = useState(() => modelLists(provider => providerModels(rpc, provider)))
  // Each clear hands out a new reader, so a model line already on screen loads again.
  const [listModels, setListModels] = useState(() => models.get)
  const clearModels = useCallback(() => {
    models.clear()
    setListModels(() => models.get)
  }, [models])
  // Messages sent from here name their files. Leaving takes back only the
  // ones uploaded here, so another app's draft in the same chat keeps its
  // files; it is best effort.
  const releaseStaged = useCallback((except?: string) => {
    const current = session.current
    for (const [sessionId, uploads] of unsent.current) {
      if (sessionId === except) continue
      unsent.current.delete(sessionId)
      if (current?.client.connectionState !== 'open') continue
      if (uploads === 'all') {
        void current.client.request('attachments.clear', { session_id: sessionId }).catch(() => {})
        continue
      }
      for (const id of uploads)
        void current.client
          .request('attachments.remove', { session_id: sessionId, id })
          .catch(() => {})
    }
  }, [])
  const leave = useCallback(() => {
    releaseStaged()
    cancelNavigation()
    roomLiveByRoom.current.clear()
    sectionLiveBySection.current.clear()
    setReturn([])
    routeRef.current = null
    liveId.current = null
    liveTurnEvents.current = null
    ownerPending.current = false
    setRoute(null)
    setHasEarlier(false)
  }, [releaseStaged, cancelNavigation, setReturn])
  const refresh = useCallback(
    async (reconnecting = false) => {
      const current = session.current
      clearModels()
      const sequence = ++refreshSequence.current
      const before = routeRef.current
      const [b, r, s, i, config, me] = await Promise.all([
        rpc<{ bots: Bot[] }>('hexbot.bots.list'),
        rpc<{ rooms: Room[] }>('hexbot.rooms.list', ROOMS_QUERY),
        listSections(rpc, SECTIONS_QUERY).then(sections => ({ sections })),
        rpc<DaemonInfo>('hexbot.info'),
        rpc<Settings>('hexbot.settings.get'),
        rpc<CurrentUser>('hexbot.users.me')
      ])
      if (!mounted.current || session.current !== current || sequence !== refreshSequence.current)
        return
      const previousInfo = infoRef.current
      if (
        previousInfo &&
        (previousInfo.one_chat !== i.one_chat || previousInfo.install_id !== i.install_id)
      ) {
        cancelNavigation()
        picked.current.clear()
        named.current.clear()
        held.current.clear()
        prefetched.current.clear()
      }
      infoRef.current = i
      // A reconnect may reach another daemon at the same address, which reuses no rows.
      if (heldFor.current !== (i.install_id ?? null)) {
        held.current.clear()
        prefetched.current.clear()
        changed.current.clear()
        heldFor.current = i.install_id ?? null
      }
      for (const [key, change] of shown.current)
        if (change.settled !== undefined && sequence > change.settled) shown.current.delete(key)
      const overlay = <T extends object>(key: string, row: T): T => {
        const change = shown.current.get(key)
        return change ? { ...row, ...change.patch } : row
      }
      b.bots = b.bots.map(bot => overlay(`bot:${bot.name}`, bot))
      r.rooms = r.rooms.map(room => overlay(`room:${room.id}`, room))
      setBots(b.bots)
      prefetchRef.current(b.bots)
      setRooms(r.rooms)
      setSections(s.sections)
      setInfo(i)
      setSettings(config)
      setUser(me)
      // The open conversation follows renames and edits, and closes once it is gone.
      // A route that changed while the lists loaded may be newer than them.
      if (!before || routeRef.current !== before) return i
      // Reconnect resolves owner chats before restoring history, even if the
      // old row survived migration. It may also have disappeared from this list.
      if (reconnecting && before.kind === 'section' && ownerChat(before.section)) return i
      const next = rebind(before, { bots: b.bots, rooms: r.rooms, sections: s.sections })
      if (!next) {
        leave()
        return i
      }
      routeRef.current = next
      setRoute(next)
      return i
    },
    [rpc, clearModels, leave, cancelNavigation]
  )
  /**
   * Shows a change to a bot or a room at once, such as a pin or a new name,
   * then asks the daemon. A refusal puts the old values back; the daemon's
   * change event brings the lists in line either way.
   */
  const change = useCallback(
    async <T>(
      target: { kind: 'bot'; name: string } | { kind: 'room'; id: string },
      patch: Partial<Bot> & Partial<Room>,
      work: () => Promise<T>
    ): Promise<T> => {
      const key = target.kind === 'bot' ? `bot:${target.name}` : `room:${target.id}`
      const token = {}
      const keys = Object.keys(patch) as (keyof typeof patch)[]
      let before: Record<string, unknown> | null = null
      const apply = <R extends object>(row: R, values: object) => ({ ...row, ...values })
      if (target.kind === 'bot') {
        const bot = botsRef.current.find(item => item.name === target.name)
        if (bot) before = Object.fromEntries(keys.map(k => [k, bot[k as keyof Bot]]))
        setBots(list => list.map(item => (item.name === target.name ? apply(item, patch) : item)))
      } else {
        const room = roomsRef.current.find(item => item.id === target.id)
        if (room) before = Object.fromEntries(keys.map(k => [k, room[k as keyof Room]]))
        setRooms(list => list.map(item => (item.id === target.id ? apply(item, patch) : item)))
      }
      shown.current.set(key, { patch: { ...shown.current.get(key)?.patch, ...patch }, token })
      try {
        const result = await work()
        const current = shown.current.get(key)
        if (current?.token === token) current.settled = refreshSequence.current
        return result
      } catch (error) {
        if (shown.current.get(key)?.token === token) {
          shown.current.delete(key)
          if (before) {
            const values = before
            if (target.kind === 'bot')
              setBots(list =>
                list.map(item => (item.name === target.name ? apply(item, values) : item))
              )
            else
              setRooms(list =>
                list.map(item => (item.id === target.id ? apply(item, values) : item))
              )
          }
        }
        throw error
      }
    },
    []
  )
  const syncRoom = useCallback(
    async (id: string) => {
      const sequence = ++openSequence.current
      loadingEvents.current = []
      const stale = () =>
        sequence !== openSequence.current ||
        routeRef.current?.kind !== 'room' ||
        routeRef.current.room.id !== id
      try {
        const [latest, { room }] = await Promise.all([
          rpc<{ events: RoomEvent[] }>('hexbot.rooms.log', {
            id,
            before_seq: Number.MAX_SAFE_INTEGER,
            limit: ROOM_PAGE
          }),
          rpc<{ room: Room }>('hexbot.rooms.get', { id })
        ])
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
        if (stale()) return
        roomEvents.current = events
        setHasEarlier((events[0]?.seq ?? 1) > 1)
        const buffered = loadingEvents.current ?? []
        loadingEvents.current = null
        const base = restoreRoom(room, events)
        const cached = roomLiveByRoom.current.get(id)
        roomLiveByRoom.current.delete(id)
        let mergedBase = base
        if (cached) {
          const settledBots = new Set(
            events
              .filter(
                e => e.seq > cached.lastSeq && (e.kind === 'message.bot' || e.kind === 'turn.failed')
              )
              .map(e => e.actor_id)
              .filter((bot): bot is string => Boolean(bot))
          )
          const turns = { ...base.turns }
          for (const [turnId, freshTurn] of Object.entries(turns)) {
            const previous = cached.state.turns[turnId]
            const sameTurn =
              previous?.roomTurnId && freshTurn.roomTurnId
                ? previous.roomTurnId === freshTurn.roomTurnId
                : !previous?.turnId || !freshTurn.turnId || previous.turnId === freshTurn.turnId
            if (previous && sameTurn && !settledBots.has(freshTurn.bot)) {
              const mergedAsked = mergeAsked(previous.asked, freshTurn.asked ?? [], 'prepend')
              const mergedTools = mergeAsked(previous.tools, freshTurn.tools, 'prepend')
              turns[turnId] = {
                ...freshTurn,
                ...previous,
                ...(freshTurn.turnId && { turnId: freshTurn.turnId }),
                ...(mergedAsked.length && { asked: mergedAsked }),
                ...(mergedTools.length && { tools: mergedTools })
              }
            }
          }
          const completingAsks: Record<string, ChatTool[]> = {}
          for (const [bot, asks] of Object.entries(cached.state.completingAsks ?? {})) {
            if (!settledBots.has(bot) && !Object.values(turns).some(t => t.bot === bot)) {
              completingAsks[bot] = asks
            }
          }
          mergedBase = roomChat({ ...base, turns, completingAsks })
        }
        setChat(mergedBase)
        routeRef.current = { kind: 'room', room }
        // Replayed approvals and events received during history loading go through the same reducer.
        replayingRoom.current = true
        try {
          for (const event of buffered) eventRef.current(event)
        } finally {
          replayingRoom.current = false
        }
        const updated = { kind: 'room' as const, room }
        routeRef.current = updated
        setRoute(updated)
        if (events.length)
          void rpc('hexbot.rooms.mark_read', { id, seq: events.at(-1)!.seq }).catch(() => {})
      } finally {
        if (sequence === openSequence.current) {
          loadingEvents.current = null
          loadingForSection.current = null
          pendingSectionEvents.current = null
        }
      }
    },
    [rpc]
  )
  type SectionOpenResult = HistoryRead & {
    section: Section
    busy?: boolean
    asks?: import('./types').RoomTurnAsk[]
    pending_clarify?: Record<string, unknown>
  }
  type PreloadedSection = {
    capture: { events: GatewayEvent[] }
    cursor?: string
    result?: SectionOpenResult
  }
  const syncChat = useCallback(
    async (initialFailure: string | null = null, preloaded?: PreloadedSection) => {
      const target = routeRef.current
      if (!target) return
      if (target.kind === 'room') return syncRoom(target.room.id)
      if (ownerPending.current) return
      let failure: string | null = initialFailure
      const sameLive = liveId.current
      const sameLoading = loadingForSection.current === target.section.id
      const priorBuffered = sameLoading ? (loadingEvents.current ?? []) : []
      const priorPending =
        !sameLive && pendingSectionEvents.current?.sectionId === target.section.id
          ? pendingSectionEvents.current.events
          : []
      const preloadedEvents = preloaded ? [...preloaded.capture.events] : []
      if (preloaded && threadLookupCapture.current === preloaded.capture)
        threadLookupCapture.current = null
      let reloadSeen = preloadedEvents.some(event => {
        const p = (event.payload ?? {}) as Record<string, unknown>
        return (
          event.type === 'hexbot.sections.changed' &&
          p.id === target.section.id &&
          p.reload === true
        )
      })
      const savedSection = sectionLiveBySection.current.get(target.section.id)
      sectionLiveBySection.current.delete(target.section.id)
      let carried: GatewayEvent[] = [
        ...(savedSection ? savedSection.events : []),
        ...(sameLive && liveTurnEvents.current?.sessionId === sameLive
          ? liveTurnEvents.current.events
          : []),
        ...priorPending,
        ...priorBuffered,
        ...preloadedEvents
      ]
      if (sameLive && carried.length)
        liveTurnEvents.current = {
          sessionId: sameLive,
          events: carried.filter(event => event.session_id === sameLive)
        }
      else if (!sameLive && carried.length)
        pendingSectionEvents.current = { sectionId: target.section.id, events: carried }
      for (let attempt = 0; ; attempt++) {
        const sequence = ++openSequence.current
        loadingEvents.current = []
        loadingForSection.current = target.section.id
        let retrying = false
        try {
          const kept = heldRows(target.section.id)
          const cursor = attempt === 0 && preloaded?.result ? preloaded.cursor : cursorFor(kept)
          const result =
            attempt === 0 && preloaded?.result
              ? preloaded.result
              : await rpc<SectionOpenResult>('hexbot.sections.open', {
                  id: target.section.id,
                  ...(cursor && { history_cursor: cursor })
                })
          if (
            sequence !== openSequence.current ||
            routeRef.current?.kind !== 'section' ||
            routeRef.current.section.id !== target.section.id
          )
            return
          const restoredLiveId = result.section.live_session_id
          if (!restoredLiveId) throw new Error('Open this conversation again before sending.')
          const rows = afterRead(kept, result, cursor, Date.now())
          setHasEarlier(false)
          const busy =
            typeof result.busy === 'boolean'
              ? result.busy
              : (await rpc<{ status: string }>('session.status', { session_id: restoredLiveId }))
                  .status === 'working'
          if (sequence !== openSequence.current) return
          const messages = historyMessages(rows.rows, target.section.peer_bot)
          const pendingTools = busy
            ? pendingTurnTools(rows.rows, target.section.peer_bot, result.asks)
            : []
          const snapshotTurnId =
            messages.findLast(m => m.turnId)?.turnId ?? pendingTools.findLast(t => t.turnId)?.turnId
          let snapshot: ChatState = {
            ...emptyChat(),
            busy,
            messages,
            ...(pendingTools.length && { tools: pendingTools }),
            ...(snapshotTurnId && { turnId: snapshotTurnId }),
            // A reply already running when the chat opened lands after these rows.
            ...(busy && { turnAt: messages.length }),
            ...(failure && !busy && { error: failure })
          }
          // The snapshot goes first: an answer or Stop that arrived while it loaded is newer.
          if (result.pending_clarify)
            snapshot = reduceChat(snapshot, {
              type: 'clarify.request',
              session_id: restoredLiveId,
              payload: result.pending_clarify
            })
          const sessionEvents = [...carried, ...(loadingEvents.current ?? [])].filter(
            event => event.session_id === restoredLiveId
          )
          const tailAfterComplete = (events: GatewayEvent[]) => {
            for (let i = events.length - 1; i >= 0; i--) {
              if (events[i]?.type === 'message.complete' || events[i]?.type === 'error')
                return events.slice(i + 1)
            }
            return events
          }
          const replay = replayChat(snapshot, sessionEvents)
          const replayedAsks = Object.values(replay.state.completingAsks ?? {}).flat()
          if (replayedAsks.length) {
            const existing = pendingAsksBySection.current.get(target.section.id) ?? []
            pendingAsksBySection.current.set(
              target.section.id,
              mergeTurnTools(existing, replayedAsks)
            )
          }
          failure = replay.state.error
          // A turn finished or a reload landed while the history loaded; read it again so its
          // replies/questions show once, carrying forward live events from any newer in-flight turn.
          if ((replay.reread || reloadSeen) && attempt < 2) {
            reloadSeen = false
            carried = tailAfterComplete(sessionEvents)
            liveTurnEvents.current = carried.length
              ? { sessionId: restoredLiveId, events: carried }
              : null
            pendingSectionEvents.current = carried.length
              ? { sectionId: target.section.id, events: carried }
              : null
            retrying = true
            continue
          }
        straddling.current = replay.state.busy ? restoredLiveId : null
        liveTurnEvents.current = replay.state.busy
          ? { sessionId: restoredLiveId, events: tailAfterComplete(sessionEvents) }
          : null
        let restored = { ...replay.state, error: failure }
        // Heartbeat messages that arrived while it loaded carry no session; match the section.
        for (const event of loadingEvents.current ?? []) {
          const p = (event.payload ?? {}) as Record<string, unknown>
          if (
            postedOnItsOwn(event.type) &&
            p.section_id === target.section.id &&
            typeof p.row_id === 'string' &&
            typeof p.text === 'string'
          )
            restored = heartbeatMessage(restored, p.row_id, p.text)
        }
        // What arrived during the read is on screen but not in its rows.
        const missed = (loadingEvents.current ?? []).some(
          event =>
            event.session_id === restoredLiveId ||
            (postedOnItsOwn(event.type) &&
              (event.payload as Record<string, unknown> | undefined)?.section_id === target.section.id)
        )
        loadingEvents.current = null
        loadingForSection.current = null
        pendingSectionEvents.current = null
        keepRows(target.section.id, rows)
        if (missed) changed.current.add(target.section.id)
        else changed.current.delete(target.section.id)
        liveId.current = restoredLiveId
        setChat(previous => {
          const sameSection = readIdRef.current === target.section.id || sameLive === restoredLiveId
          const priorAsks = sameSection
            ? [
                ...(previous.completingAsks?.[target.section.bot] ?? []),
                ...(previous.completingAsks?.[''] ?? [])
              ]
            : []
          const sectionPending = pendingAsksBySection.current.get(target.section.id) ?? []
          const remaining = unconfirmedTurnTools(
            mergeTurnTools(priorAsks, sectionPending),
            restored.messages
          )
          if (remaining.length) pendingAsksBySection.current.set(target.section.id, remaining)
          else pendingAsksBySection.current.delete(target.section.id)
          return {
            ...restored,
            completingAsks: remaining.length ? { [target.section.bot]: remaining } : {}
          }
        })
        setReadId(target.section.id)
        // A daemon from before one chat names no purpose; keep the one the list marked.
        const section =
          'purpose' in result.section
            ? result.section
            : { ...result.section, purpose: target.section.purpose }
        const newRoute: ChatRoute = { ...target, section }
        routeRef.current = newRoute
        setRoute(newRoute)
        void rpc('hexbot.sections.mark_read', { id: target.section.id }).catch(() => {})
        return
        } finally {
          if (!retrying && sequence === openSequence.current) {
            loadingEvents.current = null
            loadingForSection.current = null
            pendingSectionEvents.current = null
          }
        }
    }
  }, [rpc, syncRoom])
  const syncChatRef = useRef(syncChat)
  syncChatRef.current = syncChat
  /**
   * Every bot's chat read ahead without starting the bot, two at a time, the
   * primary bot first; after that only a bot that changed. The open chat is
   * left to its own reads and events.
   */
  const prefetch = useCallback(
    (list: Bot[]) => {
      const current = session.current
      const info = infoRef.current
      if (!info?.section_history || !info.one_chat || current?.client.connectionState !== 'open')
        return
      const holds = (bot: Bot) => {
        const chat = named.current.get(bot.name)
        return Boolean(chat && heldRows(chat.id))
      }
      const queue = readAhead(list, holds).filter(
        bot => prefetched.current.get(bot.name) !== fingerprint(bot)
      )
      const rank = new Map(prefetchOrder(list).map((bot, index) => [bot.name, index]))
      // Marked now, so a refresh while this runs does not read them twice.
      for (const bot of queue) prefetched.current.set(bot.name, fingerprint(bot))
      const stale = () => !mounted.current || session.current !== current
      const open = (id: string) =>
        routeRef.current?.kind === 'section' && routeRef.current.section.id === id
      const worker = async () => {
        for (let bot = queue.shift(); bot && !stale(); bot = queue.shift()) {
          try {
            const chat =
              named.current.get(bot.name) ??
              ((await botChat(rpc, bot.name, true, picked.current)) as { section: Section }).section
            if (stale()) return
            named.current.set(bot.name, chat)
            if (open(chat.id)) continue
            const kept = heldRows(chat.id)
            const cursor = cursorFor(kept, true)
            const read = await rpc<HistoryRead>('hexbot.sections.history', {
              id: chat.id,
              ...(cursor && { history_cursor: cursor })
            })
            // An open read, or the chat opening, holds newer rows than these.
            if (stale() || open(chat.id) || heldRows(chat.id) !== kept) continue
            const touched = kept?.touched ?? -(rank.get(bot.name) ?? 0)
            keepRows(chat.id, afterRead(kept, read, cursor, touched))
          } catch {
            // Read again on the next refresh; until then the chat loads when opened.
            prefetched.current.delete(bot.name)
          }
        }
      }
      void Promise.all([worker(), worker()])
    },
    [rpc]
  )
  prefetchRef.current = prefetch
  /** A chat left after it changed on screen reads what it missed, so it shows right next time. */
  leftRef.current = (id: string) => {
    if (!changed.current.has(id)) return
    const current = session.current
    const kept = heldRows(id)
    if (!infoRef.current?.section_history || !kept) {
      held.current.delete(id)
      return
    }
    const cursor = cursorFor(kept, true)
    void rpc<HistoryRead>('hexbot.sections.history', { id, ...(cursor && { history_cursor: cursor }) })
      .then(read => {
        const open = routeRef.current?.kind === 'section' && routeRef.current.section.id === id
        // An open of it since holds newer rows than these.
        if (session.current !== current || open || heldRows(id) !== kept) return
        keepRows(id, afterRead(kept, read, cursor, kept.touched))
        changed.current.delete(id)
      })
      .catch(() => undefined)
  }
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh
  /** Marks the open chat read while it is on screen: the app in front, no page over it. */
  const readOpenChat = useCallback(() => {
    const target = routeRef.current
    if (target?.kind !== 'section' || chatCovered.current || AppState.currentState !== 'active')
      return
    void rpc('hexbot.sections.mark_read', { id: target.section.id }).catch(() => {})
  }, [rpc])
  /** A page went over the open chat, or came off it; what landed meanwhile is seen now. */
  const setChatCovered = useCallback(
    (covered: boolean) => {
      if (chatCovered.current === covered) return
      chatCovered.current = covered
      if (covered) return
      readOpenChat()
      const target = routeRef.current
      const seq = roomEvents.current.at(-1)?.seq
      if (target?.kind === 'room' && seq)
        void rpc('hexbot.rooms.mark_read', { id: target.room.id, seq }).catch(() => {})
    },
    [readOpenChat, rpc]
  )
  const readRef = useRef(readOpenChat)
  readRef.current = readOpenChat
  const onEvent = useCallback(
    (event: GatewayEvent) => {
      if (threadLookupCapture.current && !replayingRoom.current)
        threadLookupCapture.current.events.push(event)
      const target = routeRef.current
      const p = (event.payload ?? {}) as Record<string, unknown>
      // A card settled anywhere drops its kept edits, whatever is on screen.
      if (
        (event.type === 'approval.resolved' || event.type === 'approval.expire') &&
        typeof p.request_id === 'string'
      )
        forgetUnsentDraft(p.request_id)
      // A computer came online, went away or changed bots: read them again if shown.
      if (event.type === 'hexbot.computers.changed') {
        if (computersShown.current) void readComputers().catch(() => {})
        return
      }
      // Sent on every bot action there; it changes nothing else.
      if (event.type === 'hexbot.computer.changed') {
        setComputer(current =>
          current ? { ...current, ...(p as Partial<ComputerStatus>) } : current
        )
        return
      }
      // One message's reactions changed; nothing in the lists moves.
      if (event.type === 'hexbot.reactions.changed') {
        if (
          target?.kind === 'section' &&
          p.section_id === target.section.id &&
          typeof p.message_id === 'string' &&
          Array.isArray(p.reactions)
        )
          setReactions(current => applyReactions(current, p as unknown as ReactionsChanged))
        return
      }
      if (event.type === 'hexbot.heartbeat.changed') setHeartbeats(n => n + 1)
      if (event.type === 'hexbot.discord.changed') setDiscordChanges(n => n + 1)
      if (event.type.endsWith('.changed')) {
        if (!refreshTimer.current)
          refreshTimer.current = setTimeout(() => {
            refreshTimer.current = null
            void refreshRef.current().catch(e => setError(errorText(e)))
          }, 200)
      }
      // A dream report landed in this chat; read it again.
      if (
        event.type === 'hexbot.sections.changed' &&
        target?.kind === 'section' &&
        target.section.id === p.id &&
        p.reload === true
      ) {
        void syncChatRef.current().catch(e => setError(errorText(e)))
        return
      }
      // Keep live turns for any room behind an open peer thread up to date while away.
      if (!replayingRoom.current && roomLiveByRoom.current.size > 0) {
        const botName = (id: string) => botsRef.current.find(b => b.name === id)?.display_name || id
        for (const [roomId, entry] of roomLiveByRoom.current.entries()) {
          if (target?.kind === 'room' && target.room.id === roomId) continue
          const nextState = reduceRoom(entry.state, event, entry.room, botName)
          const nextSeq =
            event.type === 'hexbot.rooms.event' &&
            p.room_id === roomId &&
            typeof (p.event as RoomEvent | undefined)?.seq === 'number'
              ? Math.max(entry.lastSeq, (p.event as RoomEvent).seq)
              : entry.lastSeq
          if (nextState !== entry.state || nextSeq !== entry.lastSeq) {
            roomLiveByRoom.current.set(roomId, { ...entry, state: nextState, lastSeq: nextSeq })
          }
        }
      }
      // Keep live turn events for any section behind an open peer thread up to date while away.
      if (event.session_id && sectionLiveBySection.current.size > 0) {
        for (const [sectionId, entry] of sectionLiveBySection.current.entries()) {
          if (target?.kind === 'section' && target.section.id === sectionId) continue
          if (event.session_id !== entry.sessionId) continue
          const nextEvents =
            event.type === 'message.start' && bufferedRunEnded(entry.events)
              ? [event]
              : [...entry.events, event]
          sectionLiveBySection.current.set(sectionId, { ...entry, events: nextEvents })
        }
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
          // Read as it lands, unless a page or another chat covers the room.
          if (!chatCovered.current)
            void rpc('hexbot.rooms.mark_read', { id: target.room.id, seq: incoming.seq }).catch(
              () => {}
            )
        }
        setChat(c =>
          reduceRoom(
            c,
            event,
            target.room,
            id => botsRef.current.find(b => b.name === id)?.display_name || id
          )
        )
      } else {
        if (postedOnItsOwn(event.type)) {
          if (
            p.section_id === target.section.id &&
            typeof p.row_id === 'string' &&
            typeof p.text === 'string'
          ) {
            const [id, text] = [p.row_id, p.text]
            changed.current.add(target.section.id)
            setChat(c => heartbeatMessage(c, id, text))
            // Seen as it arrived, so it is read.
            void rpc('hexbot.sections.mark_read', { id: target.section.id }).catch(() => {})
          }
          return
        }
        if (!event.session_id || event.session_id !== liveId.current) return
        changed.current.add(target.section.id)
        if (event.type === 'message.start') {
          if (liveTurnEvents.current?.sessionId === event.session_id) {
            liveTurnEvents.current.events.push(event)
          } else {
            liveTurnEvents.current = { sessionId: event.session_id, events: [event] }
          }
        } else if (event.type === 'message.complete' || event.type === 'error') {
          liveTurnEvents.current = null
        } else if (liveTurnEvents.current?.sessionId === event.session_id) {
          liveTurnEvents.current.events.push(event)
        } else {
          liveTurnEvents.current = { sessionId: event.session_id, events: [event] }
        }
        // Read as it lands on screen, so the daemon does not wake this phone about it.
        if (event.type === 'message.complete') readOpenChat()
        if (
          event.type === 'message.complete' &&
          (straddling.current === event.session_id || Boolean(target.section.peer_bot))
        ) {
          // Part of this turn was already in the history, or an out-of-band peer question
          // preceded this reply; re-read history so both question and reply stay separated,
          // keeping completed ask chips visible under the same key until history confirms them.
          straddling.current = null
          const failed = typeof p.error === 'string' ? p.error : null
          setChat(c => {
            const turnId =
              (typeof p.turn_id === 'string' ? p.turn_id : undefined) ??
              c.turnId ??
              c.tools.find(t => t.turnId)?.turnId
            const freshAfter =
              !turnId && c.startedFresh && c.turnAt !== undefined ? c.turnAt : undefined
            const freshExchange = !turnId && c.startedFresh ? c.freshExchange : undefined
            const failedTurn = isFailedCompletion(p, c.error)
            const finishedAsks = settleTurnTools(
              c.tools.filter(t => t.name === 'message_bot'),
              failedTurn,
              turnId,
              freshAfter,
              freshExchange
            )
            if (finishedAsks.length) {
              const sectionPending = pendingAsksBySection.current.get(target.section.id) ?? []
              pendingAsksBySection.current.set(
                target.section.id,
                mergeTurnTools(sectionPending, finishedAsks)
              )
            }
            const existingAsks = c.completingAsks?.[target.section.bot] ?? []
            const completingAsks = finishedAsks.length
              ? {
                  ...(c.completingAsks ?? {}),
                  [target.section.bot]: mergeTurnTools(existingAsks, finishedAsks)
                }
              : c.completingAsks
            return {
              ...reduceChat(c, event),
              messages: c.messages,
              ...(completingAsks && { completingAsks })
            }
          })
          void syncChatRef.current(failed).catch(e => setError(errorText(e)))
          return
        }
        setChat(c => reduceChat(c, event))
      }
    },
    [rpc, readOpenChat]
  )
  // A bot's own chat keeps reactions, on a daemon that has them. Read once its
  // history shows and after every reconnect; another chat starts with none.
  const reactIn =
    info?.reactions && route?.kind === 'section' && ownerChat(route.section) && readId === route.section.id
      ? route.section.id
      : null
  useEffect(() => setReactions(emptyReactions()), [reactIn])
  useEffect(() => {
    if (!reactIn) return
    let stale = false
    rpc<{ reactions: Reaction[] }>('hexbot.reactions.list', { section_id: reactIn }).then(
      result => {
        if (!stale) setReactions(indexReactions(result.reactions ?? []))
      },
      // Reactions are an extra: a chat that cannot read them shows none.
      () => {}
    )
    return () => {
      stale = true
    }
  }, [reactIn, connects, rpc])
  const reactionsRef = useRef(reactions)
  reactionsRef.current = reactions
  /** Leaves your emoji on a bot's message; the same emoji again takes it back. */
  const react = useCallback(
    async (messageId: string, emoji: string) => {
      if (!reactIn) return
      // Shown where you put it while the daemon catches up.
      const before = reactionsRef.current
      const toggled = toggleReaction(before, messageId, emoji)
      setReactions(toggled.state)
      try {
        const changed = await rpc<ReactionsChanged>('hexbot.reactions.set', {
          section_id: reactIn,
          message_id: messageId,
          emoji: toggled.emoji
        })
        setReactions(current => applyReactions(current, changed))
      } catch {
        // Refused, such as a message the chat no longer shows: that message back as it was.
        setReactions(current => restoreReactions(current, before, messageId))
      }
    },
    [reactIn, rpc]
  )
  const acknowledgedApprovals = useRef(new Set<string>())
  useEffect(() => {
    const visible = new Set<string>()
    for (const pending of chat.approvals) {
      if (pending.decision) continue
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
      cancelNavigation()
      const token = suppliedToken ?? (await loadToken(daemon.id))
      if (!token) throw new Error('This saved connection has no credential. Pair it again.')
      releaseStaged()
      session.current?.stop()
      setError(null)
      setActive(daemon)
      setComputer(null)
      setComputersState(null)
      setComputerNotices([])
      computersRead.drop()
      setComputersListed('loading')
      computersShown.current = false
      setBots([])
      setRooms([])
      setSections([])
      setInfo(null)
      infoRef.current = null
      refreshSequence.current++
      setSettings(null)
      setUser(null)
      setChoosing(null)
      picked.current.clear()
      named.current.clear()
      held.current.clear()
      prefetched.current.clear()
      pendingAsksBySection.current.clear()
      roomLiveByRoom.current.clear()
      sectionLiveBySection.current.clear()
      openSequence.current++
      loadingEvents.current = null
      routeRef.current = null
      liveId.current = null
      liveTurnEvents.current = null
      setReturn([])
      setRoute(null)
      setChat(emptyChat())
      setReadId(null)
      const next = new MobileSession(
        daemon,
        token,
        (state, failure) => {
          if (session.current !== next || !mounted.current) return
          setConnection(state)
          if (failure) setError(failure.message)
          if (state === 'connected') setError(null)
          if (state === 'revoked') {
            leave()
            void forgetDaemon(daemon.id).then(loadDaemons).then(setSaved)
            setActive(null)
            setRoute(null)
            routeRef.current = null
          }
        },
        async () => {
          if (session.current !== next || !mounted.current) return
          setConnects(count => count + 1)
          // Grants may have changed while away: the list waits for this connection's read.
          computersRead.drop()
          setComputersListed('loading')
          // A reconnect can reach an upgraded daemon at the same address, and missed
          // sessionless room/section transitions while offline make background caches stale.
          cancelNavigation()
          roomLiveByRoom.current.clear()
          sectionLiveBySection.current.clear()
          named.current.clear()
          prefetched.current.clear()
          const generation = navigation.current
          const before = routeRef.current
          ownerPending.current = before?.kind === 'section' && ownerChat(before.section)
          const current = () =>
            mounted.current && session.current === next && navigation.current === generation
          const previousInfo = infoRef.current
          infoRef.current = null
          setInfo(null)
          liveId.current = null
          liveTurnEvents.current = null
          setChat(emptyChat())
          setReadId(null)
          setLoading(true)
          try {
            const refreshing = refreshRef.current(true)
            const sequence = refreshSequence.current
            const refreshed = await refreshing
            if (!current()) return
            if (!refreshed || sequence !== refreshSequence.current) {
              setError('Daemon information changed. Retry opening the conversation.')
              return
            }
            if (refreshed.one_chat === true || previousInfo?.install_id !== refreshed.install_id)
              picked.current.clear()
            if (before?.kind === 'section' && ownerChat(before.section)) {
              // Old daemons keep their explicit remembered choice. Modern ones
              // must name the canonical owner chat before any history is opened.
              await openSectionRef.current(before.bot)
            } else {
              await syncChatRef.current()
            }
            void registerPush(rpc, daemon.deviceId).catch(() => undefined)
          } catch (error) {
            if (current()) setError(errorText(error))
            throw error
          } finally {
            if (current()) setLoading(false)
          }
        },
        onEvent
      )
      session.current = next
      clearModels()
      await selectDaemon(daemon.id)
      await next.connect()
    },
    [onEvent, releaseStaged, clearModels, cancelNavigation, leave, setReturn]
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
      if (state === 'active') {
        void session.current?.connect().catch(e => setError(errorText(e)))
        readRef.current()
      }
      else if (state === 'background') session.current?.suspend()
    })
    return () => {
      mounted.current = false
      navigation.current++
      openSequence.current++
      loadingEvents.current = null
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
  const openSection = async (
    bot: Bot,
    section?: Section,
    keepReturn = false,
    originOverride?: ChatRoute | null,
    preloaded?: PreloadedSection
  ) => {
    // Capture any in-flight or buffered events from the originating section BEFORE
    // cancelNavigation clears loadingEvents / pendingSectionEvents (e.g. tapping into
    // a peer thread while the originating chat is refreshing).
    const departingRoute = originOverride !== undefined ? originOverride : routeRef.current
    const departingSection = departingRoute?.kind === 'section' ? departingRoute.section : null
    const departingSectionId = departingSection?.id ?? null
    const departingLiveId =
      departingSection &&
      routeRef.current?.kind === 'section' &&
      routeRef.current.section.id === departingSection.id
        ? (liveId.current ?? departingSection.live_session_id ?? null)
        : (departingSection?.live_session_id ?? null)
    const departingEvents: GatewayEvent[] = []
    if (departingSectionId) {
      const seenEvents = new Set<GatewayEvent>()
      const addEvents = (list: readonly GatewayEvent[]) => {
        for (const ev of list) {
          if (!seenEvents.has(ev)) {
            seenEvents.add(ev)
            departingEvents.push(ev)
          }
        }
      }
      const currentLive = liveTurnEvents.current
      if (departingLiveId && currentLive && currentLive.sessionId === departingLiveId) {
        addEvents(currentLive.events)
      }
      if (pendingSectionEvents.current?.sectionId === departingSectionId) {
        addEvents(pendingSectionEvents.current.events)
      }
      if (loadingForSection.current === departingSectionId && loadingEvents.current) {
        addEvents(loadingEvents.current)
      }
      if (preloaded?.capture.events.length) {
        addEvents(preloaded.capture.events)
      }
    }
    cancelNavigation(preloaded?.capture)
    const generation = navigation.current
    const current = session.current
    const stale = () =>
      !mounted.current || generation !== navigation.current || session.current !== current
    // Guard each boundary too: an abandoned old-daemon list must not create
    // or unarchive a section, or change its remembered pick, after it returns.
    const lookup: Rpc = async (method, params) => {
      if (stale()) throw new Error('Navigation cancelled.')
      const result = await rpc(method, params)
      if (stale()) throw new Error('Navigation cancelled.')
      return result as never
    }
    setLoading(true)
    setError(null)
    try {
      const oneChat =
        (infoRef.current ?? (await lookup<DaemonInfo>('hexbot.info'))).one_chat === true
      const known = oneChat && !section ? named.current.get(bot.name) : undefined
      const found = known
        ? { section: known }
        : await botChat(lookup, bot.name, oneChat, picked.current, section)
      if (stale()) return
      if (oneChat && !section && 'section' in found) named.current.set(bot.name, found.section)
      if (known)
        void botChat(lookup, bot.name, oneChat, picked.current)
          .then(checked => {
            if (stale() || !('section' in checked) || checked.section.id === known.id) return
            named.current.set(bot.name, checked.section)
            void openSectionRef.current(bot)
          })
          .catch(() => undefined)
      if ('choices' in found) {
        setChoosing({ bot, choices: found.choices, current: () => !stale() })
        return
      }
      const selected = found.section
      const here = originOverride !== undefined ? originOverride : routeRef.current
      if (routeRef.current?.kind !== 'section' || routeRef.current.section.id !== selected.id)
        releaseStaged()
      if (!keepReturn) {
        if (
          selected.peer_bot &&
          here &&
          (here.kind !== 'section' || here.section.id !== selected.id)
        ) {
          if (here.kind === 'room') {
            roomLiveByRoom.current.set(here.room.id, {
              lastSeq: roomEvents.current.at(-1)?.seq ?? 0,
              room: here.room,
              state: chatRef.current
            })
          } else {
            const originSessionId =
              departingLiveId ??
              liveId.current ??
              here.section.live_session_id ??
              departingEvents.find(e => typeof e.session_id === 'string')?.session_id ??
              null
            if (originSessionId) {
              const sessionScoped = departingEvents.filter(e => e.session_id === originSessionId)
              sectionLiveBySection.current.set(here.section.id, {
                events: latestRunEvents(sessionScoped),
                sessionId: originSessionId
              })
            }
          }
          setReturn([...returnStack.current, here])
        } else if (!selected.peer_bot) {
          roomLiveByRoom.current.clear()
          sectionLiveBySection.current.clear()
          setReturn([])
        }
      }
      const target: ChatRoute = { kind: 'section', section: selected, bot }
      routeRef.current = target
      setRoute(target)
      ownerPending.current = false
      liveId.current = null
      liveTurnEvents.current = null
      // What is held shows now; sending waits for the read that makes the chat live.
      const kept = changed.current.has(selected.id) ? undefined : heldRows(selected.id)
      setChat(
        kept
          ? { ...emptyChat(), messages: historyMessages(kept.rows, selected.peer_bot) }
          : emptyChat()
      )
      setReadId(null)
      await syncChat(null, preloaded)
    } catch (e) {
      if (!stale()) setError(errorText(e))
    } finally {
      if (!stale()) setLoading(false)
    }
  }
  const openSectionRef = useRef(openSection)
  openSectionRef.current = openSection
  /** Opens the section picked on an older daemon, or nothing when none is. */
  const choose = (section: Section | null) => {
    const asked = choosing
    if (asked && !asked.current()) return
    cancelNavigation()
    if (asked && section) void openSection(asked.bot, section)
  }
  const openRoom = async (room: Room, keepReturn = false) => {
    cancelNavigation()
    const generation = navigation.current
    const stale = () => !mounted.current || generation !== navigation.current
    if (!keepReturn) {
      roomLiveByRoom.current.clear()
      sectionLiveBySection.current.clear()
      setReturn([])
    }
    const cachedRoom = keepReturn ? roomLiveByRoom.current.get(room.id) : undefined
    setLoading(true)
    setError(null)
    releaseStaged()
    roomEvents.current = []
    setHasEarlier(false)
    routeRef.current = { kind: 'room', room }
    setRoute(routeRef.current)
    setChat(cachedRoom ? cachedRoom.state : emptyChat())
    setReadId(null)
    try {
      await syncRoom(room.id)
    } catch (e) {
      if (!stale()) setError(errorText(e))
    } finally {
      if (!stale()) setLoading(false)
    }
  }
  const openRoomRef = useRef(openRoom)
  openRoomRef.current = openRoom
  /**
   * Opens the private conversation in which `peer` asked `botName`.
   * Guarded by the navigation generation so a delayed lookup never overrides
   * a newer room or chat choice. An explicit `sectionId` is honored directly
   * (including archived history) without falling back to a newer thread or
   * the recipient's own chat.
   */
  const openThread = async (
    botName: string,
    peer: string,
    options?: { allowReverse?: boolean; sectionId?: string }
  ) => {
    // Snapshot navigation generation without advancing it so a failed lookup never cancels
    // the originating view's in-flight load or drops its buffered events/approvals.
    const lookupSeq = ++threadLookupSequence.current
    const generation = navigation.current
    const current = session.current
    const origin = routeRef.current
    const stale = () =>
      !mounted.current ||
      lookupSeq !== threadLookupSequence.current ||
      generation !== navigation.current ||
      session.current !== current
    const lookup: Rpc = async (method, params) => {
      if (stale()) throw new Error('Navigation cancelled.')
      const result = await rpc(method, params)
      if (stale()) throw new Error('Navigation cancelled.')
      return result as never
    }
    const capture = { events: [] as GatewayEvent[] }
    threadLookupCapture.current = capture
    const releaseCapture = () => {
      if (threadLookupCapture.current === capture) threadLookupCapture.current = null
    }
    const openFound = async (section: Section, preloaded?: PreloadedSection) => {
      const owner = botsRef.current.find(b => b.name === section.bot)
      if (!owner) {
        releaseCapture()
        if (!stale()) setError('This conversation is no longer available.')
        return
      }
      threadLoading.current = false
      await openSectionRef.current(owner, section, false, origin, preloaded)
    }
    // Preload any target thread before switching routes so a deleted or missing thread (e.g. 4204)
    // leaves the originating chat/room and its pending approvals untouched.
    const openById = async (id: string) => {
      threadLoading.current = true
      setLoading(true)
      setError(null)
      try {
        const cursor = cursorFor(heldRows(id))
        const opened = await lookup<SectionOpenResult>('hexbot.sections.open', {
          id,
          ...(cursor && { history_cursor: cursor })
        })
        if (stale()) return
        await openFound(opened.section, { capture, cursor, result: opened })
      } catch {
        if (!stale()) setError('This conversation is no longer available.')
      }
    }
    try {
      if (options?.sectionId) {
        await openById(options.sectionId)
        return
      }
      const between = (askedBot: string, asker: string) =>
        sectionsRef.current.find(
          s => s.bot === askedBot && s.peer_bot === asker && !s.archived_at
        )
      const asked = async (askedBot: string, asker: string) => {
        const found = await lookup<{ section: Section | null }>('hexbot.sections.thread', {
          bot: askedBot,
          peer: asker
        })
        return found.section
      }
      let found: Section | null = between(botName, peer) ?? null
      if (!found) {
        found = await asked(botName, peer)
        if (stale()) return
      }
      if (!found && options?.allowReverse) {
        found = between(peer, botName) ?? (await asked(peer, botName))
        if (stale()) return
      }
      if (found) {
        await openById(found.id)
        return
      }
      if (options?.allowReverse) {
        const owner = botsRef.current.find(b => b.name === botName)
        if (owner) {
          threadLoading.current = false
          await openSectionRef.current(owner, undefined, false, origin)
        }
        return
      }
      setError('This conversation is not available yet.')
    } catch (e) {
      if (!stale()) setError(errorText(e))
    } finally {
      releaseCapture()
      if (!stale() && threadLoading.current) {
        threadLoading.current = false
        setLoading(false)
      }
    }
  }
  const back = useCallback(() => {
    const here = routeRef.current
    if (here?.kind === 'section' && here.section.peer_bot && returnStack.current.length > 0) {
      const previous = returnStack.current.at(-1)!
      setReturn(returnStack.current.slice(0, -1))
      if (previous.kind === 'room') {
        const latestRoom = roomsRef.current.find(r => r.id === previous.room.id) ?? previous.room
        void openRoomRef.current(latestRoom, true)
      } else {
        const latestBot = botsRef.current.find(b => b.name === previous.bot.name) ?? previous.bot
        const latestSection =
          sectionsRef.current.find(s => s.id === previous.section.id) ?? previous.section
        void openSectionRef.current(latestBot, latestSection, true)
      }
      return
    }
    leave()
  }, [leave, setReturn])
  /**
   * `attachments` are the ids of the files uploaded for this message; the
   * daemon sends only those. Undefined leaves every staged file attached, for
   * daemons that do not give uploads an id.
   */
  const send = async (
    input: string,
    hasAttachments = false,
    attachments?: string[],
    files?: ChatMessage['attachments']
  ) => {
    const text = attachmentPrompt(input, hasAttachments)
    const target = routeRef.current
    if (!target || !text) throw new Error('Enter a message or attach a file.')
    if (target.kind === 'section' && (target.section.peer_bot || !liveId.current))
      throw new Error('Open your chat before sending.')
    const messageId = Crypto.randomUUID()
    // A daemon with transcript identity keys the message, so Recall can name it.
    const inputId = infoRef.current?.transcript_identity ? messageId : undefined
    setChat(c => ({
      ...c,
      busy: true,
      error: null,
      messages:
        target.kind === 'section'
          ? [
              ...c.messages,
              {
                id: messageId,
                role: 'user',
                text,
                inputId,
                createdAt: Date.now(),
                ...(files?.length && { attachments: files })
              }
            ]
          : c.messages
    }))
    try {
      if (target.kind === 'room') await rpc('hexbot.rooms.send', { id: target.room.id, text })
      else {
        if (!liveId.current) throw new Error('Open this thread again before sending.')
        const sessionId = liveId.current
        await rpc('prompt.submit', {
          session_id: sessionId,
          text,
          attachments,
          // A reply in progress stops first, so this message goes next.
          interrupt: true,
          ...(inputId && { input_id: inputId })
        })
        // The message took the files it names; any others staged here stay tracked.
        const uploads = unsent.current.get(sessionId)
        if (attachments && uploads instanceof Set) {
          for (const id of attachments) uploads.delete(id)
          if (!uploads.size) unsent.current.delete(sessionId)
        } else unsent.current.delete(sessionId)
      }
    } catch (e) {
      // Another app cleared this thread's files after they were uploaded.
      const error = /attachment not found/i.test(errorText(e))
        ? new Error('A file was removed from the daemon before sending. Send again.')
        : e
      setChat(c => ({
        ...c,
        messages: c.messages.filter(m => m.id !== messageId),
        // A refused follow-up leaves a reply that is still running as it was.
        busy:
          target.kind === 'room' ? Object.keys(c.turns).length > 0 : c.turnAt !== undefined,
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
  /**
   * Takes back your latest message in a bot's chat: a turn on it stops, and
   * the bot forgets it and everything after it. Answers with its text.
   */
  const recall = async (messageId: string): Promise<string | null> => {
    const sessionId = liveId.current
    const message = chat.messages.find(m => m.id === messageId)
    if (routeRef.current?.kind !== 'section' || !sessionId || !message) return null
    await rpc('session.recall', {
      session_id: sessionId,
      ...(message.inputId ? { input_id: message.inputId } : { row_id: message.id })
    })
    if (liveId.current === sessionId)
      setChat(c => {
        const index = c.messages.findIndex(m => m.id === messageId)
        return index < 0
          ? c
          : { ...c, messages: c.messages.slice(0, index), busy: false, error: null }
      })
    return message.text
  }
  /** Closes the error under a chat, and the bot's Stopped state for it, which would bring it back. */
  const dismissError = async () => {
    const target = routeRef.current
    setChat(c => ({ ...c, error: null }))
    setError(null)
    if (target?.kind !== 'section') return
    const owner = botsRef.current.find(b => b.name === target.section.bot)
    if (owner && stoppedIn(owner, target.section))
      await rpc('hexbot.bots.clear_status', { name: owner.name })
  }
  /** `answer` answers a sign-in, plugin or draft card: what was typed goes to the daemon, never the chat. */
  const approval = async (
    requestId: string,
    choice: string,
    answer?: EmailDraftAnswer | PluginAnswer | { username: string; password: string }
  ) => {
    const pending = chat.approvals.find(a => a.requestId === requestId)
    if (!pending || pending.decision) return
    await rpc('approval.respond', {
      session_id: pending.sessionId,
      request_id: requestId,
      choice,
      ...answer
    }).catch((e: unknown) => {
      // A draft card's send or save the app gave up on may still have gone.
      if (!answer || !('mail_action' in answer) || pending.form?.kind !== 'email_draft') throw e
      throw new Error(draftAnswerError(errorText(e), answer.mail_action, pending.form.service_name))
    })
    // The card stays with its answer, as the daemon's approval.resolved says too.
    const answered = (a: PendingApproval) =>
      a.requestId === requestId ? answeredApproval(a, { choice, ...answer }) : a
    setChat(c => {
      if (!c.turns[pending.sessionId]) return { ...c, approvals: c.approvals.map(answered) }
      const turn = c.turns[pending.sessionId]
      return roomChat({
        ...c,
        turns: {
          ...c.turns,
          [pending.sessionId]: { ...turn, approvals: turn.approvals.map(answered) }
        }
      })
    })
  }
  const answer = async (requestId: string, questionId: string, answer: string) => {
    const pending = chat.questions.find(q => q.requestId === requestId)
    if (!pending) return
    await rpc('clarify.respond', {
      session_id: pending.sessionId,
      request_id: requestId,
      question_id: questionId,
      answer
    })
    setChat(c => {
      const turn = c.turns[pending.sessionId]
      const questions = (turn ?? c).questions
        .map(q =>
          q.requestId === requestId
            ? { ...q, questions: q.questions.filter(question => question.id !== questionId) }
            : q
        )
        .filter(q => q.questions.length)
      return turn
        ? roomChat({ ...c, turns: { ...c.turns, [pending.sessionId]: { ...turn, questions } } })
        : { ...c, questions }
    })
  }

  return {
    saved,
    active,
    connection,
    error,
    setError,
    bots,
    rooms,
    sections,
    info,
    settings,
    user,
    route,
    chat,
    loading,
    setChatCovered,
    /** The open chat's history is still on its way. */
    opening: route?.kind === 'section' && readId !== route.section.id,
    hasEarlier,
    loadingEarlier,
    loadEarlier,
    rpc,
    /** A provider's models, fetched once for every screen showing them. */
    models: listModels,
    refresh,
    change,
    syncChat,
    accept,
    activate,
    pairing,
    openSection,
    choosing,
    choose,
    openRoom,
    send,
    stop,
    recall,
    /** The open chat's reactions, and `react` when the chat can take one. */
    reactions,
    react: reactIn ? react : undefined,
    dismissError,
    approval,
    answer,
    liveSessionId: () => liveId.current,
    computer,
    connects,
    heartbeats,
    discordChanges,
    /** Every computer bots can use, once something showed it (`machines.rs`). */
    computers,
    /** What the latest read of the computers said on this connection. */
    computersListed,
    /** Reads the computers again; a daemon from before computers refuses it. */
    loadComputers: () => readComputers(),
    /** Run a `hexbot.computers.*` method, then read the list again. */
    computersCall: async (method?: string, params: Record<string, unknown> = {}) => {
      const current = session.current
      const done = method ? await rpc<{ note?: string }>(method, params) : null
      // What the action left the user to do joins the unread notices, for
      // this daemon only.
      if (done?.note && session.current === current)
        setComputerNotices(notices => addNotice(notices, done.note))
      // How the read went lands in `computersListed`, where an overtaken read
      // can't reach; only the action's own failure is thrown.
      return readComputers().catch(() => null)
    },
    /** Unread notices from computer actions, oldest first. */
    computerNotices,
    /** The user read one. */
    dismissComputerNotice: (notice: string) =>
      setComputerNotices(notices => notices.filter(other => other !== notice)),
    /** Read the computer's status, or run a `hexbot.computer.*` method and keep what it returns. */
    computerCall: async (
      method = 'hexbot.computer.status',
      params: Record<string, unknown> = {}
    ) => {
      const result = await rpc<ComputerStatus>(method, params)
      setComputer(current => ({ ...current, ...result }) as ComputerStatus)
      return result
    },
    /** A link, relative to the daemon, to the computer's screen; with `control` it takes touches. */
    computerView: (control: boolean, quality: ComputerQuality = 'auto') =>
      rpc<{ path: string; control: boolean; expires_at: number }>('hexbot.computer.view', {
        control,
        quality
      }),
    /**
     * A file reached the daemon and waits for that session's next message.
     * Without an id, on a daemon that cannot take one file back, leaving
     * clears them all, as before.
     */
    stage: (sessionId: string, id: string | null) => {
      const uploads = unsent.current.get(sessionId)
      unsent.current.set(
        sessionId,
        id === null || uploads === 'all' ? 'all' : (uploads ?? new Set<string>()).add(id)
      )
      // The upload finished after its conversation was left. A chat still
      // open but reconnecting has no live id for a moment; its files stay.
      releaseStaged(liveId.current ?? (routeRef.current ? sessionId : undefined))
    },
    /** A staged file taken out of the composer, already taken back. */
    unstage: (sessionId: string, id: string) => {
      const uploads = unsent.current.get(sessionId)
      if (uploads !== 'all') uploads?.delete(id)
    },
    /** The daemon process this app talks to; a restart drops what was staged. */
    epoch: () => session.current?.client.epoch ?? null,
    openThread,
    back,
    leave,
    hasThreadReturn,
    disconnect: async () => {
      leave()
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
        leave()
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
