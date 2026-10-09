import { fireEvent, render, screen } from '@testing-library/react'
import { vi } from 'vitest'

import type { Bot, ToolCall } from '../../lib/types'
import { useBots } from '../../stores/bots'
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
  shareable: false,
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
})
