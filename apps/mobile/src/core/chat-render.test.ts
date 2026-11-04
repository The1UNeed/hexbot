// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { chatActions, ChatScreen } from '../screens/ChatScreen'
import type { ChatScreenProps } from '../screens/ChatScreen'
import type { ChatItem } from '../screens/types'
import { formatDayDivider } from '../ui/format'

// FlatList's native windowing is irrelevant here; exercise every production row.
vi.mock('react-native', async () => {
  const { createElement } = await import('react')
  const view = ({ children }: { children?: ReactNode }) => createElement('div', null, children)
  return {
    View: view, ScrollView: view, Pressable: view, Text: view,
    Image: () => null, TextInput: () => null,
    StyleSheet: { create: (styles: unknown) => styles },
    useWindowDimensions: () => ({ width: 390, height: 844 }),
    FlatList: ({ data, renderItem }: { data: { id: string }[]; renderItem: (input: unknown) => ReactNode }) =>
      createElement('div', null, data.map((item, index) => createElement('div', { key: item.id }, renderItem({ item, index }))))
  }
})
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }))
vi.mock('../ui/PluginIcon', () => ({ PluginIcon: () => null }))
// The players are native views; this checks which file each message hands them.
vi.mock('../screens/MediaAttachment', async () => {
  const { createElement } = await import('react')
  return {
    MediaAttachment: ({ file, load }: { file: { kind: string; name: string }; load?: unknown }) =>
      createElement('div', { 'data-testid': `media-${file.kind}` }, `${file.name}${load ? ' from the daemon' : ''}`)
  }
})
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }))
vi.mock('../ui', async () => {
  const { createElement } = await import('react')
  const format = await import('../ui/format')
  const view = ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement('div', { 'data-testid': testID }, children)
  return {
    ...format,
    Text: view, Screen: view, Glass: view, TopBar: () => null,
    BotFace: () => null, RoomFace: () => null, LoadingFace: () => null,
    Button: () => null, IconButton: () => null, Banner: () => null,
    useKeyboardVisible: () => false, useTheme: () => ({}),
    bubbleFill: () => 'grey', withAlpha: () => 'grey', radius: {}, mono: 'monospace',
    Field: () => null, HIT: 44
  }
})
afterEach(cleanup)

it('renders only the streaming row per delta, and refreshes historical rows when the bot face changes', () => {
  const history: ChatItem[] = Array.from({ length: 60 }, (_, i) => ({
    kind: 'message', id: `history-${i}`, role: 'bot', text: `Finished ${i}`
  }))
  const renderText = vi.fn((item: Extract<ChatItem, { kind: 'message' }>) => createElement('span', null, item.text))
  const props: ChatScreenProps = {
    title: 'Owl', face: { name: 'Owl' }, items: history,
    onSend: vi.fn(), onApprove: vi.fn(), renderMessageText: renderText
  }
  const view = render(createElement(ChatScreen, props))
  expect(renderText).toHaveBeenCalledTimes(60)
  let live: ChatItem = { kind: 'message', id: 'streaming', role: 'bot', text: 'token', streaming: true }
  view.rerender(createElement(ChatScreen, { ...props, items: [...history, live] }))
  renderText.mockClear()
  for (let i = 0; i < 5; i++) {
    live = { ...live, text: `${live.text}token` }
    view.rerender(createElement(ChatScreen, { ...props, items: [...history, live] }))
  }
  expect(renderText).toHaveBeenCalledTimes(5)
  renderText.mockClear()
  view.rerender(createElement(ChatScreen, { ...props, face: { name: 'Renamed Owl' }, items: [...history, live] }))
  expect(renderText).toHaveBeenCalledTimes(61)
})

it('divides the chat between days and after quiet spells, not between quick messages', () => {
  const start = new Date(2026, 9, 26, 10, 12).getTime()
  const at = (minutes: number) => start + minutes * 60_000
  const message = (id: string, role: 'bot' | 'user', minutes: number): ChatItem => ({
    kind: 'message', id, role, text: id, createdAt: at(minutes)
  })
  const items = [
    message('Spawn a Biology bot', 'user', 0),
    message('Biology is ready.', 'bot', 2),
    // A restored step with no words neither divides nor resets the quiet spell.
    { kind: 'message', id: 'step', role: 'bot', text: '', createdAt: at(30) } as ChatItem,
    message('One more thing', 'user', 12),
    message('Your summative is due today.', 'bot', 180),
    message('Still not started.', 'bot', 24 * 60),
    { kind: 'message', id: 'live', role: 'bot', text: 'Writing', streaming: true } as ChatItem
  ]
  render(createElement(ChatScreen, {
    title: 'Owl', face: { name: 'Owl' }, items, onSend: vi.fn(), onApprove: vi.fn()
  }))
  expect([0, 180, 24 * 60].map(minutes => screen.getByText(formatDayDivider(at(minutes))))).toHaveLength(3)
  for (const minutes of [2, 12, 30]) expect(screen.queryByText(formatDayDivider(at(minutes)))).toBeNull()
})

it('shows a plugin card, a sign-in card and an API key card in the chat, folded until opened', () => {
  const approval = (id: string, form: NonNullable<Extract<ChatItem, { kind: 'approval' }>['request']['form']>): ChatItem => ({
    kind: 'approval', id, request: { requestId: id, choices: ['once', 'deny'], form }
  })
  render(createElement(ChatScreen, {
    title: 'HexBot', items: [
      approval('ap-1', {
        kind: 'plugin', action: 'setup', id: 'connector:notion', name: 'Notion', bot: 'HexBot',
        description: 'Read and write pages and databases in your workspace.', icon: 'notion',
        fields: [{ key: 'NOTION_API_KEY', label: 'Notion API key', set: false }]
      }),
      approval('ap-2', {
        kind: 'plugin', action: 'enable', id: 'skill:pdf', name: 'pdf', bot: 'Researcher', other: true, fields: []
      }),
      approval('ap-3', { kind: 'sign_in', site: 'app.schoology.com', title: 'Schoology' }),
      approval('ap-4', { kind: 'api_key', env: 'OPENAI_API_KEY', title: 'OpenAI' })
    ],
    onSend: vi.fn(), onApprove: vi.fn()
  }))
  expect(screen.getByText('Notion')).toBeTruthy()
  expect(screen.getByText('Read and write pages and databases in your workspace.')).toBeTruthy()
  // Setup folds its keys behind Connect; turning on for another bot says which.
  expect(screen.queryByText('Notion API key')).toBeNull()
  expect(screen.getByText('For Researcher')).toBeTruthy()
  expect(screen.getByText('Schoology')).toBeTruthy()
  expect(screen.getByText('app.schoology.com')).toBeTruthy()
  // The API key card asks for the key alone, folded behind Add key.
  expect(screen.getByText('OpenAI')).toBeTruthy()
  expect(screen.getByText('API key, as OPENAI_API_KEY')).toBeTruthy()
  expect(screen.queryByTestId('api-key-ap-4-key')).toBeNull()
})

it("puts a chat's bar buttons in reading order, with a profile or settings icon", () => {
  const base = { items: [], onSend() {}, onApprove() {}, title: 'Owl' }
  const bot = chatActions({ ...base, onOpenSearch() {}, onOpenComputer() {}, onOpenSettings() {} })
  expect(bot.map(a => [a.key, a.systemImage])).toEqual([
    ['search', 'magnifyingglass'],
    ['computer', 'desktopcomputer'],
    ['settings', 'person.crop.circle']
  ])
  const room = chatActions({ ...base, members: [], onOpenSearch() {}, onOpenSettings() {} })
  expect(room.map(a => [a.key, a.systemImage, a.label])).toEqual([
    ['search', 'magnifyingglass', 'Search'],
    ['settings', 'gearshape', 'Room settings']
  ])
})

it('plays the pictures, videos and audio files a message carries, and names any other file', () => {
  const load = vi.fn()
  const items: ChatItem[] = [
    {
      kind: 'message', id: 'sent', role: 'user', text: 'Watch this',
      attachments: [
        { id: 'v', kind: 'video', name: 'clip.mp4', path: '/a/clip.mp4' },
        { id: 'f', kind: 'file', name: 'notes.txt', path: '/a/notes.txt' }
      ]
    },
    {
      kind: 'message', id: 'made', role: 'bot', text: '',
      attachments: [{ id: 'a', kind: 'audio', name: 'voice.mp3', path: '/art/voice.mp3' }]
    }
  ]
  render(createElement(ChatScreen, { title: 'Owl', face: { name: 'Owl' }, items, onSend: vi.fn(), onApprove: vi.fn(), loadMedia: load }))
  expect(screen.getByTestId('media-video').textContent).toBe('clip.mp4 from the daemon')
  expect(screen.getByTestId('media-audio').textContent).toBe('voice.mp3 from the daemon')
  expect(screen.queryByTestId('media-file')).toBeNull()
  expect(screen.getByText('notes.txt')).toBeTruthy()
})
