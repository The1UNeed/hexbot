import { Ionicons } from '@expo/vector-icons'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ActivityIndicator, BackHandler, Platform, View } from 'react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { StatusBar } from 'expo-status-bar'
import * as ExpoLinking from 'expo-linking'
import * as WebBrowser from 'expo-web-browser'
import * as Crypto from 'expo-crypto'
import { avatarSrc } from './src/core/avatar'
import { encodeAnswer, imageMime } from './src/core/chat-send'
import { daemonBehind } from './src/core/version-skew'
import { version as appVersion } from '../desktop/package.json'
import { pickFile } from './src/core/pickFile'
import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  ChatChooser,
  ChatScreen,
  type ChatScreenProps,
  ComputerSheet,
  ConnectionScreen,
  DaemonSwitcher,
  HomeScreen,
  LibraryScreen,
  ModelSummary,
  SettingsScreen,
  type ApprovalChoice,
  type AttachmentView,
  type BotStatus,
  type BotSummary,
  type ChatItem,
  type ConversationSummary,
  type DaemonArea,
  type DaemonEntry,
  type FaceSource
} from './src/screens'
import {
  Banner,
  Button,
  Field,
  Form,
  Group,
  Layer,
  LayerRoot,
  Row,
  Text,
  ThemeProvider,
  useTheme
} from './src/ui'
import { MarkdownText } from './src/MarkdownText'
import { VisualFrame } from './src/VisualFrame'
import { visualDocument } from './src/core/visual'
import { parseArgs } from './src/core/chat'
import { Management, type Panel } from './src/Management'
import { useMobile } from './src/core/useMobile'
import { useFeeling } from './src/core/feelings'
import { clearTapped, useTappedSection } from './src/core/tapped'
import { chatPreview, pulseTarget, purposeOf } from './src/core/routes'
import { CONNECT_ORIGIN, parseConnectCallback } from './src/core/links'
import { clearConnectSession, loadConnectSession, saveConnectSession } from './src/core/storage'
import { connectGrant, request, RevokedError } from './src/core/transport'
import type { Bot, ConnectDaemon, Room, Section } from './src/core/types'
WebBrowser.maybeCompleteAuthSession()
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e))
const ms = (seconds: number | null | undefined) => (seconds == null ? undefined : seconds * 1000)
/** Which status a conversation shows when several bots are busy in it. */
const URGENCY: Partial<Record<BotStatus, number>> = { needs_you: 3, stopped: 2, working: 1 }
const PINNED: Record<string, number> = { needs_you: 0, stopped: 1, working: 2 }
// A face picked in an app is drawn live, with its colour; otherwise the picture.
const faceOf = (b: Bot): FaceSource =>
  b.face
    ? { name: b.display_name, face: b.face }
    : { name: b.display_name, imageUri: avatarSrc(b.avatar) }
const DEMO_BOTS: BotSummary[] = [
  {
    id: 'owl',
    name: 'Owl',
    title: 'Chief of staff',
    description: 'Keeps the calendar, travel and family logistics in order.',
    preview: 'Your morning brief is ready.',
    status: 'needs_you'
  },
  {
    id: 'blue',
    name: 'Blue',
    title: 'Research',
    description: 'Reads papers and long reports, then says what changed.',
    preview: 'I found three papers on your topic.',
    status: 'idle'
  },
  {
    id: 'fern',
    name: 'Fern',
    title: 'Inbox manager',
    description: 'Sorts email, drafts replies and asks before sending anything.',
    preview: 'One draft needs your approval.',
    status: 'working',
    activity: 'Sorting 38 emails'
  },
  {
    id: 'milo',
    name: 'Milo',
    title: 'Developer',
    description: 'Fixes bugs in your projects and runs the tests before it says done.',
    preview: 'The tests pass. Ready to review.',
    status: 'idle'
  }
]
const DEMO_ITEMS: ChatItem[] = [
  { id: 'demo-1', kind: 'message', role: 'user', text: 'What needs my attention today?' },
  {
    id: 'demo-2',
    kind: 'message',
    role: 'bot',
    text: 'Your morning brief is ready.\n\nFern has one email draft for you to review. Milo finished the update and all tests pass. You have a clear afternoon after 2 pm.'
  },
  {
    id: 'demo-3',
    kind: 'notice',
    text: 'Demo conversation. Connect a daemon to send messages and run tools.'
  }
]
export default function App() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <MobileApp />
      </ThemeProvider>
    </SafeAreaProvider>
  )
}
function MobileApp() {
  const mobile = useMobile()
  const theme = useTheme()
  // Pages pushed over the chat list; an open conversation shows above them.
  const [page, setPage] = useState<'home' | 'library' | 'settings'>('home')
  const [botPage, setBotPage] = useState<string | null>(null)
  const [addDaemon, setAddDaemon] = useState(false)
  const [panels, setPanels] = useState<Panel[]>([])
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const [switching, setSwitching] = useState<string | null>(null)
  const [demo, setDemo] = useState(false)
  const [initialLink, setInitialLink] = useState('')
  const [connectDaemons, setConnectDaemons] = useState<ConnectDaemon[] | null>(null)
  const [connectPending, setConnectPending] = useState(false)
  const [connectSession, setConnectSession] = useState<string | null>(null)
  const [visual, setVisual] = useState<{ title: string; html: string } | null>(null)
  /** The bots' computer card is open. */
  const [computerOpen, setComputerOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [attachments, setAttachments] = useState<AttachmentView[]>([])
  const [question, setQuestion] = useState<{
    requestId: string
    questionId: string
    text: string
    choices: string[]
    multiSelect: boolean
  } | null>(null)
  const attachmentData = useRef(
    new Map<
      string,
      {
        method: string
        params: Record<string, unknown>
        /** Where the file was uploaded, and the id the daemon gave it. */
        upload?: { session: string | null; id?: string }
      }
    >()
  )
  const [uploading, setUploading] = useState(false)
  const [questionAnswer, setQuestionAnswer] = useState('')
  const [questionChoices, setQuestionChoices] = useState<string[]>([])
  const [refreshing, setRefreshing] = useState(false)
  const pendingState = useRef<string | null>(null)
  const processedLink = useRef<string | null>(null)
  const mobileRef = useRef(mobile)
  mobileRef.current = mobile
  const nativeUrl = ExpoLinking.useURL()
  const panel = panels.at(-1) ?? null
  const act = (work: () => Promise<unknown>) => {
    void work().catch(e => mobile.setError(messageOf(e)))
  }
  // Cards stack: a card already in the stack is returned to instead of opened twice.
  const navigate = (next: Panel, keep?: Record<string, string | boolean>) =>
    setPanels(stack => {
      let list = stack
      const top = list.at(-1)
      if (keep && top) list = [...list.slice(0, -1), { ...top, data: { ...top.data, draft: keep } }]
      let index = -1
      for (let i = list.length - 1; i >= 0; i--)
        if (list[i]!.kind === next.kind) {
          index = i
          break
        }
      return index >= 0 ? [...list.slice(0, index), next] : [...list, next]
    })
  const listConnect = async (token: string) => {
    const result = await request<{ daemons: ConnectDaemon[] }>(`${CONNECT_ORIGIN}/api/daemons`, {
      headers: { Authorization: `Bearer ${token}` }
    })
    setConnectSession(token)
    setConnectDaemons(result.daemons)
  }
  // The sign-in sheet and the app link can both deliver the same callback.
  const handledCallback = useRef<string | null>(null)
  const callback = useCallback(async (url: string) => {
    const state = new URL(url).searchParams.get('state')
    if (state && handledCallback.current === state) return
    handledCallback.current = state
    const stored = await AsyncStorage.getItem('hexbot.connect-pending')
    const pending = stored ? (JSON.parse(stored) as { state: string; at: number }) : null
    const expected = pendingState.current ?? pending?.state
    if (!expected || (pending && Date.now() - pending.at > 10 * 60000))
      throw new Error('Hex Connect sign-in expired. Start it again.')
    const token = parseConnectCallback(url, expected)
    pendingState.current = null
    await AsyncStorage.removeItem('hexbot.connect-pending')
    await saveConnectSession(token)
    await listConnect(token)
  }, [])
  useEffect(() => {
    if (!nativeUrl || processedLink.current === nativeUrl) return
    processedLink.current = nativeUrl
    void (async () => {
      let url = nativeUrl
      if (url.startsWith('exp://') || url.startsWith('exps://')) {
        const path = url.split('/--/')[1]
        if (!path) return
        url = `hexbot://${path}`
      }
      const parsed = new URL(url)
      if (parsed.protocol !== 'hexbot:') return
      if (parsed.hostname === 'connect') {
        await callback(url)
        return
      }
      if (parsed.hostname === 'demo') {
        setDemo(true)
        setBotPage(parsed.searchParams.get('bot'))
        return
      }
      if (parsed.hostname === 'pair') {
        setDemo(false)
        setInitialLink(url)
        setAddDaemon(true)
      }
      if (parsed.hostname === 'bot') {
        const bot = mobileRef.current.bots.find(b => b.name === parsed.searchParams.get('name'))
        if (bot) await mobileRef.current.openSection(bot)
      }
    })().catch(e => mobileRef.current.setError(messageOf(e)))
  }, [nativeUrl, callback])
  useEffect(() => {
    setVisual(null)
    setDraft('')
    setAttachments([])
    attachmentData.current.clear()
    setQuestion(null)
  }, [
    mobile.route?.kind === 'section'
      ? mobile.route.section.id
      : mobile.route?.kind === 'room'
        ? mobile.route.room.id
        : null,
    mobile.active?.id
  ])
  const firstQuestion = mobile.chat.questions[0]
  const firstQuestionId = firstQuestion?.questions[0]?.id
  useEffect(() => {
    const pending = mobileRef.current.chat.questions[0]
    const q = pending?.questions[0]
    if (q) {
      setQuestion({
        requestId: pending.requestId,
        questionId: q.id,
        text: q.text,
        choices: q.choices,
        multiSelect: q.multiSelect
      })
      setQuestionAnswer('')
      setQuestionChoices([])
    } else setQuestion(null)
  }, [firstQuestionId, firstQuestion?.requestId])
  const route = mobile.route
  useEffect(() => {
    setPanels([])
    setSwitcherOpen(false)
    setBotPage(null)
    setPage('home')
  }, [mobile.active?.id])
  useEffect(() => {
    if (Platform.OS !== 'android') return
    // Cards close themselves on back; this handles the screens under them.
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (mobile.route) {
        mobile.back()
        return true
      }
      if (botPage) {
        setBotPage(null)
        return true
      }
      if (page !== 'home') {
        setPage('home')
        return true
      }
      if (addDaemon && mobile.active) {
        setAddDaemon(false)
        return true
      }
      if (demo) {
        setDemo(false)
        return true
      }
      return false
    })
    return () => subscription.remove()
  }, [mobile, botPage, page, addDaemon, demo])
  const signIn = async () => {
    setConnectPending(true)
    mobile.setError(null)
    try {
      const existing = await loadConnectSession()
      if (existing) {
        try {
          await listConnect(existing)
          return
        } catch (e) {
          if (!(e instanceof RevokedError)) throw e
          await clearConnectSession()
        }
      }
      const state = Crypto.randomUUID()
      pendingState.current = state
      await AsyncStorage.setItem(
        'hexbot.connect-pending',
        JSON.stringify({ state, at: Date.now() })
      )
      const url = `${CONNECT_ORIGIN}/connect/authorize?state=${encodeURIComponent(state)}&device=${encodeURIComponent(Platform.OS === 'ios' ? 'Hexbot on iPhone' : 'Hexbot on Android')}`
      if (Platform.OS === 'web') {
        throw new Error(
          'Hex Connect sign-in uses the installed iOS or Android app. Use local pairing for this browser preview.'
        )
      }
      const result = await WebBrowser.openAuthSessionAsync(url, 'hexbot://connect')
      if (result.type === 'success' && pendingState.current) await callback(result.url)
      else if (result.type !== 'success') {
        pendingState.current = null
        await AsyncStorage.removeItem('hexbot.connect-pending')
      }
    } finally {
      setConnectPending(false)
    }
  }
  const selectConnect = async (d: ConnectDaemon) => {
    if (!connectSession) return
    setConnectPending(true)
    try {
      await mobile.accept(await connectGrant(d, connectSession))
      setConnectDaemons(null)
      setDemo(false)
      setAddDaemon(false)
    } finally {
      setConnectPending(false)
    }
  }
  const attach = async () => {
    if (mobile.route?.kind !== 'section') return
    const sessionId = mobile.liveSessionId()
    if (!sessionId) throw new Error('Open this chat again before attaching a file.')
    const asset = await pickFile()
    if (!asset) return
    const image = imageMime(asset.name, asset.mimeType)
    const pdf = asset.mimeType === 'application/pdf' || asset.name.toLowerCase().endsWith('.pdf')
    if (image && asset.bytes > 25 * 1024 * 1024)
      throw new Error('Choose an image smaller than 25 MiB.')
    const id = Crypto.randomUUID()
    attachmentData.current.set(id, {
      method: image ? 'image.attach_bytes' : pdf ? 'pdf.attach' : 'file.attach',
      params:
        image || pdf
          ? { content_base64: asset.base64, filename: asset.name }
          : {
              name: asset.name,
              data_url: `data:${asset.mimeType || 'application/octet-stream'};base64,${asset.base64}`
            }
    })
    setAttachments(list => [
      ...list,
      { id, name: asset.name, kind: image ? 'image' : 'file', uri: image ? asset.uri : null }
    ])
  }
  // An uploaded file left out of the message is dropped by the daemon when it is sent.
  const removeAttachment = (id: string) => {
    if (uploading) return
    attachmentData.current.delete(id)
    setAttachments(a => a.filter(item => item.id !== id))
  }
  const saved: DaemonEntry[] = mobile.saved.map(d => ({
    id: d.id,
    name: d.name,
    address: new URL(d.origin).host,
    via: d.kind === 'connect' ? 'connect' : 'lan',
    current: d.id === mobile.active?.id
  }))
  const bots: BotSummary[] = mobile.bots.map(b => {
    return {
      ...faceOf(b),
      id: b.name,
      primary: b.primary === true,
      title: b.title,
      description: b.description,
      preview: chatPreview(b.name, mobile.sections, b.sections_recent),
      activity: b.status_detail?.text,
      status:
        b.status === 'idle' && b.sections_recent?.some(
          s => s.done_at && !s.archived_at && !purposeOf(s, mobile.sections)
        )
          ? ('done' as const)
          : b.status,
      updatedAt: ms(b.last_activity_at)
    }
  })
  const botByName = (name: string) => mobile.bots.find(b => b.name === name)
  // A tapped check-in opens its section once the daemon's lists have it.
  const tapped = useTappedSection()
  const openedTap = useRef<string | null>(null)
  // Restoring the last daemon at start can land after the switch; try again, a few times.
  const switchedTap = useRef<{ key: string; tries: number }>({ key: '', tries: 0 })
  useEffect(() => {
    if (!tapped || openedTap.current === tapped.key) return
    // Sent by another saved daemon: switch to it, then open once its lists load.
    const daemon = tapped.device ? mobile.saved.find(d => d.deviceId === tapped.device) : null
    if (daemon && mobile.active?.id !== daemon.id) {
      const tries = switchedTap.current.key === tapped.key ? switchedTap.current.tries : 0
      if (tries >= 3) return
      switchedTap.current = { key: tapped.key, tries: tries + 1 }
      act(() => mobile.activate(daemon))
      return
    }
    const s = mobile.sections.find(item => item.id === tapped.section)
    const b = s && mobile.bots.find(item => item.name === s.bot)
    if (!s || !b) return
    openedTap.current = tapped.key
    clearTapped()
    act(() => mobile.openSection(b, s))
  }, [
    tapped?.key,
    tapped?.section,
    tapped?.device,
    mobile.saved,
    mobile.active?.id,
    mobile.sections,
    mobile.bots
  ])
  const membersOf = (r: Room) =>
    r.members
      .filter(m => m.member_kind === 'bot' && !m.left_at)
      .flatMap(m => {
        const b = botByName(m.member_id)
        return b ? [faceOf(b)] : []
      })
  // Where a busy bot is working or waiting when it is not its own chat: a room,
  // Check-ins, or a conversation with another bot. That row shows the status.
  const elsewhere = (b: Bot) => {
    const detail = b.status_detail
    if (!detail || !b.status || b.status === 'idle') return null
    const room = detail.room_id
      ? mobile.rooms.find(r => r.id === detail.room_id && !r.archived_at)
      : undefined
    if (room) return { room }
    const section = detail.section_id
      ? mobile.sections.find(
          s =>
            s.id === detail.section_id &&
            s.bot === b.name &&
            (s.peer_bot || purposeOf(s, mobile.sections))
        )
      : undefined
    return section ? { section } : null
  }
  const urgent = (statuses: (BotStatus | undefined)[]) =>
    statuses.reduce<BotStatus | undefined>(
      (best, next) => ((URGENCY[next!] ?? 0) > (URGENCY[best!] ?? 0) ? next : best),
      undefined
    )
  const primaryBot = mobile.bots.find(b => b.primary)
  const checkins = primaryBot
    ? mobile.sections.find(
        s =>
          s.bot === primaryBot.name &&
          purposeOf(s, mobile.sections) === 'checkins' &&
          !s.archived_at
      )
    : undefined
  const conversations: ConversationSummary[] = demo
    ? DEMO_BOTS.map(b => ({ ...b, kind: 'bot' as const, face: b }))
    : [
        ...bots.map(b => {
          const away = elsewhere(botByName(b.id)!)
          return {
            kind: 'bot' as const,
            id: b.id,
            name: b.name,
            face: b,
            preview: b.preview,
            activity: away ? null : b.activity,
            status: away ? undefined : b.status,
            updatedAt: b.updatedAt,
            primary: b.primary
          }
        }),
        ...mobile.rooms
          .filter(r => !r.archived_at)
          .map(r => {
            const here = mobile.bots.filter(b => elsewhere(b)?.room?.id === r.id)
            return {
              kind: 'room' as const,
              id: r.id,
              name: r.name,
              members: membersOf(r),
              status: urgent([
                ...here.map(b => b.status),
                r.turns?.length ? 'working' : undefined
              ]),
              activity: here.find(b => b.status === 'working')?.status_detail?.text,
              updatedAt: ms(r.last_activity_at)
            }
          }),
        ...(primaryBot && checkins
          ? [
              {
                kind: 'checkins' as const,
                id: checkins.id,
                name: 'Check-ins',
                face: faceOf(primaryBot),
                preview: checkins.preview || null,
                status:
                  elsewhere(primaryBot)?.section?.id === checkins.id ? primaryBot.status : undefined,
                updatedAt: ms(checkins.updated_at)
              }
            ]
          : [])
      ]
  // A bot waiting in a conversation with another bot has no row there; the list names it.
  const waitingElsewhere = bots.filter(b => {
    const bot = botByName(b.id)
    return bot?.status === 'needs_you' && !!elsewhere(bot)?.section?.peer_bot
  })
  const busyBots = bots
    .filter(bot => bot.status && PINNED[bot.status] !== undefined)
    .sort((a, b) => PINNED[a.status!]! - PINNED[b.status!]!)
  const daemon = demo
    ? {
        name: 'Demo',
        address: 'Preview only',
        via: 'demo' as const,
        state: 'connected' as const,
        detail: 'Connect a daemon to run your bots.'
      }
    : mobile.active
      ? {
          name: mobile.info?.daemon_name || mobile.active.name,
          address: new URL(mobile.active.origin).host,
          via: mobile.active.kind === 'connect' ? ('connect' as const) : ('lan' as const),
          state: mobile.connection === 'revoked' ? ('unauthorized' as const) : mobile.connection,
          version: mobile.info?.version,
          platform: mobile.info?.platform
        }
      : null
  const area = (
    key: DaemonArea['key'],
    label: string,
    icon: DaemonArea['icon'],
    detail?: string | null
  ): DaemonArea => ({ key, label, icon, detail })
  const settingsGroups: { title?: string; areas: DaemonArea[] }[] = demo
    ? []
    : [
        { areas: [area('about', 'About you', 'person-outline')] },
        {
          title: 'Bots',
          areas: [
            area('settings', 'Daemon settings', 'options-outline', 'Approvals, budgets'),
            area('providers', 'Models', 'hardware-chip-outline'),
            area('connectors', 'Connectors', 'extension-puzzle-outline'),
            area('skills', 'Skills', 'sparkles-outline')
          ]
        },
        {
          title: 'Activity',
          areas: [
            area('usage', 'Usage', 'stats-chart-outline'),
            area('activity', 'Bot activity', 'pulse-outline')
          ]
        },
        {
          title: 'This daemon',
          areas: [
            area('devices', 'Paired devices', 'phone-portrait-outline'),
            area('network', 'Network and pairing', 'wifi-outline'),
            area('connect', 'Hex Connect', 'cloud-outline'),
            area('updates', 'Updates', 'download-outline', mobile.info?.version ?? null)
          ]
        }
      ]
  const visuals = new Map<string, { title: string; html: string }>()
  const items: ChatItem[] = mobile.chat.messages.flatMap((m): ChatItem[] =>
    m.role === 'system'
      ? [{ kind: 'notice', id: m.id, text: m.text, tone: m.tone }]
      : [
          // A conversation shows what bots say and the visuals they draw, not their steps.
          ...(m.tools ?? [])
            .filter(t => t.name === 'hexbot_show_html' && t.status === 'ok')
            .flatMap((t, i) => {
              const args = parseArgs(t.args) as { title?: string; html?: string } | null
              if (typeof args?.html !== 'string') return []
              const id = `visual-${m.id}-${i}`
              visuals.set(id, { title: args.title || 'Visual', html: args.html })
              return [
                {
                  kind: 'visual' as const,
                  id,
                  title: args.title || 'Visual',
                  index: visuals.size - 1
                }
              ]
            }),
          {
            kind: 'message',
            id: m.id,
            role:
              m.role === 'user'
                ? route?.kind !== 'room' || m.sender === mobile.user?.id
                  ? 'user'
                  : 'human'
                : 'bot',
            text: m.text,
            author:
              m.role === 'user'
                ? { name: m.senderName || 'Former member' }
                : m.sender && botByName(m.sender)
                  ? faceOf(botByName(m.sender)!)
                  : undefined
          }
        ]
  )
  const liveTurns =
    route?.kind === 'room'
      ? Object.values(mobile.chat.turns)
      : [{ ...mobile.chat, sessionId: 'section', bot: route?.bot.name ?? '' }]
  for (const turn of liveTurns) {
    const bot = botByName(turn.bot)
    const author = bot ? faceOf(bot) : { name: turn.bot }
    turn.interim.forEach((text, i) =>
      items.push({
        kind: 'message',
        id: `${turn.sessionId}-interim-${i}`,
        role: 'bot',
        text,
        author
      })
    )
    if (turn.streaming)
      items.push({
        kind: 'message',
        id: `${turn.sessionId}-streaming`,
        role: 'bot',
        text: turn.streaming,
        streaming: true,
        author
      })
    if (turn.error)
      items.push({
        kind: 'notice',
        id: `${turn.sessionId}-error`,
        text: turn.error,
        tone: 'danger'
      })
  }
  mobile.chat.approvals.forEach(a =>
    items.push({
      kind: 'approval',
      id: `approval-${a.requestId}`,
      request: {
        ...a,
        choices: a.choices.filter(c => ['once', 'session', 'deny'].includes(c)) as ApprovalChoice[]
      }
    })
  )
  mobile.chat.questions.forEach(q =>
    q.questions.forEach(question =>
      items.push({
        kind: 'notice',
        id: `question-${question.id}`,
        text: `Question: ${question.text}`
      })
    )
  )
  const back = () => {
    if (uploading) return
    mobile.back()
    setPanels([])
  }
  const send = (text: string) => {
    const pending = mobile.chat.questions[0]
    if (pending?.questions[0]) {
      if (attachmentData.current.size) {
        const q = pending.questions[0]
        setQuestion({
          requestId: pending.requestId,
          questionId: q.id,
          text: q.text,
          choices: q.choices,
          multiSelect: q.multiSelect
        })
        setQuestionAnswer(text)
        return
      }
      const q = pending.questions[0]
      act(async () => {
        await mobile.answer(pending.requestId, q.id, encodeAnswer(q.multiSelect, [], text))
        setDraft('')
      })
      return
    }
    // A thread takes one message at a time; rooms queue messages themselves.
    if (mobile.route?.kind === 'section' && mobile.chat.busy) return
    const previous = draft
    setDraft('')
    act(async () => {
      const daemonId = mobile.active?.id
      const sessionId = mobile.liveSessionId()
      setUploading(true)
      try {
        const ids: string[] = []
        for (const asset of attachmentData.current.values()) {
          if (!asset.upload || asset.upload.session !== sessionId) {
            const reply = await mobile.rpc<{ id?: string }>(asset.method, {
              ...asset.params,
              session_id: sessionId
            })
            asset.upload = { session: sessionId, id: reply.id }
            if (sessionId) mobile.stage(sessionId)
          }
          if (asset.upload.id) ids.push(asset.upload.id)
        }
        if (
          daemonId !== mobileRef.current.active?.id ||
          sessionId !== mobileRef.current.liveSessionId()
        )
          throw new Error('The conversation changed. Open it again before sending.')
        const files = attachmentData.current.size
        // Daemons older than upload ids send every staged file.
        const named = ids.length === files
        await mobile.send(text, files > 0, named ? ids : undefined).catch((e: unknown) => {
          // The next Send uploads the files again; the daemon drops the copies it holds.
          if (named) for (const asset of attachmentData.current.values()) asset.upload = undefined
          throw e
        })
        setAttachments([])
        attachmentData.current.clear()
      } catch (e) {
        setDraft(previous || text)
        throw e
      } finally {
        setUploading(false)
      }
    })
  }
  const renderMessageText: ChatScreenProps['renderMessageText'] = item =>
    item.text ? <MarkdownText text={item.text} user={item.role === 'user'} /> : null
  // Everything a conversation needs, for a bot thread and for the open room alike.
  const emotion = useFeeling(
    route?.kind === 'section' ? route.section.id : null,
    mobile.chat,
    !mobile.loading
  )

  const conversation = {
    items,
    renderMessageText,
    busy: mobile.chat.busy,
    waiting: mobile.chat.busy && !mobile.chat.streaming ? { label: 'Working' } : undefined,
    onSend: send,
    sendWhileBusy: route?.kind === 'room' || mobile.chat.questions.length > 0,
    draft,
    onDraftChange: setDraft,
    onStop: () => act(mobile.stop),
    attachments,
    onRemoveAttachment: removeAttachment,
    onApprove: (id: string, choice: ApprovalChoice) => act(() => mobile.approval(id, choice)),
    onOpenVisual: (id: string) => setVisual(visuals.get(id) ?? null),
    sendDisabledReason: uploading
      ? 'Sending attachments'
      : mobile.loading
        ? 'Opening conversation'
        : mobile.connection !== 'connected'
          ? 'Reconnect to send'
          : route?.kind === 'section' && route.section.peer_bot
            ? 'Conversation between bots'
            : route?.kind === 'section' && !mobile.liveSessionId()
              ? 'Open this chat to send'
              : undefined,
    error: mobile.chat.error || mobile.error,
    onRetry: () =>
      act(async () => {
        await mobile.retry()
        await mobile.syncChat()
      }),
    onUnarchive: () =>
      act(async () => {
        if (!route) return
        await mobile.rpc(
          route.kind === 'section' ? 'hexbot.sections.unarchive' : 'hexbot.rooms.unarchive',
          { id: route.kind === 'section' ? route.section.id : route.room.id }
        )
        await mobile.syncChat()
        await mobile.refresh()
      })
  }
  const refresh = () => {
    if (demo) return
    setRefreshing(true)
    void mobile
      .refresh()
      .catch(e => mobile.setError(messageOf(e)))
      .finally(() => setRefreshing(false))
  }
  const reconnect = () =>
    act(async () => {
      await mobile.retry()
    })
  const openPanelFor = (c: ConversationSummary) => {
    if (demo) return
    if (c.kind === 'room') {
      const r = mobile.rooms.find(item => item.id === c.id)
      if (r) setPanels([{ kind: 'room', room: r }])
      return
    }
    const b = c.kind === 'checkins' ? primaryBot : botByName(c.id)
    if (b) setPanels([{ kind: 'bot', bot: b }])
  }
  const openConversation = (c: ConversationSummary) => {
    if (demo) {
      setBotPage(c.id)
      return
    }
    if (c.kind === 'room') {
      const r = mobile.rooms.find(item => item.id === c.id)
      if (r) act(() => mobile.openRoom(r))
      return
    }
    if (c.kind === 'checkins') {
      const s = mobile.sections.find(item => item.id === c.id)
      if (primaryBot && s) act(() => mobile.openSection(primaryBot, s))
      return
    }
    // Each bot has one chat with you.
    const b = botByName(c.id)
    if (b) act(() => mobile.openSection(b))
  }
  // Pulse opens where a busy bot works or waits; a bot tap opens its own chat.
  const openPulse = (id: string) => {
    const b = botByName(id)
    if (!b) {
      setBotPage(id)
      return
    }
    const target = pulseTarget(b, mobile.rooms, mobile.sections)
    act(() =>
      'room' in target ? mobile.openRoom(target.room) : mobile.openSection(b, target.section)
    )
  }
  const demoBot = demo && botPage ? DEMO_BOTS.find(b => b.id === botPage) : undefined
  const screen =
    !demo && (!mobile.active || addDaemon) ? (
      <ConnectionScreen
        key={initialLink}
        saved={saved}
        initialLink={initialLink}
        onCancel={mobile.active ? () => setAddDaemon(false) : undefined}
        onOpenSaved={id =>
          act(async () => {
            const target = mobile.saved.find(d => d.id === id)
            if (target) await mobile.activate(target)
            setAddDaemon(false)
          })
        }
        onPair={input =>
          act(async () => {
            await mobile.pairing(
              input.mode === 'link' ? input.link : input.address,
              input.mode === 'code' ? input.code : ''
            )
            setAddDaemon(false)
          })
        }
        onConnectSignIn={() => act(signIn)}
        onDemo={() => {
          setDemo(true)
          setAddDaemon(false)
        }}
        pending={
          mobile.loading
            ? 'pair'
            : connectPending
              ? 'connect'
              : mobile.connection === 'connecting'
                ? { savedId: mobile.active?.id ?? '' }
                : null
        }
        error={mobile.error}
        onDismissError={() => mobile.setError(null)}
      />
    ) : demoBot ? (
      <ChatScreen
        title={demoBot.name}
        face={{ name: demoBot.name }}
        items={DEMO_ITEMS}
        onBack={() => setBotPage(null)}
        onSend={() => {}}
        onApprove={() => {}}
        sendDisabledReason="Connect a daemon to chat"
      />
    ) : route?.kind === 'section' && !demo ? (
      <ChatScreen
        {...conversation}
        title={route.bot.display_name}
        subtitle={
          purposeOf(route.section, mobile.sections) === 'checkins'
            ? 'Check-ins'
            : route.section.peer_bot
              ? `With ${botByName(route.section.peer_bot)?.display_name ?? route.section.peer_bot}`
              : null
        }
        face={faceOf(route.bot)}
        emotion={emotion}
        status={route.bot.status}
        intro={
          <View style={{ alignItems: 'center', gap: 4, maxWidth: 320 }}>
            {route.bot.description ? (
              <Text align="center" tone="muted" variant="callout">
                {route.bot.description}
              </Text>
            ) : null}
            <ModelSummary
              models={mobile.models}
              testID="chat-intro-model"
              value={{
                provider: route.bot.provider ?? '',
                model: route.bot.model ?? '',
                reasoning: route.bot.reasoning_effort ?? ''
              }}
            />
          </View>
        }
        onBack={back}
        onAttach={() => act(attach)}
        onOpenComputer={
          (route.bot.available_tools ?? route.bot.tools ?? []).includes('computer_use')
            ? () => setComputerOpen(true)
            : undefined
        }
        computerLive={!!mobile.computer?.actor || mobile.computer?.control === 'user'}
        onOpenSettings={() => {
          if (!uploading) setPanels([{ kind: 'bot', bot: route.bot }])
        }}
        archived={!!route.section.archived_at}
      />
    ) : route?.kind === 'room' && !demo ? (
      <ChatScreen
        {...conversation}
        title={route.room.name}
        subtitle={(() => {
          const names = membersOf(route.room).map(m => m.name)
          return names.length ? `${names.join(', ')} and you` : null
        })()}
        members={membersOf(route.room)}
        archived={!!route.room.archived_at}
        hasEarlier={mobile.hasEarlier}
        loadingEarlier={mobile.loadingEarlier}
        onLoadEarlier={() => act(mobile.loadEarlier)}
        onBack={back}
        onOpenSettings={() => {
          if (!uploading) setPanels([{ kind: 'room', room: route.room }])
        }}
      />
    ) : page === 'settings' ? (
      <SettingsScreen
        daemon={daemon}
        error={mobile.error}
        onDismissError={() => mobile.setError(null)}
        user={mobile.user ? { name: mobile.user.display_name } : null}
        onBack={() => setPage('home')}
        onSwitchDaemon={() => setSwitcherOpen(true)}
        busy={demo ? [] : busyBots}
        onOpenPulse={openPulse}
        groups={settingsGroups}
        onOpenArea={key => setPanels([{ kind: key }])}
        onReconnect={reconnect}
        onPairAgain={() => setAddDaemon(true)}
        onDisconnect={() => {
          setDemo(false)
          setBotPage(null)
          setPage('home')
          void mobile.disconnect()
        }}
        refreshing={refreshing}
        onRefresh={demo ? undefined : refresh}
      />
    ) : page === 'library' ? (
      <LibraryScreen
        bots={demo ? DEMO_BOTS : bots}
        onBack={() => setPage('home')}
        onOpenBot={id => {
          const b = botByName(id)
          if (b && !demo) setPanels([{ kind: 'bot', bot: b }])
        }}
        onNewBot={demo ? undefined : () => setPanels([{ kind: 'bot-create' }])}
        onOpenJobs={demo ? undefined : () => setPanels([{ kind: 'jobs' }])}
        onOpenRooms={demo ? undefined : () => setPanels([{ kind: 'rooms' }])}
        archivedRooms={mobile.rooms.filter(r => r.archived_at).length}
      />
    ) : (
      <HomeScreen
        error={mobile.error}
        onDismissError={() => mobile.setError(null)}
        conversations={conversations}
        onOpen={openConversation}
        onLongPress={demo ? undefined : openPanelFor}
        waiting={demo ? [] : waitingElsewhere}
        onOpenPulse={openPulse}
        onNewBot={demo ? undefined : () => setPanels([{ kind: 'bot-create' }])}
        onNewRoom={demo ? undefined : () => setPanels([{ kind: 'room-create' }])}
        primaryChoice={
          // A daemon from before the primary bot leaves `primary` out; an
          // empty one is offered HexBot too, falling back on older daemons.
          !demo && mobile.bots.every(b => b.primary === false)
            ? {
                onAdd: mobile.bots.some(b => b.name === 'hexbot')
                  ? undefined
                  : () =>
                      act(async () => {
                        const result = await mobile
                          .rpc<{ bot: Bot; section: Section }>('hexbot.bots.create_primary', {})
                          .catch(error => {
                            if (!/unknown method|method not found/i.test(String(error))) throw error
                            return mobile.rpc<{ bot: Bot; section: Section }>(
                              'hexbot.bots.create',
                              { name: 'hexbot', display_name: 'HexBot' }
                            )
                          })
                        await mobile.refresh()
                        await mobile.openSection(result.bot, result.section)
                        // HexBot greets the user and says what it does, as it does on the web.
                        await mobile
                          .rpc('hexbot.bots.introduce', {
                            name: result.bot.name,
                            section: result.section.id
                          })
                          .catch(() => undefined)
                      })
              }
            : null
        }
        daemon={daemon}
        user={mobile.user ? { name: mobile.user.display_name } : null}
        onOpenSettings={() => setPage('settings')}
        onOpenLibrary={() => setPage('library')}
        onSwitchDaemon={saved.length > 1 ? () => setSwitcherOpen(true) : undefined}
        onReconnect={reconnect}
        refreshing={refreshing}
        onRefresh={demo ? undefined : refresh}
        loading={!demo && !mobile.info && mobile.connection === 'connecting'}
      />
    )
  return (
    <LayerRoot>
      <View style={{ flex: 1, backgroundColor: theme.background }}>
        {mobile.chat.questions.length && !question && route ? (
          <Banner
            message="A bot needs your answer"
            actionLabel="Answer"
            testID="pending-question"
            onAction={() => {
              const pending = mobile.chat.questions[0]
              const q = pending.questions[0]
              setQuestion({
                requestId: pending.requestId,
                questionId: q.id,
                text: q.text,
                choices: q.choices,
                multiSelect: q.multiSelect
              })
              setQuestionAnswer('')
              setQuestionChoices([])
            }}
          />
        ) : null}
        {mobile.active && daemonBehind(appVersion, mobile.info?.version ?? null) ? (
          <Banner
            message="This daemon is older than this app. Update it on that computer."
            testID="version-skew"
            tone="warning"
          />
        ) : null}
        <StatusBar style={theme.scheme === 'dark' ? 'light' : 'dark'} />
        {screen}
        {mobile.loading && mobile.active ? (
          <View pointerEvents="none" style={{ position: 'absolute', top: 70, alignSelf: 'center' }}>
            <ActivityIndicator />
          </View>
        ) : null}
      </View>
      <Layer
        visible={!!visual}
        onClose={() => setVisual(null)}
        title={visual?.title || 'Visual'}
        testID="visual-sheet"
        scroll={false}
      >
        {visual ? (
          <VisualFrame
            title={visual.title}
            document={visualDocument(visual.html, {
              '--background': theme.background,
              '--foreground': theme.text,
              '--muted': theme.muted,
              '--surface': theme.surface,
              '--surface-2': theme.fill,
              '--border': theme.hairline,
              '--accent': theme.accent,
              '--accent-foreground': theme.onAccent,
              '--success': theme.success,
              '--danger': theme.danger,
              '--warning': theme.warning,
              '--info': theme.info,
              '--chart-1': theme.accent,
              '--chart-2': theme.info,
              '--chart-3': theme.success,
              '--chart-4': theme.warning,
              '--chart-5': theme.danger,
              '--chart-6': theme.muted,
              '--radius': '16px',
              '--font-sans': 'system-ui',
              '--font-mono': 'monospace'
            })}
          />
        ) : null}
      </Layer>
      <Layer
        visible={computerOpen}
        onClose={() => setComputerOpen(false)}
        title="Your bots' computer"
        testID="computer-sheet"
      >
        {computerOpen ? (
          <ComputerSheet
            bot={route?.kind === 'section' ? (botByName(route.bot.name) ?? route.bot) : undefined}
            bots={mobile.bots}
            call={mobile.computerCall}
            connects={mobile.connects}
            faceOf={faceOf}
            onEnable={
              route?.kind === 'section'
                ? () =>
                    act(async () => {
                      const bot = botByName(route.bot.name) ?? route.bot
                      await mobile.rpc('hexbot.bots.update', {
                        name: bot.name,
                        tools: [...(bot.tools ?? []), 'computer_use']
                      })
                      await mobile.refresh()
                    })
                : undefined
            }
            origin={mobile.active?.origin ?? null}
            status={mobile.computer}
            view={mobile.computerView}
          />
        ) : null}
      </Layer>
      <Management
        panel={panel}
        onClose={() => setPanels([])}
        onBack={panels.length > 1 ? () => setPanels(stack => stack.slice(0, -1)) : undefined}
        onNavigate={navigate}
        mobile={mobile}
        onOpenRoom={room => {
          setPanels([])
          setBotPage(null)
          act(() => mobile.openRoom(room))
        }}
      />
      <ChatChooser
        choices={mobile.choosing?.choices ?? []}
        name={mobile.choosing ? mobile.choosing.bot.display_name || mobile.choosing.bot.name : null}
        onChoose={mobile.choose}
      />
      <DaemonSwitcher
        visible={switcherOpen}
        onClose={() => setSwitcherOpen(false)}
        daemons={saved}
        botCount={mobile.bots.length}
        switching={switching}
        onSwitch={id =>
          act(async () => {
            const d = mobile.saved.find(d => d.id === id)
            if (!d) return
            setSwitching(id)
            try {
              setDemo(false)
              await mobile.activate(d)
              setSwitcherOpen(false)
            } finally {
              setSwitching(null)
            }
          })
        }
        onAdd={() => {
          setSwitcherOpen(false)
          setDemo(false)
          setAddDaemon(true)
        }}
        onForget={id => act(() => mobile.remove(id))}
      />
      <Layer
        visible={connectDaemons !== null}
        onClose={() => setConnectDaemons(null)}
        title="Hex Connect"
        testID="connect-picker"
      >
        <Form>
          {mobile.error ? <Banner message={mobile.error} testID="connect-error" /> : null}
          {connectPending ? <ActivityIndicator /> : null}
          {connectDaemons?.length ? (
            <Group>
              {connectDaemons.map(d => (
                <Row
                  key={d.id}
                  title={d.name || d.daemon_name || d.tunnel_hostname}
                  subtitle={
                    d.status === 'unreachable'
                      ? 'Running, address unavailable'
                      : d.online
                        ? d.tunnel_hostname
                        : 'Offline'
                  }
                  testID={`connect-daemon-${d.id}`}
                  disabled={connectPending || !d.online}
                  onPress={() => act(() => selectConnect(d))}
                  chevron
                />
              ))}
            </Group>
          ) : (
            <Text tone="muted">
              No daemons yet. Register a daemon from its Settings, Hex Connect, or run hexbot
              connect on its computer.
            </Text>
          )}
          <Button
            label="Refresh daemons"
            testID="connect-refresh"
            variant="secondary"
            onPress={() =>
              act(async () => {
                if (connectSession) await listConnect(connectSession)
              })
            }
          />
          <Button
            label="Sign out of Hex Connect"
            testID="connect-sign-out"
            variant="plain"
            onPress={() =>
              act(async () => {
                await clearConnectSession()
                setConnectSession(null)
                setConnectDaemons(null)
              })
            }
          />
        </Form>
      </Layer>
      <Layer
        visible={!!question}
        onClose={() => setQuestion(null)}
        title="Answer bot"
        testID="question-sheet"
        action={{
          label: 'Send',
          disabled: !questionAnswer.trim() && !questionChoices.length,
          onPress: () => {
            if (question)
              act(async () => {
                await mobile.answer(
                  question.requestId,
                  question.questionId,
                  encodeAnswer(question.multiSelect, questionChoices, questionAnswer)
                )
                if (draft.trim() === questionAnswer.trim()) setDraft('')
                setQuestion(null)
                setQuestionAnswer('')
                setQuestionChoices([])
              })
          }
        }}
      >
        <Form>
          {question ? (
            <>
              <Text>{question.text}</Text>
              {attachments.length ? (
                <Text tone="muted">Your attached files will stay here for the next message.</Text>
              ) : null}
              <Group>
                {question.choices.map(choice => {
                  const selected = question.multiSelect
                    ? questionChoices.includes(choice)
                    : questionAnswer === choice
                  return (
                    <Row
                      key={choice}
                      title={choice}
                      testID={`question-choice-${choice}`}
                      selected={selected}
                      trailing={
                        selected ? (
                          <Ionicons color={theme.accent} name="checkmark" size={22} />
                        ) : null
                      }
                      onPress={() =>
                        question.multiSelect
                          ? setQuestionChoices(list =>
                              list.includes(choice)
                                ? list.filter(c => c !== choice)
                                : [...list, choice]
                            )
                          : setQuestionAnswer(choice)
                      }
                    />
                  )
                })}
              </Group>
              <Field
                label={
                  question.multiSelect && question.choices.length ? 'Another answer' : 'Answer'
                }
                testID="question-answer"
                value={questionAnswer}
                onChangeText={setQuestionAnswer}
                multiline
              />
            </>
          ) : null}
        </Form>
      </Layer>
    </LayerRoot>
  )
}
