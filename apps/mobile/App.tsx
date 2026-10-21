import { Ionicons } from '@expo/vector-icons'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ActivityIndicator, BackHandler, Platform, ScrollView, View } from 'react-native'
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
  ChatBody,
  ChatChooser,
  ChatScreen,
  type ChatScreenProps,
  ConnectionScreen,
  DaemonSwitcher,
  HomeScreen,
  ModelSummary,
  type ApprovalChoice,
  type AttachmentView,
  type BotSummary,
  type ChatItem,
  type DaemonArea,
  type DaemonEntry,
  type FaceSource,
  type HomeTab,
  type ToolActivity
} from './src/screens'
import {
  Banner,
  Button,
  Field,
  Form,
  Group,
  Layer,
  LayerRoot,
  mono,
  Row,
  Text,
  ThemeProvider,
  useTabBarInset,
  useTheme
} from './src/ui'
import { MarkdownText } from './src/MarkdownText'
import { VisualFrame } from './src/VisualFrame'
import { visualDocument } from './src/core/visual'
import { parseArgs } from './src/core/chat'
import { activityLabel, readableResult, resultLine, toolLabel } from './src/core/tools'
import { Management, type Panel } from './src/Management'
import { useMobile } from './src/core/useMobile'
import { clearTapped, useTappedSection } from './src/core/tapped'
import { chatPreview, purposeOf, shownRoom } from './src/core/routes'
import { CONNECT_ORIGIN, parseConnectCallback } from './src/core/links'
import { clearConnectSession, loadConnectSession, saveConnectSession } from './src/core/storage'
import { connectGrant, request, RevokedError } from './src/core/transport'
import type { Bot, ChatTool, ConnectDaemon, Section } from './src/core/types'
WebBrowser.maybeCompleteAuthSession()
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e))
const ms = (seconds: number | null | undefined) => (seconds == null ? undefined : seconds * 1000)
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
  const tabInset = useTabBarInset()
  const [tab, setTab] = useState<HomeTab>('bots')
  const [botPage, setBotPage] = useState<string | null>(null)
  const [roomId, setRoomId] = useState<string | null>(null)
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
  const [tool, setTool] = useState<ToolActivity | null>(null)
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
        if (bot) {
          setTab('bots')
          await mobileRef.current.openSection(bot)
        }
      }
    })().catch(e => mobileRef.current.setError(messageOf(e)))
  }, [nativeUrl, callback])
  useEffect(() => {
    setVisual(null)
    setTool(null)
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
  // A room that opens anywhere, such as right after it is created, shows in Rooms.
  const routeRoom = route?.kind === 'room' ? route.room.id : null
  useEffect(() => {
    if (routeRoom) {
      setRoomId(routeRoom)
      setTab('rooms')
      setBotPage(null)
    }
  }, [routeRoom])
  useEffect(() => {
    setPanels([])
    setSwitcherOpen(false)
    setBotPage(null)
    setRoomId(null)
  }, [mobile.active?.id])
  // Rooms shows one room at a time; start with the most recent. A room archived
  // while it is open stays, so it can be restored there.
  const shown = demo ? roomId : shownRoom(mobile.rooms, roomId, routeRoom)
  useEffect(() => {
    if (shown !== roomId) setRoomId(shown)
  }, [shown, roomId])
  useEffect(() => {
    const m = mobileRef.current
    if (tab !== 'rooms' || demo || botPage || m.connection !== 'connected') return
    if (m.route?.kind === 'section') return
    if (m.route?.kind === 'room' && m.route.room.id === roomId) return
    const room = m.rooms.find(r => r.id === roomId)
    if (room) void m.openRoom(room)
  }, [tab, roomId, demo, botPage, mobile.connection])
  const changeTab = (next: HomeTab) => {
    if (uploading) return
    if (next !== 'rooms' && mobile.route?.kind === 'room') mobile.back()
    setTab(next)
  }
  useEffect(() => {
    if (Platform.OS !== 'android') return
    // Cards close themselves on back; this handles the screens under them.
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (mobile.route?.kind === 'section') {
        mobile.back()
        return true
      }
      if (botPage) {
        setBotPage(null)
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
  }, [mobile, botPage, addDaemon, demo])
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
  const rooms = mobile.rooms.map(r => ({
    id: r.id,
    name: r.name,
    members: r.members
      .filter(m => m.member_kind === 'bot' && !m.left_at)
      .flatMap(m => {
        const b = botByName(m.member_id)
        return b ? [faceOf(b)] : []
      }),
    updatedAt: ms(r.last_activity_at),
    archived: !!r.archived_at
  }))
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
  const areas: DaemonArea[] = demo
    ? []
    : [
        {
          key: 'settings',
          label: 'Settings',
          detail: 'Approvals',
          icon: 'options-outline'
        },
        { key: 'providers', label: 'Models', detail: 'Providers', icon: 'hardware-chip-outline' },
        {
          key: 'connectors',
          label: 'Connectors',
          detail: 'Apps and MCP',
          icon: 'extension-puzzle-outline'
        },
        { key: 'skills', label: 'Skills', detail: 'Library', icon: 'sparkles-outline' },
        { key: 'jobs', label: 'Jobs', detail: 'Scheduled', icon: 'alarm-outline' },
        { key: 'about', label: 'About you', detail: 'Bots read it', icon: 'person-outline' },
        { key: 'usage', label: 'Usage', detail: 'Tokens, cost', icon: 'stats-chart-outline' },
        { key: 'activity', label: 'Activity', detail: 'Bot to bot', icon: 'pulse-outline' },
        {
          key: 'devices',
          label: 'Devices',
          detail: 'Paired',
          icon: 'phone-portrait-outline'
        },
        { key: 'network', label: 'Network', detail: 'Pairing codes', icon: 'wifi-outline' },
        { key: 'connect', label: 'Hex Connect', detail: 'Remote', icon: 'cloud-outline' },
        {
          key: 'updates',
          label: 'Updates',
          detail: mobile.info?.version ?? null,
          icon: 'download-outline'
        }
      ]
  const toolView = (t: ChatTool): ToolActivity => ({
    id: t.id,
    name: t.name,
    label: toolLabel(t.name, t.status === 'running'),
    detail: resultLine(t.detail).slice(0, 200),
    input:
      t.args == null || t.name === 'hexbot_show_html'
        ? null
        : (typeof t.args === 'string' ? t.args : JSON.stringify(t.args, null, 2)).slice(0, 4000),
    output: readableResult(t.detail).slice(0, 12000),
    status: t.status
  })
  const visuals = new Map<string, { title: string; html: string }>()
  const items: ChatItem[] = mobile.chat.messages.flatMap((m): ChatItem[] =>
    m.role === 'system'
      ? [{ kind: 'notice', id: m.id, text: m.text, tone: m.tone }]
      : [
          ...(m.tools?.length
            ? [{ kind: 'tools' as const, id: `tools-${m.id}`, tools: m.tools.map(toolView) }]
            : []),
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
    if (turn.tools.length)
      items.push({ kind: 'tools', id: `tools-${turn.sessionId}`, tools: turn.tools.map(toolView) })
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
  const conversation = {
    items,
    renderMessageText,
    busy: mobile.chat.busy,
    waiting:
      mobile.chat.busy && !mobile.chat.streaming
        ? { label: activityLabel(mobile.chat.activity) || 'Working' }
        : undefined,
    onSend: send,
    sendWhileBusy: route?.kind === 'room' || mobile.chat.questions.length > 0,
    draft,
    onDraftChange: setDraft,
    onStop: () => act(mobile.stop),
    attachments,
    onRemoveAttachment: removeAttachment,
    onApprove: (id: string, choice: ApprovalChoice) => act(() => mobile.approval(id, choice)),
    onOpenTool: setTool,
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
        face={faceOf(route.bot)}
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
        onOpenSettings={() => {
          if (!uploading) setPanels([{ kind: 'bot', bot: route.bot }])
        }}
        archived={!!route.section.archived_at}
      />
    ) : (
      <HomeScreen
        error={mobile.error}
        onDismissError={() => mobile.setError(null)}
        tab={tab}
        onTabChange={changeTab}
        bots={demo ? DEMO_BOTS : bots}
        onOpenBot={id => {
          if (tab !== 'bots') changeTab('bots')
          const b = botByName(id)
          // Each bot has one chat with you; the demo shows a sample one.
          if (b && !demo) act(() => mobile.openSection(b))
          else setBotPage(id)
        }}
        onOpenPulse={id => {
          const b = botByName(id)
          const detail = b?.status_detail
          if (
            b &&
            detail?.room_id &&
            mobile.rooms.some(r => r.id === detail.room_id && !r.archived_at)
          ) {
            setRoomId(detail.room_id)
            changeTab('rooms')
            return
          }
          // Pulse follows the reported conversation, including work between bots
          // and Check-ins. A normal bot tap still resolves its owner chat.
          const thread = b
            ? mobile.sections.find(s =>
                s.id === detail?.section_id && s.bot === b.name &&
                (s.peer_bot || purposeOf(s, mobile.sections)) &&
                (!detail.session_id || !s.live_session_id || detail.session_id === s.live_session_id)
              )
            : undefined
          if (b) act(() => mobile.openSection(b, thread))
          else setBotPage(id)
        }}
        onBotLongPress={
          demo
            ? undefined
            : id => {
                const b = botByName(id)
                if (b) setPanels([{ kind: 'bot', bot: b }])
              }
        }
        onNewBot={demo ? undefined : () => setPanels([{ kind: 'bot-create' }])}
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
        rooms={demo ? [] : rooms}
        roomId={roomId}
        onSelectRoom={id => setRoomId(id)}
        onNewRoom={demo ? undefined : () => setPanels([{ kind: 'room-create' }])}
        onOpenRoomSettings={id => {
          const r = mobile.rooms.find(r => r.id === id)
          if (r) setPanels([{ kind: 'room', room: r }])
        }}
        onOpenAllRooms={() => setPanels([{ kind: 'rooms' }])}
        roomChat={
          route?.kind === 'room' && route.room.id === roomId ? (
            <ChatBody
              {...conversation}
              title={route.room.name}
              members={rooms.find(r => r.id === route.room.id)?.members ?? []}
              archived={!!route.room.archived_at}
              bottomInset={tabInset - 12}
              hasEarlier={mobile.hasEarlier}
              loadingEarlier={mobile.loadingEarlier}
              onLoadEarlier={() => act(mobile.loadEarlier)}
            />
          ) : (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
              <ActivityIndicator />
            </View>
          )
        }
        daemon={daemon}
        onSwitchDaemon={() => setSwitcherOpen(true)}
        areas={areas}
        onOpenArea={key => setPanels([{ kind: key }])}
        user={mobile.user ? { name: mobile.user.display_name } : null}
        onReconnect={() =>
          act(async () => {
            await mobile.retry()
          })
        }
        onPairAgain={() => setAddDaemon(true)}
        onDisconnect={() => {
          setDemo(false)
          setBotPage(null)
          void mobile.disconnect()
        }}
        refreshing={refreshing}
        onRefresh={() => {
          if (!demo) {
            setRefreshing(true)
            void mobile
              .refresh()
              .catch(e => mobile.setError(messageOf(e)))
              .finally(() => setRefreshing(false))
          }
        }}
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
        visible={!!tool}
        onClose={() => setTool(null)}
        title={tool?.label ?? 'Step'}
        testID="tool-sheet"
      >
        {tool ? (
          <Form>
            <Text tone={tool.status === 'error' ? 'danger' : 'muted'} variant="footnote">
              {tool.status === 'running'
                ? 'Still running'
                : tool.status === 'error'
                  ? 'This step failed'
                  : `Finished, ${tool.name}`}
            </Text>
            {[
              [
                'Result',
                tool.output ||
                  (tool.status === 'running' ? 'Waiting for the result.' : 'No output.')
              ],
              ...(tool.input ? [['Input', tool.input]] : [])
            ].map(([title, body]) => (
              <Group key={title} title={title}>
                <ScrollView horizontal contentContainerStyle={{ padding: 14 }}>
                  <Text selectable style={{ fontFamily: mono }} variant="footnote">
                    {body}
                  </Text>
                </ScrollView>
              </Group>
            ))}
          </Form>
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
          setRoomId(room.id)
          setBotPage(null)
          changeTab('rooms')
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
