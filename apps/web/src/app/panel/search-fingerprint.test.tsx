import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { vi } from 'vitest'

import type { Bot, Message } from '../../lib/types'
import { useBots } from '../../stores/bots'
import { useSearch } from '../../stores/search'
import { useSections } from '../../stores/sections'
import { useTranscripts } from '../../stores/transcripts'
import { useUi } from '../../stores/ui'
import { useVisuals } from '../../stores/visuals'

import { ProfilePanel } from './index'

// The ui store persists to localStorage, which Node shadows without a file; give it memory.
vi.hoisted(() => {
  const items = new Map<string, string>()

  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      clear: () => items.clear(),
      getItem: (key: string) => items.get(key) ?? null,
      key: (index: number) => [...items.keys()][index] ?? null,
      get length() {
        return items.size
      },
      removeItem: (key: string) => items.delete(key),
      setItem: (key: string, value: string) => items.set(key, String(value))
    }
  })
})

const api = vi.hoisted(() => ({
  botMemoryGet: vi.fn(),
  botMemorySet: vi.fn()
}))

vi.mock('../../lib/api', async importOriginal => ({
  ...(await importOriginal<object>()),
  ...api
}))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({})
}))

const bot = {
  avatar: null,
  created_at: 0,
  description: '',
  display_name: 'Muse',
  dream_enabled: true,
  last_activity_at: 0,
  model: 'glm-5',
  name: 'muse',
  owner_id: 'local',
  persona: '# SOUL.md\n\nBe genuinely helpful.',
  persona_updated_at: Date.UTC(2026, 9, 25, 12) / 1000,
  provider: null,
  sections_recent: [],
  sections_total: 0,
  skills: [],
  title: '',
  tools: [],
  updated_at: 0
} satisfies Bot

const messages: Message[] = [
  {
    attachments: [{ id: 'a', kind: 'file', mime: 'text/csv', name: 'trips.csv', size: 2048 }],
    createdAt: 0,
    id: 'm1',
    role: 'user',
    sentAt: Date.UTC(2026, 9, 20),
    streaming: false,
    text: 'Plan the Lisbon trip',
    toolCalls: []
  },
  {
    attachments: [],
    createdAt: 0,
    id: 'm2',
    role: 'assistant',
    sentAt: Date.UTC(2026, 9, 21),
    streaming: false,
    text: 'Here is a Lisbon itinerary.',
    toolCalls: [
      {
        args: { html: '<h1>Lisbon days</h1>', title: 'Trip map' },
        durationS: 1,
        name: 'hexbot_show_html',
        result: null,
        startedAt: 0,
        status: 'ok',
        toolId: 'v1'
      }
    ]
  }
]

// jsdom lays nothing out; the editor measures the caret to scroll it into view.
beforeAll(() => {
  const rects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList
  const box = () => new DOMRect()

  Object.assign(Range.prototype, { getBoundingClientRect: box, getClientRects: rects })
  Object.assign(Element.prototype, { getClientRects: rects })
  Object.assign(document, { elementFromPoint: () => null })
})

function seed() {
  // A wide window: the panel sits beside the chat.
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ addEventListener: vi.fn(), matches: false, removeEventListener: vi.fn() }))
  )
  useBots.setState({ byName: { muse: bot } })
  useUi.setState({ lastSection: { bot: 'muse', section: 'chat' }, panelTab: 'details' })
  useSearch.getState().reset()
  useVisuals.setState({ active: null, tabs: [] })
  useSections.setState({ liveSessionId: { chat: 's' } })
  useTranscripts.setState({
    bySession: {
      s: {
        approvals: [],
        clarifies: [],
        context: null,
        error: null,
        info: null,
        messages,
        sessionId: 's',
        status: null,
        streamingMessageId: null,
        usage: null
      }
    }
  })
  api.botMemoryGet.mockResolvedValue({
    cap: 2200,
    memory_md: 'Prefers trains over flights.',
    updated_at: Date.UTC(2026, 9, 29, 12) / 1000
  })
}

describe('panel search', () => {
  beforeEach(seed)

  it('searches the chat and shows what it found', async () => {
    render(<ProfilePanel />)

    fireEvent.click(screen.getByRole('button', { name: 'Search this chat' }))
    const field = screen.getByRole('searchbox', { name: 'Search your chat with Muse' })
    expect(field).toHaveFocus()
    expect(screen.queryByRole('tablist')).toBeNull()

    fireEvent.change(field, { target: { value: 'lisbon' } })
    const results = await screen.findByTestId('search-results')
    expect(within(results).getByText('Messages')).toBeVisible()
    expect(within(results).getByText('Trip map')).toBeVisible()

    // A message scrolls the chat to itself.
    fireEvent.click(within(results).getByText('Here is a', { exact: false }))
    expect(useSearch.getState().jump).toEqual({ id: 'm2', nonce: 1 })

    // A visual opens beside the chat.
    fireEvent.click(within(results).getByText('Trip map'))
    expect(useVisuals.getState().tabs.map(tab => tab.title)).toEqual(['Trip map'])
  })

  it('finds files and memory, and says when nothing matches', async () => {
    render(<ProfilePanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Search this chat' }))
    const field = screen.getByRole('searchbox')

    fireEvent.change(field, { target: { value: 'trips' } })
    expect(await screen.findByText('Files')).toBeVisible()

    fireEvent.change(field, { target: { value: 'trains' } })
    expect(await screen.findByText('Soul and memory')).toBeVisible()

    fireEvent.change(field, { target: { value: 'zebra' } })
    expect(await screen.findByText('Nothing matches “zebra”.')).toBeVisible()

    // Escape clears, then leaves search.
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(field).toHaveValue('')
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(screen.getByRole('tablist')).toBeVisible()
  })

  it('lists the visuals the bot drew in Library', () => {
    render(<ProfilePanel />)

    fireEvent.click(screen.getByRole('tab', { name: 'Library' }))
    fireEvent.click(screen.getByRole('button', { name: /Trip map/ }))
    expect(useVisuals.getState().tabs.map(tab => tab.toolId)).toEqual(['v1'])
    expect(screen.getByText('trips.csv')).toBeVisible()
  })
})

describe('Fingerprint', () => {
  beforeEach(seed)

  it('shows soul and memory with the day each changed', async () => {
    render(<ProfilePanel />)

    fireEvent.click(screen.getByRole('tab', { name: 'Fingerprint' }))
    const soul = screen.getByTestId('fingerprint-soul')
    expect(soul).toHaveTextContent('Soul')
    expect(soul).toHaveTextContent(/25/)
    await waitFor(() => expect(screen.getByTestId('fingerprint-memory')).toHaveTextContent(/29/))
  })

  it('opens soul formatted, saves its source, and closes on Escape', async () => {
    const update = vi.fn(async () => {})
    useBots.setState({ update } as never)
    render(<ProfilePanel />)

    fireEvent.click(screen.getByRole('tab', { name: 'Fingerprint' }))
    fireEvent.click(screen.getByTestId('fingerprint-soul'))

    const editor = await screen.findByTestId('document-editor')
    expect(within(editor).getByRole('heading', { level: 1, name: 'SOUL.md' })).toBeVisible()
    expect(within(editor).getByText('About this file.')).toBeVisible()

    fireEvent.click(within(editor).getByRole('button', { name: 'More' }))
    fireEvent.click(await screen.findByText('View source'))
    const source = within(editor).getByRole('textbox', { name: 'Muse · Soul source' })
    expect(source).toHaveValue('# SOUL.md\n\nBe genuinely helpful.')

    fireEvent.change(source, { target: { value: '# SOUL.md\n\nBe kind.' } })
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith('muse', { persona: '# SOUL.md\n\nBe kind.' })
    )

    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' })
    })
    expect(screen.queryByTestId('document-editor')).toBeNull()
  })

  it('keeps the editor open with the error when a save is refused', async () => {
    const update = vi.fn(async () => {
      throw new Error('soul is too long')
    })

    useBots.setState({ update } as never)
    render(<ProfilePanel />)

    fireEvent.click(screen.getByRole('tab', { name: 'Fingerprint' }))
    fireEvent.click(screen.getByTestId('fingerprint-soul'))
    const editor = await screen.findByTestId('document-editor')
    fireEvent.click(within(editor).getByRole('button', { name: 'More' }))
    fireEvent.click(await screen.findByText('View source'))
    fireEvent.change(within(editor).getByRole('textbox', { name: 'Muse · Soul source' }), {
      target: { value: 'Too long' }
    })

    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' })
    })
    expect(update).toHaveBeenCalled()
    expect(screen.getByTestId('document-editor')).toBeVisible()
    expect(within(editor).getByRole('alert')).toHaveTextContent('soul is too long')
  })

  it('viewing the source and closing without an edit saves nothing', async () => {
    const update = vi.fn(async () => {})
    // The editor writes these bullets back as "- ", which must not count as an edit.
    useBots.setState({
      byName: { muse: { ...bot, persona: '# Soul\n\n* Be kind\n* Be brief' } },
      update
    } as never)
    render(<ProfilePanel />)

    fireEvent.click(screen.getByRole('tab', { name: 'Fingerprint' }))
    fireEvent.click(screen.getByTestId('fingerprint-soul'))
    const editor = await screen.findByTestId('document-editor')
    fireEvent.click(within(editor).getByRole('button', { name: 'More' }))
    fireEvent.click(await screen.findByText('View source'))

    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' })
    })
    expect(screen.queryByTestId('document-editor')).toBeNull()
    expect(update).not.toHaveBeenCalled()
  })

  it('opening and closing without an edit saves nothing', async () => {
    const update = vi.fn(async () => {})
    useBots.setState({ update } as never)
    render(<ProfilePanel />)

    fireEvent.click(screen.getByRole('tab', { name: 'Fingerprint' }))
    fireEvent.click(await screen.findByTestId('fingerprint-memory'))
    await screen.findByTestId('document-editor')

    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' })
    })
    expect(screen.queryByTestId('document-editor')).toBeNull()
    expect(api.botMemorySet).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })
})
