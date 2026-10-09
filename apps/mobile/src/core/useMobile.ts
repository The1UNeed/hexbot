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
import { emptyChat, historyMessages, reduceChat } from './chat'
import { reduceRoom, restoreRoom, roomChat } from './room-chat'
import { attachmentPrompt } from './chat-send'
import type {
  Bot,
  Section,
  Room,
  RoomEvent,
  CurrentUser,
  DaemonInfo,
  Settings,
  SavedDaemon,
  Rpc
} from './types'
export type ChatRoute =
  { kind: 'section'; section: Section; bot: Bot } | { kind: 'room'; room: Room }
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))
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
  const [settings, setSettings] = useState<Settings | null>(null)
  const [user, setUser] = useState<CurrentUser | null>(null)
  const [route, setRoute] = useState<ChatRoute | null>(null)
  const [chat, setChat] = useState(emptyChat)
  const [loading, setLoading] = useState(false)
  const session = useRef<MobileSession | null>(null)
  const routeRef = useRef<ChatRoute | null>(null)
  const liveId = useRef<string | null>(null)
  const roomEvents = useRef<RoomEvent[]>([])
  const loadingEvents = useRef<GatewayEvent[] | null>(null)
  const openSequence = useRef(0)
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mounted = useRef(true)
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
        throw new Error(
          'This daemon is older than this app. Update the daemon to use attachment and job controls.'
        )
      throw error
    }
    if (session.current !== current)
      throw new Error('The selected daemon changed. Retry on this daemon.')
    return value as never
  }, [])
  const refresh = useCallback(async () => {
    const current = session.current
    const [b, r, s, i, config, me] = await Promise.all([
      rpc<{ bots: Bot[] }>('hexbot.bots.list'),
      rpc<{ rooms: Room[] }>('hexbot.rooms.list'),
      rpc<{ sections: Section[] }>('hexbot.sections.list', { include_archived: true }),
      rpc<DaemonInfo>('hexbot.info'),
      rpc<Settings>('hexbot.settings.get'),
      rpc<CurrentUser>('hexbot.users.me')
    ])
    if (!mounted.current || session.current !== current) return
    setBots(b.bots)
    setRooms(r.rooms)
    setSections(s.sections)
    setInfo(i)
    setSettings(config)
    setUser(me)
  }, [rpc])
  const syncRoom = useCallback(
    async (id: string) => {
      const sequence = ++openSequence.current
      loadingEvents.current = []
      try {
        const events: RoomEvent[] = []
        let after = 0
        for (;;) {
          const page = await rpc<{ events: RoomEvent[] }>('hexbot.rooms.log', {
            id,
            after_seq: after,
            limit: 1000
          })
          if (
            sequence !== openSequence.current ||
            routeRef.current?.kind !== 'room' ||
            routeRef.current.room.id !== id
          )
            return
          events.push(...page.events)
          if (page.events.length < 1000) break
          after = page.events.at(-1)!.seq
        }
        const { room } = await rpc<{ room: Room }>('hexbot.rooms.get', { id })
        if (
          sequence !== openSequence.current ||
          routeRef.current?.kind !== 'room' ||
          routeRef.current.room.id !== id
        )
          return
        roomEvents.current = events
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
      liveId.current = result.section.live_session_id
      const status = await rpc<{ status: string }>('session.status', { session_id: liveId.current })
      if (sequence !== openSequence.current) return
      let restored = {
        ...emptyChat(),
        busy: status.status === 'working',
        messages: historyMessages(result.messages)
      }
      for (const event of loadingEvents.current ?? [])
        if (event.session_id === liveId.current) restored = reduceChat(restored, event)
      if (result.pending_clarify)
        restored = reduceChat(restored, {
          type: 'clarify.request',
          session_id: liveId.current!,
          payload: result.pending_clarify
        })
      loadingEvents.current = null
      setChat(restored)
      const newRoute: ChatRoute = { ...target, section: result.section }
      routeRef.current = newRoute
      setRoute(newRoute)
      await rpc('hexbot.sections.mark_read', { id: target.section.id })
    } finally {
      if (sequence === openSequence.current) loadingEvents.current = null
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
        setChat(c =>
          reduceRoom(
            c,
            event,
            target.room,
            id => botsRef.current.find(b => b.name === id)?.display_name || id
          )
        )
      } else {
        if (!event.session_id || event.session_id !== liveId.current) return
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
      const token = suppliedToken ?? (await loadToken(daemon.id))
      if (!token) throw new Error('This saved connection has no credential. Pair it again.')
      session.current?.stop()
      setError(null)
      setActive(daemon)
      setBots([])
      setRooms([])
      setSections([])
      setInfo(null)
      setSettings(null)
      setUser(null)
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
            void forgetDaemon(daemon.id).then(loadDaemons).then(setSaved)
            setActive(null)
            setRoute(null)
            routeRef.current = null
          }
        },
        async () => {
          await refreshRef.current()
          await syncChatRef.current()
        },
        onEvent
      )
      session.current = next
      await selectDaemon(daemon.id)
      await next.connect()
    },
    [onEvent]
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
    setLoading(true)
    setError(null)
    try {
      const selected =
        section ??
        sections.find(s => s.bot === bot.name && !s.archived_at) ??
        (await rpc<{ section: Section }>('hexbot.sections.create', { bot: bot.name })).section
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
    roomEvents.current = []
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
  const send = async (input: string, hasAttachments = false) => {
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
        if (!liveId.current) throw new Error('Open this section again before sending.')
        await rpc('prompt.submit', { session_id: liveId.current, text })
      }
    } catch (e) {
      setChat(c => ({
        ...c,
        messages: c.messages.filter(m => m.id !== messageId),
        busy: target.kind === 'room' && Object.keys(c.turns).length > 0,
        error: errorText(e)
      }))
      throw e
    }
  }
  const stop = async () => {
    const target = routeRef.current
    if (target?.kind === 'room') await rpc('hexbot.rooms.stop', { id: target.room.id })
    else if (liveId.current) await rpc('session.interrupt', { session_id: liveId.current })
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
    rpc,
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
    back: () => {
      openSequence.current++
      loadingEvents.current = null
      routeRef.current = null
      setRoute(null)
      liveId.current = null
    },
    disconnect: () => {
      session.current?.stop()
      session.current = null
      setActive(null)
      setRoute(null)
      routeRef.current = null
      setConnection('offline')
    },
    remove: async (id: string) => {
      if (active?.id === id) {
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
