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
import { checkinMessage, emptyChat, historyMessages, reduceChat, replayChat } from './chat'
import { reduceRoom, restoreRoom, roomChat, roomMessage } from './room-chat'
import { attachmentPrompt } from './chat-send'
import { modelLists, providerModels } from './models'
import {
  ROOMS_QUERY,
  SECTIONS_QUERY,
  botChat,
  listSections,
  ownerChat,
  rebind,
  type ChatRoute
} from './routes'
import type {
  Bot,
  ChatState,
  ComputerQuality,
  ComputerStatus,
  Section,
  Room,
  RoomEvent,
  CurrentUser,
  DaemonInfo,
  Settings,
  SavedDaemon,
  Rpc
} from './types'
export type { ChatRoute }
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))
/** A room opens at its latest events and pages back this many at a time. */
const ROOM_PAGE = 200
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
  const [info, setInfo] = useState<DaemonInfo | null>(null)
  const infoRef = useRef<DaemonInfo | null>(null)
  const refreshSequence = useRef(0)
  const [settings, setSettings] = useState<Settings | null>(null)
  /** The bots' shared computer, once something shows it; events keep it current. */
  const [computer, setComputer] = useState<ComputerStatus | null>(null)
  /** Counts connections, so what a daemon forgets on restart is asked for again. */
  const [connects, setConnects] = useState(0)
  const [user, setUser] = useState<CurrentUser | null>(null)
  const [route, setRoute] = useState<ChatRoute | null>(null)
  const [chat, setChat] = useState(emptyChat)
  const [loading, setLoading] = useState(false)
  const [hasEarlier, setHasEarlier] = useState(false)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const session = useRef<MobileSession | null>(null)
  const routeRef = useRef<ChatRoute | null>(null)
  const liveId = useRef<string | null>(null)
  // A reconnect cannot restore an old owner row until canonical lookup succeeds.
  const ownerPending = useRef(false)
  const roomEvents = useRef<RoomEvent[]>([])
  const loadingEvents = useRef<GatewayEvent[] | null>(null)
  const openSequence = useRef(0)
  // Navigation starts before canonical lookup; history sync has its own sequence.
  const navigation = useRef(0)
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mounted = useRef(true)
  /** Sessions holding files uploaded here for a message that was not sent. */
  const unsent = useRef(new Set<string>())
  /** The live session whose running turn was half in the history when it loaded. */
  const straddling = useRef<string | null>(null)
  /** An older daemon's sections to pick a bot's chat from, while asked. */
  const [choosing, setChoosing] = useState<{ bot: Bot; choices: Section[]; current: () => boolean } | null>(null)
  /** Each bot's chat on an older daemon, so the user is asked once while the app runs. */
  const picked = useRef(new Map<string, string>())
  const cancelNavigation = useCallback(() => {
    navigation.current++
    openSequence.current++
    loadingEvents.current = null
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
    cancelNavigation()
    routeRef.current = null
    liveId.current = null
    ownerPending.current = false
    setRoute(null)
    setHasEarlier(false)
  }, [releaseStaged, cancelNavigation])
  const refresh = useCallback(async (reconnecting = false) => {
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
    if (!mounted.current || session.current !== current || sequence !== refreshSequence.current) return
    const previousInfo = infoRef.current
    if (previousInfo && (previousInfo.one_chat !== i.one_chat || previousInfo.install_id !== i.install_id)) {
      cancelNavigation()
      picked.current.clear()
    }
    infoRef.current = i
    setBots(b.bots)
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
  }, [rpc, clearModels, leave, cancelNavigation])
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
        const { room } = await rpc<{ room: Room }>('hexbot.rooms.get', { id })
        if (stale()) return
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
    if (ownerPending.current) return
    let failure: string | null = null
    for (let attempt = 0; ; attempt++) {
      const sequence = ++openSequence.current
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
        const restoredLiveId = result.section.live_session_id
        if (!restoredLiveId) throw new Error('Open this conversation again before sending.')
        setHasEarlier(false)
        const status = await rpc<{ status: string }>('session.status', {
          session_id: restoredLiveId
        })
        if (sequence !== openSequence.current) return
        let snapshot: ChatState = {
          ...emptyChat(),
          busy: status.status === 'working',
          messages: historyMessages(result.messages)
        }
        // The snapshot goes first: an answer or Stop that arrived while it loaded is newer.
        if (result.pending_clarify)
          snapshot = reduceChat(snapshot, {
            type: 'clarify.request',
            session_id: restoredLiveId,
            payload: result.pending_clarify
          })
        const replay = replayChat(
          snapshot,
          (loadingEvents.current ?? []).filter(event => event.session_id === restoredLiveId)
        )
        failure = replay.state.error ?? failure
        // A turn finished while the history loaded; read it again so its replies show once.
        if (replay.reread && attempt < 2) continue
        straddling.current = replay.state.busy ? restoredLiveId : null
        let restored = { ...replay.state, error: failure }
        // Check-ins that arrived while it loaded carry no session; match the section.
        for (const event of loadingEvents.current ?? []) {
          const p = (event.payload ?? {}) as Record<string, unknown>
          if (
            event.type === 'hexbot.checkins.message' &&
            p.section_id === target.section.id &&
            typeof p.row_id === 'string' &&
            typeof p.text === 'string'
          )
            restored = checkinMessage(restored, p.row_id, p.text)
        }
        loadingEvents.current = null
        liveId.current = restoredLiveId
        setChat(restored)
        // A daemon from before one chat names no purpose; keep the one the list marked.
        const section =
          'purpose' in result.section
            ? result.section
            : { ...result.section, purpose: target.section.purpose }
        const newRoute: ChatRoute = { ...target, section }
        routeRef.current = newRoute
        setRoute(newRoute)
        await rpc('hexbot.sections.mark_read', { id: target.section.id })
        return
      } finally {
        if (sequence === openSequence.current) loadingEvents.current = null
      }
    }
  }, [rpc, syncRoom])
  const syncChatRef = useRef(syncChat)
  syncChatRef.current = syncChat
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh
  const onEvent = useCallback(
    (event: GatewayEvent) => {
      const target = routeRef.current
      const p = (event.payload ?? {}) as Record<string, unknown>
      // Sent on every bot action there; it changes nothing else.
      if (event.type === 'hexbot.computer.changed') {
        setComputer(current => (current ? { ...current, ...(p as Partial<ComputerStatus>) } : current))
        return
      }
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
        p.reload === true &&
        target?.kind === 'section' &&
        target.section.id === p.id
      ) {
        void syncChatRef.current().catch(e => setError(errorText(e)))
        return
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
        setChat(c =>
          reduceRoom(
            c,
            event,
            target.room,
            id => botsRef.current.find(b => b.name === id)?.display_name || id
          )
        )
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
          setChat(c => ({ ...reduceChat(c, event), messages: c.messages }))
          void syncChatRef
            .current()
            .then(() => {
              if (failed && liveId.current === event.session_id)
                setChat(c => ({ ...c, error: failed }))
            })
            .catch(e => setError(errorText(e)))
          return
        }
        setChat(c => reduceChat(c, event))
      }
    },
    [rpc]
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
      cancelNavigation()
      const token = suppliedToken ?? (await loadToken(daemon.id))
      if (!token) throw new Error('This saved connection has no credential. Pair it again.')
      releaseStaged()
      session.current?.stop()
      setError(null)
      setActive(daemon)
      setComputer(null)
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
      openSequence.current++
      loadingEvents.current = null
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
          // A reconnect can reach an upgraded daemon at the same address.
          cancelNavigation()
          const generation = navigation.current
          const before = routeRef.current
          ownerPending.current = before?.kind === 'section' && ownerChat(before.section)
          const current = () =>
            mounted.current && session.current === next && navigation.current === generation
          const previousInfo = infoRef.current
          infoRef.current = null
          setInfo(null)
          liveId.current = null
          setChat(emptyChat())
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
    [onEvent, releaseStaged, clearModels, cancelNavigation, leave]
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
  const openSection = async (bot: Bot, section?: Section) => {
    cancelNavigation()
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
      const oneChat = (infoRef.current ?? (await lookup<DaemonInfo>('hexbot.info'))).one_chat === true
      const found = await botChat(lookup, bot.name, oneChat, picked.current, section)
      if (stale()) return
      if ('choices' in found) {
        setChoosing({ bot, choices: found.choices, current: () => !stale() })
        return
      }
      const selected = found.section
      const here = routeRef.current
      if (here?.kind !== 'section' || here.section.id !== selected.id) releaseStaged()
      const target: ChatRoute = { kind: 'section', section: selected, bot }
      routeRef.current = target
      setRoute(target)
      ownerPending.current = false
      liveId.current = null
      setChat(emptyChat())
      await syncChat()
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
  const openRoom = async (room: Room) => {
    cancelNavigation()
    const generation = navigation.current
    const stale = () => !mounted.current || generation !== navigation.current
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
      if (!stale()) setError(errorText(e))
    } finally {
      if (!stale()) setLoading(false)
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
          ? [...c.messages, { id: messageId, role: 'user', text, inputId }]
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
          ...(inputId && { input_id: inputId })
        })
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
    if (owner?.status === 'stopped' && owner.status_detail?.section_id === target.section.id)
      await rpc('hexbot.bots.clear_status', { name: owner.name })
  }
  const approval = async (requestId: string, choice: string) => {
    const pending = chat.approvals.find(a => a.requestId === requestId)
    if (!pending) return
    await rpc('approval.respond', { session_id: pending.sessionId, request_id: requestId, choice })
    setChat(c => {
      if (!c.turns[pending.sessionId])
        return { ...c, approvals: c.approvals.filter(a => a.requestId !== requestId) }
      const turn = c.turns[pending.sessionId]
      return roomChat({
        ...c,
        turns: {
          ...c.turns,
          [pending.sessionId]: {
            ...turn,
            approvals: turn.approvals.filter(a => a.requestId !== requestId)
          }
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
    choosing,
    choose,
    openRoom,
    send,
    stop,
    recall,
    dismissError,
    approval,
    answer,
    liveSessionId: () => liveId.current,
    computer,
    connects,
    /** Read the computer's status, or run a `hexbot.computer.*` method and keep what it returns. */
    computerCall: async (method = 'hexbot.computer.status', params: Record<string, unknown> = {}) => {
      const result = await rpc<ComputerStatus>(method, params)
      setComputer(current => ({ ...current, ...result }) as ComputerStatus)
      return result
    },
    /** A link, relative to the daemon, to the computer's screen; `control` takes over. */
    computerView: (control: boolean, quality: ComputerQuality = 'auto') =>
      rpc<{ path: string; control: boolean; expires_at: number }>('hexbot.computer.view', {
        control,
        quality
      }),
    /** A file reached the daemon and waits for that session's next message. */
    stage: (sessionId: string) => {
      unsent.current.add(sessionId)
      // The upload finished after its conversation was left.
      releaseStaged(liveId.current ?? undefined)
    },
    back: leave,
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
