// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { ChatScreen } from '../screens/ChatScreen'
import type { ChatItem } from '../screens/types'

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
vi.mock('../screens/MediaAttachment', () => ({ MediaAttachment: () => null }))
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
// The card says whether it joins the bubble above it; its margin is the card's own style.
vi.mock('../screens/SignInCard', async () => {
  const { createElement } = await import('react')
  return {
    SignInCard: ({ joined, request }: { joined?: boolean; request: { requestId: string } }) =>
      createElement('div', { 'data-testid': `card-${request.requestId}` }, joined ? 'joined' : 'apart')
  }
})
afterEach(cleanup)

const card = (id: string): ChatItem => ({
  kind: 'approval', id, request: { requestId: id, choices: ['once', 'deny'], form: { kind: 'sign_in', site: 'notion.so', title: 'Notion' } }
})

it("joins a waiting card to the bot's own bubble, never to yours or another person's", () => {
  const items: ChatItem[] = [
    { kind: 'message', id: 'mine', role: 'user', text: 'Check Notion' },
    card('after-mine'),
    { kind: 'message', id: 'bot', role: 'bot', text: 'Trying the browser.' },
    card('after-bot'),
    card('after-card'),
    { kind: 'message', id: 'ana', role: 'human', text: 'Me too', author: { name: 'Ana' } },
    card('after-person')
  ]
  render(createElement(ChatScreen, { title: 'Room', members: [], items, onSend: vi.fn(), onApprove: vi.fn() }))
  expect(screen.getByTestId('card-after-mine').textContent).toBe('apart')
  expect(screen.getByTestId('card-after-bot').textContent).toBe('joined')
  expect(screen.getByTestId('card-after-card').textContent).toBe('joined')
  expect(screen.getByTestId('card-after-person').textContent).toBe('apart')
})


