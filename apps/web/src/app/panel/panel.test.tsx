import { fireEvent, render, screen } from '@testing-library/react'
import { vi } from 'vitest'

import { setActiveRpc } from '../../lib/rpc'
import type { Bot } from '../../lib/types'
import { emptyTranscript, useTranscripts } from '../../stores/transcripts'

import { ComputerTab, DreamingBlock, MemorySectionEditor } from './index'

describe('core memory editor', () => {
  it('shows the counter and refuses text over the section cap', () => {
    const save = vi.fn().mockResolvedValue(undefined)
    render(<MemorySectionEditor cap={4_000} label="user" onSave={save} value="hello" />)
    expect(screen.getByText('5 / 4000')).toBeVisible()
    const input = screen.getByLabelText('user memory')
    fireEvent.change(input, { target: { value: 'x'.repeat(4_001) } })
    fireEvent.blur(input)
    expect(screen.getByRole('alert')).toHaveTextContent('4000 characters or fewer')
    expect(save).not.toHaveBeenCalled()
  })
})

describe('computer tab', () => {
  it('shows session cwd and newest tool activity first', () => {
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => null),
      removeItem: vi.fn(),
      setItem: vi.fn()
    })
    useTranscripts.setState({
      bySession: {
        'live-1': {
          ...emptyTranscript('live-1', 'section-1'),
          info: { cwd: '/workspace' },
          messages: [
            {
              attachments: [],
              createdAt: 1,
              id: 'a',
              role: 'assistant',
              streaming: true,
              text: '',
              toolCalls: [
                {
                  args: {},
                  durationS: 0.5,
                  name: 'read_file',
                  result: {},
                  startedAt: 1,
                  status: 'ok',
                  toolId: 'old'
                },
                {
                  args: {},
                  durationS: null,
                  name: 'terminal',
                  result: null,
                  startedAt: 2,
                  status: 'running',
                  toolId: 'new'
                }
              ]
            }
          ]
        }
      }
    })
    render(<ComputerTab sessionId="live-1" />)
    expect(screen.getByText('/workspace')).toBeVisible()
    expect(screen.getAllByRole('listitem').map(item => item.textContent)).toEqual([
      'terminalrunningRunning',
      'read_fileok0.50s'
    ])
  })
})

describe('dreaming block', () => {
  it('loads status and updates the per-bot toggle', async () => {
    setActiveRpc({
      call: vi.fn((method: string) =>
        Promise.resolve(
          method.endsWith('.status')
            ? {
                enabled: true,
                last_run_at: 1,
                next_run_at: 2,
                last_status: 'complete',
                last_error: null
              }
            : { dreams: [] }
        )
      )
    } as never)
    const save = vi.fn().mockResolvedValue(undefined)

    const bot = {
      avatar: null,
      created_at: 0,
      description: '',
      display_name: 'Claude',
      dream_enabled: true,
      last_activity_at: 0,
      may_write_core: false,
      model: null,
      name: 'claude',
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

    render(<DreamingBlock bot={bot} onSave={save} />)
    expect(await screen.findByText('Dream now')).toBeEnabled()
    fireEvent.click(screen.getByLabelText('May write core memory'))
    expect(save).toHaveBeenCalledWith({ may_write_core: true })
    setActiveRpc(null)
  })
})
