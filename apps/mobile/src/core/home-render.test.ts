// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { HomeScreen, type HomeScreenProps } from '../screens/HomeScreen'
import type { ConnectionState } from '../screens/types'

vi.mock('react-native', async () => {
  const { createElement } = await import('react')
  const view = ({ children }: { children?: ReactNode }) => createElement('div', null, children)
  return {
    View: view, Pressable: view, Modal: () => null, TextInput: () => null, RefreshControl: () => null,
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    FlatList: ({ ListEmptyComponent, data }: { ListEmptyComponent?: ReactNode; data: unknown[] }) =>
      createElement('div', null, data.length ? null : ListEmptyComponent)
  }
})
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }))
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }))
vi.mock('../ui', async () => {
  const { createElement } = await import('react')
  const view = ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement('div', { 'data-testid': testID }, children)
  return {
    Text: view, Screen: view, Glass: view, IconButton: () => null,
    BotFace: () => null, PersonFace: () => null, RoomFace: () => null,
    ContextMenu: () => null, Field: () => null, ModalSheet: () => null,
    Banner: ({ message, testID }: { message: string; testID: string }) =>
      createElement('div', { 'data-testid': testID }, message),
    Button: ({ label, testID }: { label: string; testID: string }) =>
      createElement('button', { 'data-testid': testID }, label),
    EmptyState: ({ action, message, testID, title }: { action?: ReactNode; message?: string; testID: string; title: string }) =>
      createElement('div', { 'data-testid': testID }, title, message, action),
    formatListTime: () => '', useKeyboardVisible: () => false, useTheme: () => ({}), HIT: 44
  }
})
afterEach(cleanup)

const home = (state: ConnectionState, extra: Partial<HomeScreenProps> = {}) =>
  render(createElement(HomeScreen, {
    conversations: [], onOpen: vi.fn(), onOpenSettings: vi.fn(), onNewBot: vi.fn(),
    daemon: { name: 'Mac-mini.local', address: 'mac-mini.local:9119', via: 'lan', state },
    ...extra
  }))

it('does not call an unreachable daemon empty or offer to add HexBot to it', () => {
  home('offline')
  expect(screen.getByTestId('home-connection').textContent).toBe(
    'Cannot reach Mac-mini.local. It may be asleep or off the network.'
  )
  expect(screen.getByTestId('home-waiting-daemon').textContent).toContain('Nothing loaded yet')
  expect(screen.queryByTestId('home-empty')).toBeNull()
  expect(screen.queryByText('Add HexBot')).toBeNull()
})

it('offers HexBot once a connected daemon has no bots', () => {
  home('connected', { primaryChoice: { onAdd: vi.fn() } })
  expect(screen.getByTestId('home-empty').textContent).toContain('No bots yet')
  expect(screen.getByTestId('home-empty-primary').textContent).toBe('Add HexBot')
  expect(screen.queryByTestId('home-waiting-daemon')).toBeNull()
})
