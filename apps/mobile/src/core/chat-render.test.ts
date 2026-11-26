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

const nativeAnim = vi.hoisted(() => ({
  reduceMotion: false,
  timingCalls: [] as { toValue: number; duration: number; useNativeDriver?: boolean }[],
  loopStarts: 0,
  loopStops: 0
}))

// FlatList's native windowing is irrelevant here; exercise every production row.
vi.mock('react-native', async () => {
  const { createElement } = await import('react')
  const view = ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement('div', { 'data-testid': testID }, children)
  class MockValue {
    value: number
    constructor(initial: number) {
      this.value = initial
    }
    setValue(next: number) {
      this.value = next
    }
  }
  const composite = (onStart?: () => void, onStop?: () => void) => ({
    start: () => onStart?.(),
    stop: () => onStop?.()
  })
  return {
    View: view, ScrollView: view, Text: view, Image: () => null,
    AccessibilityInfo: {
      isReduceMotionEnabled: () => Promise.resolve(nativeAnim.reduceMotion),
      addEventListener: () => ({ remove: () => {} })
    },
    Animated: {
      Value: MockValue,
      View: view,
      timing: (_val: unknown, config: { toValue: number; duration: number; useNativeDriver?: boolean }) => {
        nativeAnim.timingCalls.push(config)
        return composite()
      },
      sequence: () => composite(),
      parallel: () => composite(),
      loop: () =>
        composite(
          () => {
            nativeAnim.loopStarts += 1
          },
          () => {
            nativeAnim.loopStops += 1
          }
        )
    },
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
const audio = vi.hoisted(() => ({
  currentStatus: { duration: 0, error: null },
  addListener: vi.fn((_event: string, _listener: (status: { error: string | null }) => void) => ({ remove: vi.fn() }))
}))
vi.mock('expo-audio', () => ({
  useAudioPlayer: () => audio, useAudioPlayerStatus: () => audio.currentStatus,
  setAudioModeAsync: vi.fn()
}))
vi.mock('expo-video', () => ({ useVideoPlayer: () => ({}), VideoView: () => null }))
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }))
vi.mock('../ui', async () => {
  const { createElement } = await import('react')
  const format = await import('../ui/format')
  const view = ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement('div', { 'data-testid': testID }, children)
  const text = ({
    accessibilityElementsHidden,
    children,
    testID,
    variant
  }: {
    accessibilityElementsHidden?: boolean
    children?: ReactNode
    testID?: string
    variant?: string
  }) =>
    createElement(
      'div',
      {
        'aria-hidden': accessibilityElementsHidden ? 'true' : undefined,
        'data-testid': testID,
        'data-variant': variant
      },
      children
    )
  return {
    ...format,
    Text: text, Screen: view, Glass: view, TopBar: () => null,
    BotFace: () => null, RoomFace: () => null, LoadingFace: () => null,
    Button: ({ accessibilityLabel, onPress, disabled, busy }: { accessibilityLabel?: string; onPress?: () => void; disabled?: boolean; busy?: boolean }) =>
      createElement('button', { 'aria-label': accessibilityLabel, onClick: onPress, disabled: disabled || busy }),
    IconButton: () => null, Banner: () => null,
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

it('waits for the cached chat to open, then reads only the recording selected', async () => {
  const load = vi.fn().mockResolvedValue('file:///sample')
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
  const props = { title: 'Owl', face: { name: 'Owl' }, items, onSend: vi.fn(), onApprove: vi.fn() }
  const view = render(createElement(ChatScreen, props))
  expect(screen.queryByRole('button', { name: 'Load voice.mp3' })).toBeNull()
  expect(screen.getByTestId('chat-file-a')).toBeDefined()
  view.rerender(createElement(ChatScreen, { ...props, loadMedia: load }))
  expect(load).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Load voice.mp3' }))
  expect(await screen.findByTestId('chat-audio')).toBeDefined()
  expect(load.mock.calls).toEqual([['/art/voice.mp3', 'a']])
  expect(screen.getByRole('button', { name: 'Load clip.mp4' })).toBeDefined()
  // The card cuts the name before its extension, so the extension always shows, and names the kind.
  expect(['notes', '.txt', 'Text'].map(text => screen.getByText(text).textContent)).toEqual([
    'notes',
    '.txt',
    'Text'
  ])
})

it('requests a fresh media link after the native player reports a failed stream', async () => {
  const load = vi.fn(async () => 'https://daemon.test/api/media/' + 'b'.repeat(32))
  const items: ChatItem[] = [{
    kind: 'message', id: 'made', role: 'bot', text: '',
    attachments: [{ id: 'a', kind: 'audio', name: 'voice.mp3', path: '/art/voice.mp3' }]
  }]
  render(createElement(ChatScreen, {
    title: 'Owl', items, loadMedia: load, onSend: vi.fn(), onApprove: vi.fn()
  }))
  fireEvent.click(screen.getByRole('button', { name: 'Load voice.mp3' }))
  await screen.findByTestId('chat-audio')
  const [, report] = audio.addListener.mock.lastCall!
  act(() => {
    report({ error: 'HTTP 410' })
    report({ error: null })
  })
  const retry = await screen.findByRole('button', { name: 'Reload voice.mp3' })
  expect(load).toHaveBeenCalledTimes(1)
  fireEvent.click(retry)
  expect(await screen.findByTestId('chat-audio')).toBeDefined()
  expect(load).toHaveBeenCalledTimes(2)
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
  const askRow = screen.getByTestId('chat-ask-ask-1')
  const visibleTexts = [...askRow.querySelectorAll('[data-variant]')].filter(
    el => el.getAttribute('aria-hidden') !== 'true'
  )
  expect(visibleTexts.map(el => el.textContent)).toEqual(['Messaged', 'Biology'])
  // Hidden sizer reserves the widest scaled label ("Message from") with the same caption style.
  const sizer = askRow.querySelector('[aria-hidden="true"]')
  expect(sizer?.textContent).toBe('Message from')
  expect(sizer?.getAttribute('data-variant')).toBe('caption')
  fireEvent.click(askRow)
  expect(thread).toHaveBeenCalledWith('biology', 'hexbot')
  // Without the two bots' names there is no conversation to open.
  fireEvent.click(screen.getByTestId('chat-ask-ask-2'))
  expect(thread).toHaveBeenCalledTimes(1)
})

it('animates live ask rows with native opacity, settles smoothly, stays still for history, and respects Reduce Motion', async () => {
  nativeAnim.reduceMotion = false
  nativeAnim.timingCalls = []
  nativeAnim.loopStarts = 0
  nativeAnim.loopStops = 0

  // 1. Settled history ask starts completely still.
  const settledItem: ChatItem = {
    kind: 'ask',
    id: 'hist-1',
    before: 'Message from',
    after: '',
    name: 'Biology',
    bot: 'biology',
    peer: 'hexbot'
  }
  const histView = render(
    createElement(ChatScreen, {
      title: 'HexBot',
      face: { name: 'HexBot' },
      items: [settledItem],
      onSend: vi.fn(),
      onApprove: vi.fn()
    })
  )
  await act(async () => {
    await Promise.resolve()
  })
  expect(nativeAnim.loopStarts).toBe(0)
  expect(nativeAnim.timingCalls).toHaveLength(0)
  histView.unmount()

  // 2. Running ask pulses with native opacity, then settles smoothly when done.
  const runningItem: ChatItem = {
    kind: 'ask',
    id: 'live-1',
    before: 'Messaging',
    after: '',
    name: 'Biology',
    bot: 'biology',
    peer: 'hexbot',
    running: true
  }
  const view = render(
    createElement(ChatScreen, {
      title: 'HexBot',
      face: { name: 'HexBot' },
      items: [runningItem],
      onSend: vi.fn(),
      onApprove: vi.fn()
    })
  )
  await act(async () => {
    await Promise.resolve()
  })
  expect(nativeAnim.loopStarts).toBe(1)
  expect(nativeAnim.timingCalls.every(call => call.useNativeDriver === true)).toBe(true)

  const beforeSettleTimings = nativeAnim.timingCalls.length
  view.rerender(
    createElement(ChatScreen, {
      title: 'HexBot',
      face: { name: 'HexBot' },
      items: [{ ...runningItem, before: 'Message from', running: false }],
      onSend: vi.fn(),
      onApprove: vi.fn()
    })
  )
  expect(nativeAnim.loopStops).toBe(1)
  expect(nativeAnim.timingCalls.length).toBeGreaterThan(beforeSettleTimings)
  expect(nativeAnim.timingCalls.slice(beforeSettleTimings).every(c => c.useNativeDriver === true)).toBe(true)
  view.unmount()

  // 3. Reduce Motion disables both the live pulse and the settle transition.
  nativeAnim.reduceMotion = true
  nativeAnim.timingCalls = []
  nativeAnim.loopStarts = 0
  nativeAnim.loopStops = 0
  const reduced = render(
    createElement(ChatScreen, {
      title: 'HexBot',
      face: { name: 'HexBot' },
      items: [runningItem],
      onSend: vi.fn(),
      onApprove: vi.fn()
    })
  )
  await act(async () => {
    await Promise.resolve()
  })
  expect(nativeAnim.loopStarts).toBe(0)
  expect(nativeAnim.timingCalls).toHaveLength(0)
  reduced.rerender(
    createElement(ChatScreen, {
      title: 'HexBot',
      face: { name: 'HexBot' },
      items: [{ ...runningItem, before: 'Message from', running: false }],
      onSend: vi.fn(),
      onApprove: vi.fn()
    })
  )
  expect(nativeAnim.timingCalls).toHaveLength(0)
  nativeAnim.reduceMotion = false
})
