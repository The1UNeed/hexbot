import { act, fireEvent, render, screen } from '@testing-library/react'
import { vi } from 'vitest'

import type { Bot, ToolCall } from '../../lib/types'
import { useBots } from '../../stores/bots'
import { useComputer } from '../../stores/computer'
import { useConnection } from '../../stores/connection'
import { useSections } from '../../stores/sections'
import { useTranscripts } from '../../stores/transcripts'
import { useUi } from '../../stores/ui'

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
  computerControl: vi.fn(),
  computerStatus: vi.fn(),
  computerView: vi.fn()
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
  display_name: 'Scout',
  dream_enabled: true,
  last_activity_at: 0,
  model: 'glm-5',
  name: 'scout',
  owner_id: 'local',
  persona: '',
  provider: null,
  sections_recent: [],
  sections_total: 0,
  skills: [],
  title: '',
  tools: [],
  updated_at: 0
} satisfies Bot

const call = (partial: Partial<ToolCall>): ToolCall => ({
  args: { command: 'date' },
  durationS: 1,
  name: 'terminal',
  result: 'Fri',
  startedAt: 0,
  status: 'ok',
  summary: 'date',
  toolId: partial.toolId ?? 't',
  ...partial
})

function seed(calls: ToolCall[], streaming: boolean) {
  useBots.setState({ byName: { scout: bot } })
  useUi.setState({ lastSection: { bot: 'scout', section: 'daily' }, panelTab: 'details' })
  useSections.setState({ liveSessionId: { daily: 's' } })
  useTranscripts.setState({
    bySession: {
      s: {
        approvals: [],
        clarifies: [],
        error: null,
        info: null,
        messages: [
          {
            attachments: [],
            createdAt: 0,
            id: 'm',
            role: 'assistant',
            streaming,
            text: '',
            toolCalls: calls
          }
        ],
        context: null,
        sessionId: 's',
        status: null,
        streamingMessageId: streaming ? 'm' : null,
        usage: null
      }
    }
  })
}

describe('ProfilePanel', () => {
  it('follows a running step on Computer and in the status under the name', () => {
    seed(
      [
        call({ toolId: 'a' }),
        call({ name: 'memory', summary: '', toolId: 'b' }),
        call({ status: 'running', summary: 'ls', toolId: 'c' })
      ],
      true
    )
    render(<ProfilePanel />)

    // The status under the name names the running step and opens Computer.
    fireEvent.click(screen.getByRole('button', { name: 'Scout is running a command' }))
    expect(screen.getByRole('tab', { name: 'Computer' })).toHaveAttribute('aria-selected', 'true')

    // Every call is listed, housekeeping included, newest first.
    const steps = screen.getByTestId('computer-steps')
    expect(steps.querySelectorAll('li')).toHaveLength(3)
    expect(steps.querySelector('li')).toHaveTextContent('Running ls')
  })

  it('says how to fill an empty Library and Computer', () => {
    seed([], false)
    render(<ProfilePanel />)

    fireEvent.click(screen.getByRole('tab', { name: 'Library' }))
    expect(screen.getByText('Images and files you share with Scout show up here.')).toBeVisible()
    fireEvent.click(screen.getByRole('tab', { name: 'Computer' }))
    expect(screen.getByText(/each step shows up here/)).toBeVisible()
  })

  it("shows the bots' computer live, with each bot's cursor, and hands it over", async () => {
    const running = {
      activity: null,
      actor: null,
      available: true,
      control: 'bot' as const,
      cursors: [],
      error: null,
      size: 'small' as const,
      sizes: [],
      state: 'running' as const
    }

    api.computerStatus.mockResolvedValue(running)
    api.computerView.mockResolvedValue({
      control: false,
      expires_at: 0,
      path: '/hexbot/computer/t/viewer/#ticket=v'
    })
    api.computerControl.mockResolvedValue({ ...running, control: 'user' })
    useComputer.setState({ error: null, status: null })
    useConnection.setState({ target: { kind: 'local', origin: 'http://127.0.0.1:9119' } })
    // Computer actions are not steps: the screen shows them.
    seed(
      [
        call({ name: 'computer_use', summary: 'click', toolId: 'a' }),
        call({ summary: 'ls', toolId: 'b' })
      ],
      false
    )
    useBots.setState({
      byName: {
        owl: { ...bot, display_name: 'Owl', name: 'owl', tools: ['computer_use'] },
        scout: { ...bot, tools: ['computer_use'] }
      }
    })
    render(<ProfilePanel />)
    fireEvent.click(screen.getByRole('tab', { name: 'Computer' }))
    expect(screen.getByTestId('computer-steps').querySelectorAll('li')).toHaveLength(1)

    // A small screen that only watches, through the daemon.
    const frame = await screen.findByTitle("Your bots' screen")
    expect(frame).toHaveAttribute(
      'src',
      'http://127.0.0.1:9119/hexbot/computer/t/viewer/#ticket=v&audio=off&fps=12'
    )
    expect(api.computerView).toHaveBeenCalledWith(false)

    // Two bots on it: each has a cursor where it last acted, and the line
    // under the screen says who is acting.
    const now = Date.now() / 1000
    act(() =>
      useComputer.getState().apply({
        activity: 'click',
        actor: 'scout',
        cursors: [
          { action: 'click', at: now, bot: 'scout', x: 0.5, y: 0.25 },
          { action: 'type', at: now - 2, bot: 'owl', x: 0.1, y: 0.9 }
        ]
      })
    )
    expect(screen.getByTestId('computer-caption')).toHaveTextContent(
      'Scout is clicking on the computer'
    )
    const scout = screen.getByRole('img', { name: "Scout's cursor" })
    expect(scout).toHaveStyle({ left: '50%', top: '25%' })
    expect(scout.querySelector('.hex-cursor-press')).not.toBeNull()
    expect(screen.getByRole('img', { name: "Owl's cursor" })).toHaveAttribute('data-stale', 'false')

    // Taking over opens it large; the bots wait until it is given back.
    fireEvent.click(screen.getByRole('button', { name: 'Take control' }))
    expect(api.computerControl).toHaveBeenCalledWith('user')
    expect(await screen.findByRole('button', { name: 'Give back' })).toBeVisible()
    // The window and the line under the small screen both say who has it.
    expect(
      await screen.findAllByText('You have control. Your bots wait until you give it back.')
    ).toHaveLength(2)
  })
})
