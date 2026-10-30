// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { ChatScreen } from '../screens/ChatScreen'
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
    FlatList: ({ data, renderItem }: { data: { id: string }[]; renderItem: (input: unknown) => ReactNode }) =>
      createElement('div', null, data.map((item, index) => createElement('div', { key: item.id }, renderItem({ item, index }))))
  }
})
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }))
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
    bubbleFill: () => 'grey', withAlpha: () => 'grey', radius: {}, mono: 'monospace'
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
    onSend: vi.fn(), onBack: vi.fn(), onApprove: vi.fn(), renderMessageText: renderText
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
    title: 'Owl', face: { name: 'Owl' }, items, onSend: vi.fn(), onBack: vi.fn(), onApprove: vi.fn()
  }))
  expect([0, 180, 24 * 60].map(minutes => screen.getByText(formatDayDivider(at(minutes))))).toHaveLength(3)
  for (const minutes of [2, 12, 30]) expect(screen.queryByText(formatDayDivider(at(minutes)))).toBeNull()
})
