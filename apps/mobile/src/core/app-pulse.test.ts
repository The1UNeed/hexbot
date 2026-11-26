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
vi.mock('./push', () => ({
  registerPush: vi.fn(async () => undefined),
  pushPermission: vi.fn(async () => ({ status: 'unavailable', canAsk: false })),
  allowPush: vi.fn(async () => 'unavailable')
}))
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
      ...props.items
        .filter(item => item.kind === 'ask')
        .map(item =>
          createElement(
            'button',
            {
              key: item.id,
              'data-testid': `ask-${item.id}`,
              onClick: () =>
                item.bot && item.peer
                  ? props.onOpenThread?.(item.bot, item.peer, item.sectionId)
                  : undefined
            },
            `${item.before} ${item.name}`
          )
        ),
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

it('keeps distinct ask chip keys across turns that reuse call_0 so both remain independently tappable after settling', async () => {
  const bio = { name: 'bio', display_name: 'Biology', status: 'idle' } as Bot
  const chem = { name: 'chem', display_name: 'Chemistry', status: 'idle' } as Bot
  const bioThread = { ...owner, id: 'th-bio', bot: 'bio', peer_bot: 'owl', live_session_id: 'live-th-bio' }
  const chemThread = { ...owner, id: 'th-chem', bot: 'chem', peer_bot: 'owl', live_session_id: 'live-th-chem' }
  sections = [owner, bioThread, chemThread]
  let ownerMessages: Record<string, unknown>[] = []
  const answer = state.request.getMockImplementation()!
  state.request.mockImplementation(async (method: string, params: Record<string, unknown> = {}) => {
    if (method === 'hexbot.bots.list') return { bots: [bot, bio, chem] }
    if (method === 'hexbot.sections.open' && params.id === 'owner') {
      return { section: owner, messages: ownerMessages }
    }
    if (method === 'hexbot.sections.open' && (params.id === 'th-bio' || params.id === 'th-chem')) {
      const target = params.id === 'th-bio' ? bioThread : chemThread
      return { section: target, messages: [{ role: 'assistant', text: `${target.id} ready` }] }
    }
    return answer(method, params)
  })

  await open('Bot')

  // Turn 1: owl calls message_bot(to: bio) with provider tool ID call_0.
  act(() => {
    state.event({ type: 'message.start', session_id: 'live-owner', payload: { turn_id: 'turn-1' } })
    state.event({
      type: 'tool.start',
      session_id: 'live-owner',
      payload: { turn_id: 'turn-1', tool_id: 'call_0', name: 'message_bot', args: { to: 'bio' } }
    })
  })
  const liveAsk1Id = state.chat!.items.find(item => item.kind === 'ask')?.id
  expect(liveAsk1Id).toBe('ask-owl-t-turn-1-call_0-bio')
  act(() => {
    state.event({
      type: 'tool.complete',
      session_id: 'live-owner',
      payload: {
        turn_id: 'turn-1',
        tool_id: 'call_0',
        result: { section_id: 'th-bio' }
      }
    })
    state.event({
      type: 'message.complete',
      session_id: 'live-owner',
      payload: { turn_id: 'turn-1', text: 'First answer' }
    })
  })

  // Turn 2: owl calls message_bot(to: chem) reusing the exact same tool ID call_0.
  act(() => {
    state.event({ type: 'message.start', session_id: 'live-owner', payload: { turn_id: 'turn-2' } })
    state.event({
      type: 'tool.start',
      session_id: 'live-owner',
      payload: { turn_id: 'turn-2', tool_id: 'call_0', name: 'message_bot', args: { to: 'chem' } }
    })
  })
  const liveAskIds = state.chat!.items.filter(item => item.kind === 'ask').map(item => item.id)
  expect(liveAskIds).toEqual(['ask-owl-t-turn-1-call_0-bio', 'ask-owl-t-turn-2-call_0-chem'])
  act(() => {
    state.event({
      type: 'tool.complete',
      session_id: 'live-owner',
      payload: {
        turn_id: 'turn-2',
        tool_id: 'call_0',
        result: { section_id: 'th-chem' }
      }
    })
    state.event({
      type: 'message.complete',
      session_id: 'live-owner',
      payload: { turn_id: 'turn-2', text: 'Second answer' }
    })
  })

  // Settled ask items keep identical distinct keys and both chips open their respective threads.
  const settledAskIds = state.chat!.items.filter(item => item.kind === 'ask').map(item => item.id)
  expect(settledAskIds).toEqual(['ask-owl-t-turn-1-call_0-bio', 'ask-owl-t-turn-2-call_0-chem'])

  ownerMessages = [
    {
      role: 'assistant',
      row_id: 'a1',
      text: 'First answer',
      turn_id: 'turn-1',
      tool_calls: [{ id: 'call_0', function: { arguments: '{"to":"bio"}' } }]
    },
    { role: 'tool', name: 'message_bot', tool_call_id: 'call_0', text: '{"section_id":"th-bio"}', turn_id: 'turn-1' },
    {
      role: 'assistant',
      row_id: 'a2',
      text: 'Second answer',
      turn_id: 'turn-2',
      tool_calls: [{ id: 'call_0', function: { arguments: '{"to":"chem"}' } }]
    },
    { role: 'tool', name: 'message_bot', tool_call_id: 'call_0', text: '{"section_id":"th-chem"}', turn_id: 'turn-2' }
  ]

  fireEvent.click(screen.getByTestId('ask-ask-owl-t-turn-1-call_0-bio'))
  expect(await screen.findByText('th-bio ready')).toBeTruthy()
  act(() => state.screens!.onChatClosed())
  await screen.findByTestId('ask-ask-owl-t-turn-2-call_0-chem')
  fireEvent.click(screen.getByTestId('ask-ask-owl-t-turn-2-call_0-chem'))
  expect(await screen.findByText('th-chem ready')).toBeTruthy()
})

it('merges stored and live asks for the same peer in one turn and keeps peer-thread ask chips visible across reload', async () => {
  const bio = { name: 'bio', display_name: 'Biology', status: 'idle' } as Bot
  const chem = { name: 'chem', display_name: 'Chemistry', status: 'idle' } as Bot
  const peerThread = { ...owner, id: 'th-peer', bot: 'owl', peer_bot: 'yak', live_session_id: 'live-peer' }
  sections = [owner, peerThread]

  // 1. Reconnect mid-turn after first ask to Biology is stored and while a second ask to Biology runs.
  const answer = state.request.getMockImplementation()!
  state.request.mockImplementation(async (method: string, params: Record<string, unknown> = {}) => {
    if (method === 'hexbot.bots.list') return { bots: [bot, bio, chem] }
    if (method === 'hexbot.sections.open' && params.id === 'owner') {
      return {
        section: owner,
        busy: true,
        messages: [
          {
            role: 'assistant',
            row_id: 'a-mid',
            text: 'Checking Biology...',
            turn_id: 'turn-same',
            tool_calls: [{ id: 'call_1', function: { arguments: '{"to":"bio"}' } }]
          },
          { role: 'tool', name: 'message_bot', tool_call_id: 'call_1', text: '{"section_id":"th-bio"}', turn_id: 'turn-same' }
        ]
      }
    }
    return answer(method, params)
  })

  await open('Bot')
  await screen.findByText('Checking Biology...')
  expect(state.chat!.items.filter(item => item.kind === 'ask')).toMatchObject([
    { id: 'ask-owl-t-turn-same-call_1-bio', before: 'Message from', name: 'Biology' }
  ])

  // Same turn asks Biology again: merges into ONE running chip under the same key (never two chips).
  act(() => {
    state.event({
      type: 'tool.start',
      session_id: 'live-owner',
      payload: { turn_id: 'turn-same', tool_id: 'call_2', name: 'message_bot', args: { to: 'bio' } }
    })
  })
  expect(state.chat!.items.filter(item => item.kind === 'ask')).toMatchObject([
    { id: 'ask-owl-t-turn-same-call_1-bio', before: 'Messaging', name: 'Biology', running: true }
  ])

  // 2. Peer thread: message.complete keeps the ask chip visible under the same key while history reloads (and if reload fails).
  let peerReloadResolve: ((value: unknown) => void) | null = null
  let peerReloadReject: ((err: Error) => void) | null = null
  let peerOpenCount = 0
  bot.status = 'needs_you'
  bot.status_detail = { section_id: 'th-peer', session_id: 'live-peer' } as Bot['status_detail']
  state.request.mockImplementation(async (method: string, params: Record<string, unknown> = {}) => {
    if (method === 'hexbot.bots.list') return { bots: [bot, bio, chem] }
    if (method === 'hexbot.sections.open' && params.id === 'th-peer') {
      peerOpenCount += 1
      if (peerOpenCount === 1) {
        return {
          section: peerThread,
          busy: false,
          messages: [{ role: 'user', content: '@yak: Check chem', hidden: true, row_id: 'q1', turn_id: 'turn-p1' }]
        }
      }
      return new Promise((resolve, reject) => {
        peerReloadResolve = resolve
        peerReloadReject = reject
      })
    }
    return answer(method, params)
  })

  act(() => state.screens!.select(null))
  fireEvent.click(await screen.findByRole('button', { name: 'Pulse Owl' }))
  await screen.findByText('Check chem')

  act(() => {
    state.event({ type: 'message.start', session_id: 'live-peer', payload: { turn_id: 'turn-p1' } })
    state.event({
      type: 'tool.start',
      session_id: 'live-peer',
      payload: { turn_id: 'turn-p1', tool_id: 'call_0', name: 'message_bot', args: { to: 'chem' } }
    })
    state.event({
      type: 'tool.complete',
      session_id: 'live-peer',
      payload: { turn_id: 'turn-p1', tool_id: 'call_0', result: { section_id: 'th-chem' } }
    })
  })
  expect(state.chat!.items.filter(item => item.kind === 'ask')).toMatchObject([
    { id: 'ask-owl-t-turn-p1-call_0-chem', before: 'Message from', name: 'Chemistry' }
  ])

  // On message.complete, the reload is still pending: chip stays visible (1 -> 1) under the exact same key.
  act(() => {
    state.event({ type: 'message.complete', session_id: 'live-peer', payload: { turn_id: 'turn-p1', text: 'Done.' } })
  })
  expect(state.chat!.items.filter(item => item.kind === 'ask')).toMatchObject([
    { id: 'ask-owl-t-turn-p1-call_0-chem', before: 'Message from', name: 'Chemistry' }
  ])

  // Even if the history reload fails, the chip does not disappear.
  await act(async () => {
    peerReloadReject?.(new Error('network blip'))
    await Promise.resolve()
    await Promise.resolve()
  })
  expect(state.chat!.items.filter(item => item.kind === 'ask')).toMatchObject([
    { id: 'ask-owl-t-turn-p1-call_0-chem', before: 'Message from', name: 'Chemistry' }
  ])

  // A successful history read that still omits the queued tool row retains the held ask until confirmed.
  act(() => {
    state.event({ type: 'hexbot.sections.changed', payload: { id: 'th-peer', reload: true } })
  })
  await act(async () => {
    peerReloadResolve?.({
      section: peerThread,
      busy: false,
      messages: [
        { role: 'user', content: '@yak: Check chem', hidden: true, row_id: 'q1', turn_id: 'turn-p1' },
        { role: 'assistant', row_id: 'a-p1', text: 'Done.', turn_id: 'turn-p1' }
      ]
    })
    await Promise.resolve()
    await Promise.resolve()
  })
  expect(state.chat!.items.filter(item => item.kind === 'ask')).toMatchObject([
    { id: 'ask-owl-t-turn-p1-call_0-chem', before: 'Message from', name: 'Chemistry' }
  ])

  // Once the confirming read arrives with the tool row persisted, history takes over seamlessly under the same key.
  act(() => {
    state.event({ type: 'hexbot.sections.changed', payload: { id: 'th-peer', reload: true } })
  })
  await act(async () => {
    peerReloadResolve?.({
      section: peerThread,
      busy: false,
      messages: [
        { role: 'user', content: '@yak: Check chem', hidden: true, row_id: 'q1', turn_id: 'turn-p1' },
        {
          role: 'assistant',
          row_id: 'a-p1',
          text: 'Done.',
          turn_id: 'turn-p1',
          tool_calls: [{ id: 'call_0', function: { arguments: '{"to":"chem"}' } }]
        },
        { role: 'tool', name: 'message_bot', tool_call_id: 'call_0', text: '{"section_id":"th-chem"}', turn_id: 'turn-p1' }
      ]
    })
    await Promise.resolve()
    await Promise.resolve()
  })
  expect(state.chat!.items.filter(item => item.kind === 'ask')).toMatchObject([
    { id: 'ask-owl-t-turn-p1-call_0-chem', before: 'Message from', name: 'Chemistry' }
  ])

  // 3. A failed peer-thread turn (error + message.complete before tool.complete) marks the unfinished ask as Asked.
  act(() => {
    state.event({ type: 'message.start', session_id: 'live-peer', payload: { turn_id: 'turn-p2' } })
    state.event({
      type: 'tool.start',
      session_id: 'live-peer',
      payload: { turn_id: 'turn-p2', tool_id: 'call_0', name: 'message_bot', args: { to: 'bio' } }
    })
    state.event({ type: 'error', session_id: 'live-peer', payload: { message: 'Pi crashed' } })
    state.event({
      type: 'message.complete',
      session_id: 'live-peer',
      payload: { turn_id: 'turn-p2', error: 'Pi crashed', text: '' }
    })
  })
  expect(state.chat!.items.filter(item => item.kind === 'ask')).toMatchObject([
    { id: 'ask-owl-t-turn-p1-call_0-chem', before: 'Message from', name: 'Chemistry' },
    { id: 'ask-owl-t-turn-p2-call_0-bio', before: 'Asked', name: 'Biology' }
  ])

  // 4. Completion arriving during an in-flight read survives syncChat retry even if the retry still lacks the tool row.
  act(() => {
    state.event({ type: 'hexbot.sections.changed', payload: { id: 'th-peer', reload: true } })
  })
  const firstPendingResolve = peerReloadResolve!
  act(() => {
    state.event({ type: 'message.start', session_id: 'live-peer', payload: { turn_id: 'turn-p3' } })
    state.event({
      type: 'tool.start',
      session_id: 'live-peer',
      payload: { turn_id: 'turn-p3', tool_id: 'call_0', name: 'message_bot', args: { to: 'chem' } }
    })
    state.event({
      type: 'tool.complete',
      session_id: 'live-peer',
      payload: { turn_id: 'turn-p3', tool_id: 'call_0', result: { section_id: 'th-chem' } }
    })
    state.event({ type: 'message.complete', session_id: 'live-peer', payload: { turn_id: 'turn-p3', text: 'Third.' } })
  })
  // First read finishes -> replay sees message.complete -> syncChat triggers retry.
  // Before that retry finishes, a SECOND reload supersedes it with history still omitting turn-p3's tool row.
  await act(async () => {
    firstPendingResolve({
      section: peerThread,
      busy: false,
      messages: [
        { role: 'user', content: '@yak: Check chem', hidden: true, row_id: 'q1', turn_id: 'turn-p1' },
        {
          role: 'assistant',
          row_id: 'a-p1',
          text: 'Done.',
          turn_id: 'turn-p1',
          tool_calls: [{ id: 'call_0', function: { arguments: '{"to":"chem"}' } }]
        },
        { role: 'tool', name: 'message_bot', tool_call_id: 'call_0', text: '{"section_id":"th-chem"}', turn_id: 'turn-p1' }
      ]
    })
    await Promise.resolve()
    await Promise.resolve()
  })
  const supersededRetryResolve = peerReloadResolve!
  act(() => {
    state.event({ type: 'hexbot.sections.changed', payload: { id: 'th-peer', reload: true } })
  })
  const supersedingReloadResolve = peerReloadResolve!
  await act(async () => {
    supersededRetryResolve({
      section: peerThread,
      busy: false,
      messages: []
    })
    supersedingReloadResolve({
      section: peerThread,
      busy: false,
      messages: [
        { role: 'user', content: '@yak: Check chem', hidden: true, row_id: 'q1', turn_id: 'turn-p1' },
        {
          role: 'assistant',
          row_id: 'a-p1',
          text: 'Done.',
          turn_id: 'turn-p1',
          tool_calls: [{ id: 'call_0', function: { arguments: '{"to":"chem"}' } }]
        },
        { role: 'tool', name: 'message_bot', tool_call_id: 'call_0', text: '{"section_id":"th-chem"}', turn_id: 'turn-p1' },
        { role: 'assistant', row_id: 'a-p3', text: 'Third.', turn_id: 'turn-p3' }
      ]
    })
    await Promise.resolve()
    await Promise.resolve()
  })
  expect(state.chat!.items.filter(item => item.kind === 'ask')).toMatchObject([
    { id: 'ask-owl-t-turn-p1-call_0-chem', before: 'Message from', name: 'Chemistry' },
    { id: 'ask-owl-t-turn-p2-call_0-bio', before: 'Asked', name: 'Biology' },
    { id: 'ask-owl-t-turn-p3-call_0-chem', before: 'Message from', name: 'Chemistry' }
  ])
})

it('keeps consecutive untagged peer exchanges reusing call_0 distinct through completion and stale history reads', async () => {
  const bio = { name: 'bio', display_name: 'Biology', status: 'idle' } as Bot
  const chem = { name: 'chem', display_name: 'Chemistry', status: 'idle' } as Bot
  const peerThread = { ...owner, id: 'th-legacy', bot: 'owl', peer_bot: 'yak', live_session_id: 'live-legacy' }
  sections = [owner, peerThread]
  bot.status = 'needs_you'
  bot.status_detail = { section_id: 'th-legacy', session_id: 'live-legacy' } as Bot['status_detail']
  const firstExchangeRows = [
    { role: 'user', content: '@yak: First legacy q', hidden: true, row_id: 'lq1' },
    {
      role: 'assistant',
      row_id: 'la1',
      text: 'First legacy answer.',
      tool_calls: [{ id: 'call_0', function: { arguments: '{"to":"bio"}' } }]
    },
    { role: 'tool', name: 'message_bot', tool_call_id: 'call_0', text: '{"section_id":"th-bio"}' }
  ]
  let legacyRows = firstExchangeRows
  const answer = state.request.getMockImplementation()!
  state.request.mockImplementation(async (method: string, params: Record<string, unknown> = {}) => {
    if (method === 'hexbot.bots.list') return { bots: [bot, bio, chem] }
    if (method === 'hexbot.sections.open' && params.id === 'th-legacy') {
      return {
        section: peerThread,
        busy: false,
        messages: legacyRows
      }
    }
    return answer(method, params)
  })

  await open()
  await screen.findByText('First legacy answer.')
  expect(state.chat!.items.filter(item => item.kind === 'ask')).toMatchObject([
    { id: 'ask-owl-n-0-call_0-bio', before: 'Message from', name: 'Biology' }
  ])

  // Second untagged exchange starts before lq2 reaches history and reuses call_0 for Chemistry.
  act(() => {
    state.event({ type: 'message.start', session_id: 'live-legacy', payload: {} })
    state.event({
      type: 'tool.start',
      session_id: 'live-legacy',
      payload: { tool_id: 'call_0', name: 'message_bot', args: { to: 'chem' } }
    })
  })
  expect(state.chat!.items.filter(item => item.kind === 'ask')).toMatchObject([
    { id: 'ask-owl-n-0-call_0-bio', before: 'Message from', name: 'Biology' },
    { id: 'ask-owl-n-1-call_0-chem', before: 'Messaging', name: 'Chemistry', running: true }
  ])

  // Chemistry completes and the first reload is still stale (returns only Biology's call_0):
  // Biology stays intact and Chemistry is NOT replaced or prematurely cleared.
  await act(async () => {
    state.event({
      type: 'tool.complete',
      session_id: 'live-legacy',
      payload: { tool_id: 'call_0', result: { section_id: 'th-chem' } }
    })
    state.event({ type: 'message.complete', session_id: 'live-legacy', payload: { text: 'Second legacy answer.' } })
    await Promise.resolve()
    await Promise.resolve()
  })
  expect(state.chat!.items.filter(item => item.kind === 'ask')).toMatchObject([
    { id: 'ask-owl-n-0-call_0-bio', before: 'Message from', name: 'Biology' },
    { id: 'ask-owl-n-1-call_0-chem', before: 'Message from', name: 'Chemistry' }
  ])

  // Once the confirming read arrives with the second exchange, history takes over cleanly under the same keys.
  legacyRows = [
    ...firstExchangeRows,
    { role: 'user', content: '@yak: Second legacy q', hidden: true, row_id: 'lq2' },
    {
      role: 'assistant',
      row_id: 'la2',
      text: 'Second legacy answer.',
      tool_calls: [{ id: 'call_0', function: { arguments: '{"to":"chem"}' } }]
    },
    { role: 'tool', name: 'message_bot', tool_call_id: 'call_0', text: '{"section_id":"th-chem"}' }
  ]
  await act(async () => {
    state.event({ type: 'hexbot.sections.changed', payload: { id: 'th-legacy', reload: true } })
    await Promise.resolve()
    await Promise.resolve()
  })
  expect(state.chat!.items.filter(item => item.kind === 'ask')).toMatchObject([
    { id: 'ask-owl-n-0-call_0-bio', before: 'Message from', name: 'Biology' },
    { id: 'ask-owl-n-1-call_0-chem', before: 'Message from', name: 'Chemistry' }
  ])
})

it('preserves a running room ask when tapping into its peer thread and returning Back before reply', async () => {
  const bio = { name: 'bio', display_name: 'Biology', status: 'idle' } as Bot
  const lab = {
    ...room,
    id: 'room-back',
    name: 'Lab',
    members: [
      { ...room.members[0]!, room_id: 'room-back', member_kind: 'human', member_id: 'owner', display_name: 'You' },
      { ...room.members[0]!, room_id: 'room-back', member_kind: 'bot', member_id: 'owl', display_name: 'Owl' },
      { ...room.members[0]!, room_id: 'room-back', member_kind: 'bot', member_id: 'bio', display_name: 'Biology' }
    ],
    turns: [{ bot: 'owl', live_session_id: 'room-live-owl' }]
  } as typeof room
  const bioThread = {
    ...owner,
    id: 'th-bio-back',
    bot: 'bio',
    title: 'From Owl',
    peer_bot: 'owl',
    live_session_id: 'live-bio-back'
  }
  rooms = [lab]
  sections = [owner, bioThread]
  const answer = state.request.getMockImplementation()!
  state.request.mockImplementation(async (method: string, params: Record<string, unknown> = {}) => {
    if (method === 'hexbot.bots.list') return { bots: [bot, bio] }
    if (method === 'hexbot.rooms.list') return { rooms: [lab] }
    if (method === 'hexbot.rooms.get' && params.id === lab.id) return { room: lab }
    if (method === 'hexbot.rooms.log' && params.id === lab.id) {
      return {
        events: [
          {
            seq: 1,
            kind: 'message.user',
            actor_kind: 'human',
            actor_id: 'owner',
            created_at: 10,
            payload: { text: 'Ask Biology' }
          }
        ]
      }
    }
    if (method === 'hexbot.sections.thread' && params.bot === 'bio' && params.peer === 'owl') {
      return { section: bioThread }
    }
    if (method === 'hexbot.sections.open' && params.id === bioThread.id) {
      return {
        section: bioThread,
        busy: true,
        messages: [{ role: 'user', content: '@owl: Check cells', hidden: true, row_id: 'q1' }]
      }
    }
    return answer(method, params)
  })

  renderApp()
  fireEvent.click(await screen.findByRole('button', { name: 'Open Lab' }))
  await screen.findByText('Ask Biology')

  // Owl starts messaging Biology in the room.
  act(() => {
    state.event({
      type: 'hexbot.rooms.turn',
      payload: { room_id: lab.id, bot: 'owl', live_session_id: 'room-live-owl', status: 'running' }
    })
    state.event({
      type: 'tool.start',
      session_id: 'room-live-owl',
      payload: { tool_id: 'b1', name: 'bash', args: { command: 'ls' } }
    })
    state.event({
      type: 'tool.complete',
      session_id: 'room-live-owl',
      payload: { tool_id: 'b1', name: 'bash', result_text: 'ok' }
    })
    state.event({
      type: 'tool.start',
      session_id: 'room-live-owl',
      payload: { tool_id: 'call_0', name: 'message_bot', args: { to: 'bio', text: 'Check cells' } }
    })
  })
  expect(state.chat!.items.filter(item => item.kind === 'ask')).toMatchObject([
    { before: 'Messaging', name: 'Biology', running: true }
  ])

  // Tap the running pill and go Back twice: the running ask stays visible and ordinary tools
  // (such as bash) are never duplicated across repeated Back transitions.
  for (let visit = 0; visit < 2; visit++) {
    fireEvent.click(await screen.findByRole('button', { name: 'Messaging Biology' }))
    await screen.findByText('Check cells')
    await act(async () => {
      state.screens!.onChatClosed()
      await Promise.resolve()
      await Promise.resolve()
    })
    await screen.findByText('Ask Biology')
    expect(state.chat!.items.filter(item => item.kind === 'ask')).toMatchObject([
      { before: 'Messaging', name: 'Biology', running: true }
    ])
  }

  // Biology replies -> pill transitions cleanly to Message from Biology.
  act(() => {
    state.event({
      type: 'tool.complete',
      session_id: 'room-live-owl',
      payload: {
        tool_id: 'call_0',
        name: 'message_bot',
        result: { details: { section_id: bioThread.id, status: 'replied' } }
      }
    })
  })
  expect(state.chat!.items.filter(item => item.kind === 'ask')).toMatchObject([
    { before: 'Message from', name: 'Biology', sectionId: bioThread.id }
  ])
  expect(state.chat!.items.find(item => item.kind === 'ask')?.running).toBeFalsy()
})

it('preserves a running chat ask across opening its peer thread and returning Back before reply', async () => {
  const bio = { name: 'bio', display_name: 'Biology', status: 'idle' } as Bot
  const bioThread = {
    ...owner,
    id: 'th-bio-chat-back',
    bot: 'bio',
    title: 'From Owl',
    peer_bot: 'owl',
    live_session_id: 'live-bio-chat-back'
  }
  sections = [owner, bioThread]
  const answer = state.request.getMockImplementation()!
  state.request.mockImplementation(async (method: string, params: Record<string, unknown> = {}) => {
    if (method === 'hexbot.bots.list') return { bots: [bot, bio] }
    if (method === 'hexbot.sections.open' && params.id === owner.id) {
      return {
        section: owner,
        busy: true,
        messages: [
          { role: 'user', text: 'Ask Biology', row_id: 'u1' },
          {
            role: 'assistant',
            row_id: 'a1',
            text: '',
            tool_calls: [{ id: 'call_0', function: { arguments: '{"to":"bio"}' } }]
          }
        ]
      }
    }
    if (method === 'hexbot.sections.thread' && params.bot === 'bio' && params.peer === 'owl') {
      return { section: bioThread }
    }
    if (method === 'hexbot.sections.open' && params.id === bioThread.id) {
      return {
        section: bioThread,
        busy: true,
        messages: [{ role: 'user', content: '@owl: Check cells', hidden: true, row_id: 'q1' }]
      }
    }
    return answer(method, params)
  })

  renderApp()
  fireEvent.click(await screen.findByRole('button', { name: 'Bot Owl' }))
  await screen.findByText('Ask Biology')

  act(() => {
    state.event({ type: 'message.start', session_id: owner.live_session_id, payload: { turn_id: 't1' } })
    state.event({
      type: 'tool.start',
      session_id: owner.live_session_id,
      payload: { turn_id: 't1', message_id: 'a1', tool_id: 'call_0', name: 'message_bot', args: { to: 'bio' } }
    })
  })
  expect(state.chat!.items.filter(item => item.kind === 'ask')).toMatchObject([
    { before: 'Messaging', name: 'Biology', running: true }
  ])

  // Open Biology's peer thread, then go Back BEFORE Biology replies.
  fireEvent.click(await screen.findByRole('button', { name: 'Messaging Biology' }))
  await screen.findByText('Check cells')
  await act(async () => {
    state.screens!.onChatClosed()
    await Promise.resolve()
    await Promise.resolve()
  })
  await screen.findByText('Ask Biology')
  expect(state.chat!.items.filter(item => item.kind === 'ask')).toMatchObject([
    { before: 'Messaging', name: 'Biology', running: true }
  ])

  // Daemon emits tool.complete without args: matched against preserved start -> clickable Message from Biology.
  act(() => {
    state.event({
      type: 'tool.complete',
      session_id: owner.live_session_id,
      payload: {
        turn_id: 't1',
        message_id: 'a1',
        tool_id: 'call_0',
        name: 'message_bot',
        result: { details: { section_id: bioThread.id, status: 'replied' } }
      }
    })
  })
  expect(state.chat!.items.filter(item => item.kind === 'ask')).toMatchObject([
    { before: 'Message from', name: 'Biology', bot: 'bio', peer: 'owl', sectionId: bioThread.id }
  ])
})

it('does not leak an older room ask onto a newer turn on the same live session when returning Back', async () => {
  const bio = { name: 'bio', display_name: 'Biology', status: 'idle' } as Bot
  const lab = {
    ...room,
    id: 'room-new-turn',
    name: 'Lab 2',
    members: [
      { ...room.members[0]!, room_id: 'room-new-turn', member_kind: 'human', member_id: 'owner', display_name: 'You' },
      { ...room.members[0]!, room_id: 'room-new-turn', member_kind: 'bot', member_id: 'owl', display_name: 'Owl' },
      { ...room.members[0]!, room_id: 'room-new-turn', member_kind: 'bot', member_id: 'bio', display_name: 'Biology' }
    ],
    turns: [{ bot: 'owl', live_session_id: 'room-live-owl' }]
  } as typeof room
  const bioThread = {
    ...owner,
    id: 'th-bio-new-turn',
    bot: 'bio',
    title: 'From Owl',
    peer_bot: 'owl',
    live_session_id: 'live-bio-new-turn'
  }
  let roomLog: unknown[] = [
    {
      seq: 1,
      kind: 'message.user',
      actor_kind: 'human',
      actor_id: 'owner',
      created_at: 10,
      payload: { text: 'First room q' }
    }
  ]
  rooms = [lab]
  sections = [owner, bioThread]
  const answer = state.request.getMockImplementation()!
  state.request.mockImplementation(async (method: string, params: Record<string, unknown> = {}) => {
    if (method === 'hexbot.bots.list') return { bots: [bot, bio] }
    if (method === 'hexbot.rooms.list') return { rooms: [lab] }
    if (method === 'hexbot.rooms.get' && params.id === lab.id) return { room: lab }
    if (method === 'hexbot.rooms.log' && params.id === lab.id) return { events: roomLog }
    if (method === 'hexbot.sections.thread' && params.bot === 'bio' && params.peer === 'owl') {
      return { section: bioThread }
    }
    if (method === 'hexbot.sections.open' && params.id === bioThread.id) {
      return {
        section: bioThread,
        busy: false,
        messages: [{ role: 'user', content: '@owl: Check cells', hidden: true, row_id: 'q1' }]
      }
    }
    return answer(method, params)
  })

  renderApp()
  fireEvent.click(await screen.findByRole('button', { name: 'Open Lab 2' }))
  await screen.findByText('First room q')
  act(() => {
    state.event({
      type: 'hexbot.rooms.turn',
      payload: { room_id: lab.id, bot: 'owl', live_session_id: 'room-live-owl', status: 'running' }
    })
    state.event({
      type: 'tool.start',
      session_id: 'room-live-owl',
      payload: { tool_id: 'call_0', name: 'message_bot', args: { to: 'bio', text: 'Check cells' } }
    })
  })
  fireEvent.click(await screen.findByRole('button', { name: 'Messaging Biology' }))
  await screen.findByText('Check cells')

  // While away, Owl finished turn 1 (durable message.bot with asks) and started turn 2 with zero tool calls
  // on the same live_session_id, without this phone seeing turn 1's sessionless turn/event frames.
  roomLog = [
    ...roomLog,
    {
      seq: 2,
      kind: 'message.bot',
      actor_kind: 'bot',
      actor_id: 'owl',
      created_at: 20,
      payload: {
        text: 'Biology answered.',
        asks: [{ to: 'bio', section_id: bioThread.id, waited: 1, failed: 0 }]
      }
    },
    {
      seq: 3,
      kind: 'message.user',
      actor_kind: 'human',
      actor_id: 'owner',
      created_at: 30,
      payload: { text: 'Second room q' }
    }
  ]

  await act(async () => {
    state.screens!.onChatClosed()
    await Promise.resolve()
    await Promise.resolve()
  })
  await screen.findByText('Second room q')
  // Only the saved reply from turn 1 shows Biology; the new turn 2 (zero asks) has NO leaked Biology pill.
  expect(state.chat!.items.filter(item => item.kind === 'ask')).toMatchObject([
    { before: 'Message from', name: 'Biology', sectionId: bioThread.id }
  ])
})

it('shows the running ask immediately when opening a busy chat mid-call and preserves buffered asks across refresh + Back', async () => {
  const yak = { name: 'yak', display_name: 'Yak', status: 'idle' } as Bot
  const yakThread = {
    ...owner,
    id: 'th-yak-refresh',
    bot: 'yak',
    title: 'From Owl',
    peer_bot: 'owl',
    live_session_id: 'live-yak-refresh'
  }
  sections = [owner, yakThread]
  let openCalls = 0
  let heldRefresh: ((value: unknown) => void) | null = null
  const answer = state.request.getMockImplementation()!
  state.request.mockImplementation(async (method: string, params: Record<string, unknown> = {}) => {
    if (method === 'hexbot.bots.list') return { bots: [bot, yak] }
    if (method === 'hexbot.sections.open' && params.id === owner.id) {
      openCalls += 1
      if (openCalls === 1) {
        // Opening mid-call: assistant declaration is stored, result row is not yet stored.
        return {
          section: owner,
          busy: true,
          messages: [
            { role: 'user', text: 'Ask Yak', row_id: 'u1' },
            {
              role: 'assistant',
              row_id: 'a1',
              text: 'Checking.',
              turn_id: 'T1',
              tool_calls: [{ id: 'call_0', function: { name: 'message_bot', arguments: '{"to":"yak"}' } }]
            }
          ]
        }
      }
      if (openCalls === 2) {
        // Hold this refresh read open while a new turn starts in loadingEvents.
        return new Promise(resolve => {
          heldRefresh = resolve
        })
      }
      return {
        section: owner,
        busy: true,
        messages: [{ role: 'user', text: 'Ask Yak again', row_id: 'u2' }]
      }
    }
    if (method === 'hexbot.sections.thread' && params.bot === 'yak' && params.peer === 'owl') {
      return { section: yakThread }
    }
    if (method === 'hexbot.sections.open' && params.id === yakThread.id) {
      return {
        section: yakThread,
        busy: true,
        messages: [{ role: 'user', content: '@owl: Second check', hidden: true, row_id: 'q2' }]
      }
    }
    return answer(method, params)
  })

  renderApp()
  fireEvent.click(await screen.findByRole('button', { name: 'Bot Owl' }))
  await screen.findByText('Checking.')
  // 1. Mid-call open immediately renders tappable Messaging Yak from the stored declaration.
  expect(state.chat!.items.filter(item => item.kind === 'ask')).toMatchObject([
    { before: 'Messaging', name: 'Yak', running: true }
  ])

  // 2. Start a chat reload (held in flight), deliver message.start + tool.start into loadingEvents,
  //    then open Yak's peer thread and press Back BEFORE Yak replies -> Messaging Yak stays visible.
  act(() => {
    state.event({ type: 'hexbot.sections.changed', payload: { id: owner.id, reload: true } })
  })
  expect(heldRefresh).not.toBeNull()
  act(() => {
    state.event({ type: 'message.start', session_id: owner.live_session_id, payload: { turn_id: 'T2' } })
    state.event({
      type: 'tool.start',
      session_id: owner.live_session_id,
      payload: { turn_id: 'T2', message_id: 'a2', tool_id: 'call_1', name: 'message_bot', args: { to: 'yak' } }
    })
  })
  fireEvent.click(await screen.findByRole('button', { name: 'Messaging Yak' }))
  await screen.findByText('Second check')
  await act(async () => {
    state.screens!.onChatClosed()
    await Promise.resolve()
    await Promise.resolve()
  })
  await screen.findByText('Ask Yak again')
  expect(state.chat!.items.filter(item => item.kind === 'ask')).toMatchObject([
    { before: 'Messaging', name: 'Yak', running: true }
  ])
})
