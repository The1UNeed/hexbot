// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import App, { type AppScreens, useAppScreens } from '../../App'
import { type ChatScreenProps, HomeScreen, type HomeScreenProps } from '../screens'
import type { Bot, Room, Section } from './types'

const state = vi.hoisted(() => ({
  request: vi.fn(),
  event: (_event: unknown) => {},
  chat: null as ChatScreenProps | null,
  navigate: vi.fn(),
  platform: { OS: 'ios' },
  screens: null as AppScreens | null
}))

// Render the production App and useMobile. Only native views, storage and the
// transport are adapters; navigation, history, card IDs and send guards are real.
vi.mock('react-native', async () => {
  const { createElement } = await import('react')
  return {
    View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
    ScrollView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
    ActivityIndicator: () => null,
    StyleSheet: { absoluteFill: {} },
    Platform: state.platform,
    AppState: { addEventListener: () => ({ remove() {} }) },
    BackHandler: { addEventListener: () => ({ remove() {} }) }
  }
})
vi.mock('react-native-safe-area-context', () => ({ SafeAreaProvider: ({ children }: { children: ReactNode }) => children }))
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }))
vi.mock('expo-status-bar', () => ({ StatusBar: () => null }))
// The native navigator is Expo Router's; the app only asks it to show the chat route.
vi.mock('expo-router', () => ({ router: { navigate: state.navigate } }))
vi.mock('expo-linking', () => ({ useURL: () => null }))
vi.mock('expo-web-browser', () => ({ maybeCompleteAuthSession() {} }))
vi.mock('expo-crypto', () => ({ randomUUID: () => 'message' }))
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {} }))
vi.mock('./pickFile', () => ({ pickFile: vi.fn(), pickAttachments: vi.fn() }))
vi.mock('../screens/MediaAttachment', () => ({ MediaAttachment: () => null }))
vi.mock('./media', () => ({ mediaUri: vi.fn() }))
// Push registration needs the native notifications module.
vi.mock('./push', () => ({ registerPush: vi.fn(async () => undefined) }))
vi.mock('./transport', () => ({ pair: vi.fn(), connectGrant: vi.fn(), request: vi.fn(), RevokedError: class extends Error {} }))
vi.mock('./storage', () => ({
  activeDaemonId: async () => 'first',
  loadDaemons: async () => [{ id: 'first', name: 'First', origin: 'http://localhost:9119' }],
  loadToken: async () => 'token',
  selectDaemon: async () => {},
  forgetDaemon: async () => {},
  saveDaemon: async () => {},
  clearConnectSession: async () => {},
  loadConnectSession: async () => null,
  saveConnectSession: async () => {}
}))
vi.mock('./session', () => ({
  MobileSession: class {
    client = { connectionState: 'open', request: state.request }
    constructor(
      _daemon: unknown, _token: string,
      private changed: (status: string) => void,
      private ready: () => Promise<void>,
      event: (event: unknown) => void
    ) { state.event = event }
    async connect() { this.changed('connected'); await this.ready() }
    stop() {}
  }
}))
vi.mock('../ui', () => ({
  ThemeProvider: ({ children }: { children: ReactNode }) => children,
  LayerRoot: ({ children }: { children: ReactNode }) => children,
  Layer: () => null,
  Text: ({ children }: { children: ReactNode }) => children,
  useTheme: () => ({ scheme: 'light' }),
  Banner: () => null,
  Button: () => null, Field: () => null, Form: () => null,
  Group: () => null, Row: () => null, mono: 'monospace'
}))
vi.mock('../Management', () => ({ Management: () => null }))
vi.mock('../MarkdownText', () => ({ MarkdownText: () => null }))
vi.mock('../VisualFrame', () => ({ VisualFrame: () => null }))
vi.mock('../screens', async () => {
  const { createElement } = await import('react')
  const chat = (props: ChatScreenProps) => {
    state.chat = props
    return createElement('div', { 'data-testid': 'chat' },
      ...props.items.filter(item => item.kind === 'message').map(item => createElement('p', { key: item.id }, item.text)),
      createElement('p', null, props.sendDisabledReason),
      createElement('button', { disabled: Boolean(props.sendDisabledReason), onClick: () => props.onSend('Owner reply') }, 'Send'),
      ...props.items.filter(item => item.kind === 'approval').map(item => createElement('button', { key: item.id, onClick: () => props.onApprove(item.request.requestId, 'once') }, 'Approve'))
    )
  }
  return {
    HomeScreen: (props: HomeScreenProps) => createElement('div', null,
      ...props.conversations.filter(c => c.kind === 'bot').flatMap(bot => [
        createElement('button', { key: `pulse-${bot.id}`, onClick: () => props.onOpenPulse?.(bot.id) }, `Pulse ${bot.name}`),
        createElement('button', { key: `bot-${bot.id}`, onClick: () => props.onOpen(bot) }, `Bot ${bot.name}`)
      ]),
      ...props.conversations.filter(c => c.kind !== 'bot').map(c =>
        createElement('button', { key: `${c.kind}-${c.id}`, onClick: () => props.onOpen(c) }, `Open ${c.name}`)
      )
    ),
    ChatScreen: chat,
    ChatChooser: () => null, ConnectionScreen: () => null,
    DaemonSwitcher: () => null, FileSheet: () => null, LibraryScreen: () => null,
    ModelSummary: () => null, ProviderGoneCard: () => null, providerGone: () => false,
    SearchSheet: () => null, SettingsScreen: () => null
  }
})

const owner = { id: 'owner', bot: 'owl', peer_bot: null, live_session_id: 'live-owner', archived_at: null } as Section
const thread = { ...owner, id: 'thread', peer_bot: 'yak', live_session_id: 'live-thread' }
const room = { id: 'garden', name: 'Garden', members: [], archived_at: null } as unknown as Room
let bot: Bot
let sections: Section[]
let rooms: Room[]
const calls = (method: string) => state.request.mock.calls.filter(([name]) => name === method)

beforeEach(() => {
  bot = { name: 'owl', display_name: 'Owl', status: 'needs_you', status_detail: { section_id: 'thread', session_id: 'live-thread' } } as Bot
  sections = [owner, thread]
  rooms = []
  state.chat = null
  state.navigate.mockReset()
  state.platform.OS = 'ios'
  state.screens = null
  state.request.mockReset().mockImplementation(async (method: string, params: Record<string, unknown> = {}) => {
    if (method === 'hexbot.info') return { one_chat: true, install_id: 'first' }
    if (method === 'hexbot.bots.list') return { bots: [bot] }
    if (method === 'hexbot.sections.list') return { sections }
    if (method === 'hexbot.rooms.list') return { rooms }
    if (method === 'hexbot.sections.create') return { section: owner }
    if (method === 'hexbot.sections.open') {
      const chosen = sections.find(section => section.id === params.id)!
      state.event({ type: 'approval.request', session_id: chosen.live_session_id, payload: { request_id: 'pending', command: 'pwd', choices: ['once', 'deny'] } })
      return { section: chosen, messages: [{ role: 'assistant', text: `${chosen.id} history` }] }
    }
    if (method === 'session.status') return { status: 'idle' }
    if (method === 'hexbot.rooms.log') return { events: [] }
    if (method === 'hexbot.rooms.get') return { room: rooms[0] }
    return {}
  })
})
afterEach(cleanup)

// What app/ draws: the open chat over the list, as the stack does on a phone.
function Routes() {
  const screens = useAppScreens()
  state.screens = screens
  return screens.chat ?? createElement(HomeScreen, screens.homeProps)
}
const renderApp = () => render(createElement(App, null, createElement(Routes)))

async function open(source = 'Pulse') {
  renderApp()
  fireEvent.click(await screen.findByRole('button', { name: `${source} Owl` }))
  await screen.findByTestId('chat')
}

it.each(['working', 'stopped', 'needs_you'] as const)('rendered Pulse opens the %s peer thread with its card live ID and owner input disabled', async status => {
  bot.status = status
  await open()
  await screen.findByText('thread history')
  expect(screen.getByRole('button', { name: 'Send' }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByText('Conversation between bots')).toBeTruthy()
  expect(calls('hexbot.sections.create')).toHaveLength(0)
  expect(state.chat!.items.find(item => item.kind === 'approval')).toMatchObject({ request: { sessionId: 'live-thread' } })
  await act(async () => state.chat!.onSend('Forced owner reply'))
  expect(calls('prompt.submit')).toHaveLength(0)
  fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
  await waitFor(() => expect(state.request).toHaveBeenCalledWith('approval.respond', expect.objectContaining({ session_id: 'live-thread', request_id: 'pending' })))
})

it('rendered Pulse opens Check-ins when its card waits there, not the chat', async () => {
  const checkins = { ...owner, id: 'checkins', purpose: 'checkins', live_session_id: 'live-checkins' } as Section
  sections = [owner, checkins]
  bot.status_detail = { section_id: 'checkins', session_id: 'live-checkins' } as Bot['status_detail']
  await open()
  await screen.findByText('checkins history')
  expect(calls('hexbot.sections.create')).toHaveLength(0)
  expect(state.chat!.items.find(item => item.kind === 'approval')).toMatchObject({ request: { sessionId: 'live-checkins' } })
})

it.each(['working', 'stopped', 'needs_you'] as const)('rendered Pulse keeps room precedence for %s', async status => {
  bot.status = status
  bot.status_detail!.room_id = 'garden'
  rooms = [room]
  await open()
  await waitFor(() => expect(state.request).toHaveBeenCalledWith('hexbot.rooms.log', expect.objectContaining({ id: 'garden' })))
  expect(calls('hexbot.sections.open')).toHaveLength(0)
  expect(calls('hexbot.sections.create')).toHaveLength(0)
})

it.each(['wrong-bot', 'live-mismatch', 'ordinary-section', 'missing', 'no-detail', 'bot-tap'] as const)('rendered %s falls back to the canonical owner chat', async kind => {
  if (kind === 'wrong-bot') sections = [owner, { ...thread, bot: 'yak' }]
  if (kind === 'live-mismatch') sections = [owner, { ...thread, live_session_id: 'older-live' }]
  if (kind === 'ordinary-section') sections = [owner, { ...thread, peer_bot: null }]
  if (kind === 'missing') sections = [owner]
  if (kind === 'no-detail') bot.status_detail = null
  await open(kind === 'bot-tap' ? 'Bot' : 'Pulse')
  await screen.findByText('owner history')
  expect(state.request).toHaveBeenCalledWith('hexbot.sections.create', { bot: 'owl' })
  expect(state.request).toHaveBeenCalledWith('hexbot.sections.open', { id: 'owner' })
  expect(screen.getByRole('button', { name: 'Send' }).hasAttribute('disabled')).toBe(false)
})

it.each(['archived', 'missing'] as const)('an unavailable %s room gives way to the peer thread', async kind => {
  bot.status = 'working'
  bot.status_detail!.room_id = 'garden'
  rooms = kind === 'archived' ? [{ ...room, archived_at: 1 }] : []
  await open()
  await screen.findByText('thread history')
  expect(calls('hexbot.rooms.log')).toHaveLength(0)
})

it('lists Check-ins with the chats and opens that conversation, not the chat', async () => {
  sections = [owner, { ...owner, id: 'checkins', purpose: 'checkins', live_session_id: 'live-checkins' } as Section]
  bot = { ...bot, primary: true, status: 'idle', status_detail: null }
  renderApp()
  fireEvent.click(await screen.findByRole('button', { name: 'Open Check-ins' }))
  await screen.findByText('checkins history')
  expect(calls('hexbot.sections.create')).toHaveLength(0)
})

it('lists rooms with the chats and opens one full screen', async () => {
  rooms = [room]
  renderApp()
  fireEvent.click(await screen.findByRole('button', { name: 'Open Garden' }))
  await screen.findByTestId('chat')
  await waitFor(() => expect(state.request).toHaveBeenCalledWith('hexbot.rooms.log', expect.objectContaining({ id: 'garden' })))
  expect(state.chat!.title).toBe('Garden')
})

it('on Android, shows an opened room on the chat route and closes it when that route is left', async () => {
  state.platform.OS = 'android'
  rooms = [room]
  renderApp()
  fireEvent.click(await screen.findByRole('button', { name: 'Open Garden' }))
  await screen.findByTestId('chat')
  expect(state.navigate).toHaveBeenCalledWith('/chat')
  expect(state.screens!.uploading).toBe(false)
  act(() => state.screens!.onChatClosed())
  await screen.findByRole('button', { name: 'Open Garden' })
  expect(screen.queryByTestId('chat')).toBeNull()
})

it('on iOS, shows an opened room beside the sidebar and closes it when the sidebar goes back', async () => {
  rooms = [room]
  renderApp()
  fireEvent.click(await screen.findByRole('button', { name: 'Open Garden' }))
  await screen.findByTestId('chat')
  expect(state.navigate).not.toHaveBeenCalled()
  expect(state.screens!.selected).toBe('room-garden')
  act(() => state.screens!.select(null))
  await screen.findByRole('button', { name: 'Open Garden' })
  expect(screen.queryByTestId('chat')).toBeNull()
  expect(state.screens!.selected).toBeNull()
})

it("on iOS, opens a bot's own chat from its row while a thread with another bot is open", async () => {
  await open()
  await screen.findByText('thread history')
  // The thread sits beside the list with no row of its own highlighted.
  expect(state.screens!.selected).toBe('chat')
  expect(state.screens!.homeProps.selected).toBeNull()
  act(() => state.screens!.select('bot-owl'))
  await screen.findByText('owner history')
  expect(state.screens!.homeProps.selected).toBe('bot-owl')
})

it('on iOS, going back while a chat still opens leaves it closed', async () => {
  let release = () => {}
  const opened = new Promise<void>(resolve => { release = resolve })
  const answer = state.request.getMockImplementation()!
  state.request.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
    if (method === 'hexbot.sections.open') await opened
    return answer(method, params)
  })
  renderApp()
  await screen.findByRole('button', { name: 'Bot Owl' })
  act(() => state.screens!.select('bot-owl'))
  expect(state.screens!.selected).toBe('chat')
  act(() => state.screens!.select(null))
  await act(async () => release())
  await act(async () => {})
  expect(state.screens!.selected).toBeNull()
  expect(screen.queryByTestId('chat')).toBeNull()
})

it('on iOS, opens a chat, Settings and Bots & jobs from the sidebar', async () => {
  rooms = [room]
  renderApp()
  await screen.findByRole('button', { name: 'Open Garden' })
  act(() => state.screens!.select('room-garden'))
  await screen.findByTestId('chat')
  expect(state.chat!.title).toBe('Garden')
  act(() => state.screens!.select('settings'))
  await waitFor(() => expect(state.screens!.selected).toBe('settings'))
  act(() => state.screens!.select('library'))
  await waitFor(() => expect(state.screens!.selected).toBe('library'))
})

it('opens Settings and Bots & jobs from your initials and the grid button', async () => {
  renderApp()
  await screen.findByRole('button', { name: 'Bot Owl' })
  act(() => state.screens!.homeProps.onOpenSettings!())
  await waitFor(() => expect(state.screens!.selected).toBe('settings'))
  act(() => state.screens!.homeProps.onOpenLibrary!())
  await waitFor(() => expect(state.screens!.selected).toBe('library'))
  expect(state.navigate).not.toHaveBeenCalled()
})

it('on Android, pushes Settings and Bots & jobs on the stack', async () => {
  state.platform.OS = 'android'
  renderApp()
  await screen.findByRole('button', { name: 'Bot Owl' })
  state.screens!.homeProps.onOpenSettings!()
  expect(state.navigate).toHaveBeenCalledWith('/settings')
  state.screens!.homeProps.onOpenLibrary!()
  expect(state.navigate).toHaveBeenCalledWith('/bots')
})

it('offers a new bot and a new room from the bar', async () => {
  renderApp()
  await screen.findByRole('button', { name: 'Bot Owl' })
  expect(state.screens!.homeProps.onNewBot).toBeTypeOf('function')
  expect(state.screens!.homeProps.onNewRoom).toBeTypeOf('function')
})

it('leaves archived rooms and Check-ins of a bot that is not primary out of the list', async () => {
  rooms = [{ ...room, archived_at: 1 }]
  sections = [owner, { ...owner, id: 'checkins', purpose: 'checkins' } as Section]
  renderApp()
  await screen.findByRole('button', { name: 'Bot Owl' })
  expect(screen.queryByRole('button', { name: 'Open Garden' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Open Check-ins' })).toBeNull()
})


it('keeps historical items, the face and row callbacks stable while a reply streams', async () => {
  await open('Bot')
  await screen.findByText('owner history')
  const before = state.chat!
  act(() => state.event({ type: 'message.start', session_id: 'live-owner', payload: {} }))
  for (let i = 0; i < 5; i++)
    act(() => state.event({ type: 'message.delta', session_id: 'live-owner', payload: { text: 'token' } }))
  const after = state.chat!
  expect(after.items[0]).toBe(before.items[0])
  expect(after.face).toBe(before.face)
  expect(after.renderMessageText).toBe(before.renderMessageText)
  expect(after.onRecall).toBe(before.onRecall)
  expect(after.onApprove).toBe(before.onApprove)
  expect(after.onOpenVisual).toBe(before.onOpenVisual)
  expect(after.items.at(-2)).toMatchObject({ streaming: true, text: 'tokentokentokentokentoken' })
})

it('a file you send carries the path the daemon gave its upload, so its card previews before the chat reloads', async () => {
  const { pickAttachments } = await import('./pickFile')
  vi.mocked(pickAttachments).mockResolvedValueOnce({
    files: [{ name: 'parts.csv', mimeType: 'text/csv', uri: 'file:///parts.csv', base64: 'YQ==', bytes: 1 }],
    refused: null
  })
  const answer = state.request.getMockImplementation()!
  state.request.mockImplementation(async (method: string, params?: Record<string, unknown>) =>
    method === 'file.attach' ? { id: 'upload-1', path: '/chat/attachments/parts.csv' } : answer(method, params)
  )
  await open('Bot')
  await screen.findByText('owner history')
  await act(async () => state.chat!.onAttach!('files'))
  await waitFor(() => expect(state.chat!.attachments).toHaveLength(1))
  await act(async () => state.chat!.onSend('The parts'))
  await waitFor(() => expect(calls('prompt.submit')).toHaveLength(1))
  expect(calls('prompt.submit')[0]![1]).toMatchObject({ attachments: ['upload-1'] })
  expect(state.chat!.items.find(item => item.kind === 'message' && item.attachments?.length)).toMatchObject({
    attachments: [{ name: 'parts.csv', path: '/chat/attachments/parts.csv' }]
  })
})
