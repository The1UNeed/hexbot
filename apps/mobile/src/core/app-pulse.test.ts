// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import App from '../../App'
import type { ChatScreenProps, HomeScreenProps } from '../screens'
import type { Bot, Room, Section } from './types'

const state = vi.hoisted(() => ({
  request: vi.fn(),
  event: (_event: unknown) => {},
  chat: null as ChatScreenProps | null
}))

// Render the production App and useMobile. Only native views, storage and the
// transport are adapters; navigation, history, card IDs and send guards are real.
vi.mock('react-native', async () => {
  const { createElement } = await import('react')
  return {
    View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
    ScrollView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
    ActivityIndicator: () => null,
    Platform: { OS: 'ios' },
    AppState: { addEventListener: () => ({ remove() {} }) },
    BackHandler: { addEventListener: () => ({ remove() {} }) }
  }
})
vi.mock('react-native-safe-area-context', () => ({ SafeAreaProvider: ({ children }: { children: ReactNode }) => children }))
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }))
vi.mock('expo-status-bar', () => ({ StatusBar: () => null }))
vi.mock('expo-linking', () => ({ useURL: () => null }))
vi.mock('expo-web-browser', () => ({ maybeCompleteAuthSession() {} }))
vi.mock('expo-crypto', () => ({ randomUUID: () => 'message' }))
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {} }))
vi.mock('./pickFile', () => ({ pickFile: vi.fn() }))
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
  useTabBarInset: () => 0,
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
      ...props.bots.flatMap(bot => [
        createElement('button', { key: `pulse-${bot.id}`, onClick: () => props.onOpenPulse?.(bot.id) }, `Pulse ${bot.name}`),
        createElement('button', { key: `bot-${bot.id}`, onClick: () => props.onOpenBot(bot.id) }, `Bot ${bot.name}`)
      ]),
      props.tab === 'rooms' ? props.roomChat : null
    ),
    ChatScreen: chat, ChatBody: chat,
    ChatChooser: () => null, ConnectionScreen: () => null,
    DaemonSwitcher: () => null, ModelSummary: () => null
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

async function open(source = 'Pulse') {
  render(createElement(App))
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
