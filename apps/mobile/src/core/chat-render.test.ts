// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import * as Clipboard from 'expo-clipboard'
import { createElement, type ReactNode } from 'react'
import { ActionSheetIOS } from 'react-native'
import { afterEach, expect, it, vi } from 'vitest'
import { chatActions, ChatScreen } from '../screens/ChatScreen'
import type { ChatScreenProps } from '../screens/ChatScreen'
import type { ChatItem } from '../screens/types'
import { formatDayDivider } from '../ui/format'

// FlatList's native windowing is irrelevant here; exercise every production row.
vi.mock('react-native', async () => {
  const { createElement } = await import('react')
  const view = ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement('div', { 'data-testid': testID }, children)
  return {
    View: view, ScrollView: view, Text: view, Image: () => null,
    // A long press, as a context menu: the one gesture the DOM has for it.
    Pressable: ({ children, onLongPress, onPress, testID }: { children?: ReactNode; onLongPress?: () => void; onPress?: () => void; testID?: string }) =>
      createElement('div', { 'data-testid': testID, onClick: onPress, onContextMenu: onLongPress }, children),
    // The message menu is a modal; closed, it draws nothing.
    Modal: ({ children, visible }: { children?: ReactNode; visible?: boolean }) =>
      visible ? createElement('div', null, children) : null,
    // Only the sheet's read-only text shows what it holds.
    TextInput: ({ testID, value }: { testID?: string; value?: string }) =>
      testID === 'select-text-body' ? createElement('div', { 'data-testid': testID }, value) : null,
    ActionSheetIOS: { showActionSheetWithOptions: vi.fn() },
    Alert: { alert: vi.fn() },
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Platform: { OS: 'ios' },
    useWindowDimensions: () => ({ width: 390, height: 844 }),
    FlatList: ({ data, renderItem }: { data: { id: string }[]; renderItem: (input: unknown) => ReactNode }) =>
      createElement('div', null, data.map((item, index) => createElement('div', { key: item.id }, renderItem({ item, index }))))
  }
})
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }))
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }))
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
    bubbleFill: () => 'grey', faceColor: () => null, faceWash: () => 'grey', withAlpha: () => 'grey', radius: {}, mono: 'monospace',
    Field: () => null, HIT: 44, useCover: () => {},
    ModalSheet: ({ children, testID, visible }: { children?: ReactNode; testID?: string; visible: boolean }) =>
      visible ? createElement('div', { 'data-testid': testID }, children) : null
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

it('shows a plugin card and a sign-in card in the chat, folded until opened', () => {
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
      approval('ap-3', { kind: 'sign_in', site: 'app.schoology.com', title: 'Schoology' })
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

it('plays the pictures, videos and audio files a message carries, and shows any other file as its card', () => {
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
  // The card cuts the name before its extension, so the extension always shows, and names the kind.
  expect(['notes', '.txt', 'Text'].map(text => screen.getByText(text).textContent)).toEqual([
    'notes',
    '.txt',
    'Text'
  ])
})

it('a long press on a message copies it whole or opens it to select any part', () => {
  const menu = vi.mocked(ActionSheetIOS.showActionSheetWithOptions)
  const recall = vi.fn()
  const items: ChatItem[] = [
    { kind: 'message', id: 'mine', role: 'user', text: 'When is **it** due?' },
    {
      kind: 'message', id: 'reply', role: 'bot',
      text: 'The [Biology final draft](https://school.example/a/1) is due **November 24**.\n\nNotion still shows November 20.'
    }
  ]
  render(createElement(ChatScreen, {
    title: 'School', face: { name: 'School' }, items, onSend: vi.fn(), onApprove: vi.fn(),
    renderMessageText: item => createElement('span', null, item.text), recallId: 'mine', onRecall: recall
  }))
  const plain = 'The Biology final draft (https://school.example/a/1) is due November 24.\n\nNotion still shows November 20.'

  fireEvent.contextMenu(screen.getByTestId('chat-message-reply'))
  expect(menu.mock.lastCall?.[0]).toMatchObject({ options: ['Copy', 'Select text', 'Cancel'], cancelButtonIndex: 2 })
  act(() => menu.mock.lastCall?.[1](0))
  expect(Clipboard.setStringAsync).toHaveBeenLastCalledWith(plain)

  // Every paragraph in one place, as the bubble reads.
  expect(screen.queryByTestId('select-text')).toBeNull()
  act(() => menu.mock.lastCall?.[1](1))
  expect(screen.getByTestId('select-text-body').textContent).toBe(plain)

  // Your own words are copied as you wrote them, and the latest can still be recalled.
  fireEvent.contextMenu(screen.getByTestId('chat-message-mine'))
  expect(menu.mock.lastCall?.[0]).toMatchObject({ options: ['Copy', 'Select text', 'Recall', 'Cancel'], destructiveButtonIndex: 2 })
  act(() => menu.mock.lastCall?.[1](0))
  expect(Clipboard.setStringAsync).toHaveBeenLastCalledWith('When is **it** due?')
  act(() => menu.mock.lastCall?.[1](2))
  expect(recall).toHaveBeenCalledWith('mine')
  act(() => menu.mock.lastCall?.[1](3))
  expect(recall).toHaveBeenCalledTimes(1)
})

it('offers reactions on a bot\'s message that can take one, and takes yours back from its chip', () => {
  const menu = vi.mocked(ActionSheetIOS.showActionSheetWithOptions)
  menu.mockClear()
  const react = vi.fn()
  const items: ChatItem[] = [
    { kind: 'message', id: 'mine', role: 'user', text: 'Thanks!', reactions: [{ emoji: '🎉', mine: false }] },
    { kind: 'message', id: 'reply', role: 'bot', text: 'Booked the **9am**.', rowId: 'a2', reactions: [{ emoji: '👍', mine: true }] },
    // Not read back from history yet: no row to name, so the system's menu.
    { kind: 'message', id: 'unsaved', role: 'bot', text: 'One more thing.' }
  ]
  render(createElement(ChatScreen, {
    title: 'Owl', face: { name: 'Owl' }, items, onSend: vi.fn(), onApprove: vi.fn(),
    renderMessageText: item => createElement('span', null, item.text), onReact: react
  }))

  expect(screen.queryByTestId('message-menu')).toBeNull()
  fireEvent.contextMenu(screen.getByTestId('chat-message-reply'))
  expect(menu).not.toHaveBeenCalled()
  expect(screen.getByTestId('message-menu')).toBeTruthy()
  fireEvent.click(screen.getByTestId('message-react-❤️'))
  expect(react).toHaveBeenLastCalledWith('a2', '❤️')
  expect(screen.queryByTestId('message-menu')).toBeNull()

  // The menu still copies the message as its bubble reads.
  fireEvent.contextMenu(screen.getByTestId('chat-message-reply'))
  fireEvent.click(screen.getByTestId('message-menu-copy'))
  expect(Clipboard.setStringAsync).toHaveBeenLastCalledWith('Booked the 9am.')

  // Your chip takes your reaction back; the bot's on your message does nothing.
  const chips = (id: string) => screen.getByTestId(`chat-reactions-${id}`).firstElementChild!
  fireEvent.click(chips('reply'))
  expect(react).toHaveBeenLastCalledWith('a2', '👍')
  react.mockClear()
  fireEvent.click(chips('mine'))
  expect(react).not.toHaveBeenCalled()

  fireEvent.contextMenu(screen.getByTestId('chat-message-unsaved'))
  expect(menu.mock.lastCall?.[0]).toMatchObject({ options: ['Copy', 'Select text', 'Cancel'] })
})

it('says what the bot is doing in two parts, and marks a bot it messaged', () => {
  const thread = vi.fn()
  const items: ChatItem[] = [
    { kind: 'ask', id: 'ask-1', before: 'Messaged', after: '', name: 'Biology', face: { name: 'Biology' }, bot: 'biology', peer: 'hexbot' },
    { kind: 'ask', id: 'ask-2', before: '', after: 'helped', name: 'A teammate' }
  ]
  render(createElement(ChatScreen, {
    title: 'HexBot', face: { name: 'HexBot' }, items, onSend: vi.fn(), onApprove: vi.fn(),
    waiting: { label: { object: 'Taobao', verb: 'Opening' }, mood: 'computer' }, onOpenThread: thread
  }))
  expect(screen.getByTestId('chat-waiting').textContent).toBe('Opening Taobao')
  expect(screen.getByTestId('chat-ask-ask-1').textContent).toBe('MessagedBiology')
  fireEvent.click(screen.getByTestId('chat-ask-ask-1'))
  expect(thread).toHaveBeenCalledWith('biology', 'hexbot')
  // Without the two bots' names there is no conversation to open.
  fireEvent.click(screen.getByTestId('chat-ask-ask-2'))
  expect(thread).toHaveBeenCalledTimes(1)
})
