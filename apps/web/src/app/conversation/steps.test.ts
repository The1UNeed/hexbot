import { describe, expect, it } from 'vitest'

import type { Connector, Message, ToolCall } from '../../lib/types'
import { useConnectors } from '../../stores/connectors'

import {
  activityLabel,
  liveStatus,
  runningLabel,
  toolLabel,
  visibleSteps,
  workShown,
  workSummary
} from './steps'

const call = (partial: Partial<ToolCall>): ToolCall => ({
  args: null,
  durationS: null,
  name: 'terminal',
  result: null,
  startedAt: 0,
  status: 'ok',
  toolId: partial.name ?? 'tool',
  ...partial
})

const message = (partial: Partial<Message>): Message => ({
  attachments: [],
  createdAt: 0,
  id: 'm',
  role: 'assistant',
  streaming: true,
  text: '',
  toolCalls: [],
  ...partial
})

describe('toolLabel', () => {
  it('phrases known tools with their preview', () => {
    expect(toolLabel(call({ name: 'web_search', status: 'running', summary: 'weather' }))).toBe(
      'Searching the web for weather'
    )
    expect(toolLabel(call({ name: 'web_search', summary: 'weather' }))).toBe(
      'Searched the web for weather'
    )
    expect(toolLabel(call({ name: 'terminal', summary: 'date' }), 'live')).toBe('Running date')
    // Room members get no preview of another person's bot.
    expect(toolLabel(call({ name: 'terminal' }), 'live')).toBe('Running a command')
    expect(toolLabel(call({ name: 'read_file' }))).toBe('Read a file')
    expect(toolLabel(call({ name: 'web_search' }))).toBe('Searched the web')
    expect(toolLabel(call({ name: 'ls', status: 'running', summary: 'src' }))).toBe(
      'Listing files in src'
    )
    expect(toolLabel(call({ name: 'ls', summary: 'src' }))).toBe('Listed files in src')
    expect(toolLabel(call({ name: 'ls' }))).toBe('Listed files')
  })

  it('drops the preview for tools where it is noise', () => {
    expect(toolLabel(call({ name: 'memory', summary: '+: "</think><tool_call>"' }))).toBe(
      'Updated memory'
    )
  })

  it('falls back to the tool name', () => {
    expect(toolLabel(call({ name: 'mcp_calendar_list', status: 'running' }))).toBe(
      'Connecting to Calendar'
    )
    expect(toolLabel(call({ name: 'mcp_calendar_list' }))).toBe('Used Calendar')
  })

  it('truncates long previews', () => {
    const summary = 'x'.repeat(80)
    expect(toolLabel(call({ name: 'read_file', summary }))).toBe(`Read ${'x'.repeat(59)}…`)
  })
})

describe('runningLabel', () => {
  it('names the running tool and nothing else', () => {
    expect(runningLabel(message({}))).toBeUndefined()
    expect(runningLabel(message({ text: 'Sure' }))).toBeUndefined()
    expect(
      runningLabel(
        message({
          text: 'Sure',
          toolCalls: [
            call({ name: 'read_file', summary: 'a.txt' }),
            call({ name: 'web_search', status: 'running', summary: 'x' })
          ]
        })
      )
    ).toBe('Searching the web for x')
  })
})

describe('visibleSteps', () => {
  it('drops housekeeping', () => {
    expect(visibleSteps([call({ name: 'memory' }), call({ name: 'terminal' })])).toHaveLength(1)
  })
})

describe('activityLabel', () => {
  it('says what the bot is doing in plain words, never the command or query', () => {
    expect(activityLabel(call({ name: 'web_search', summary: 'apple' }), 'Scout')).toBe(
      'Scout is searching the web'
    )
    expect(activityLabel(call({ name: 'terminal', summary: 'rm -rf build' }), 'Scout')).toBe(
      'Scout is running a command'
    )
    expect(activityLabel(call({ name: 'mcp_github_create_issue' }), 'Scout')).toBe(
      'Connecting to GitHub'
    )
    expect(activityLabel(call({ name: 'mcp_linear_list_issues' }), 'Scout')).toBe(
      'Connecting to Linear'
    )
    // A loaded server whose name has an underscore is read whole.
    useConnectors.setState({
      byBot: { scout: [{ mcp: { name: 'project_tools' }, name: 'project_tools' } as Connector] }
    })
    expect(activityLabel(call({ name: 'mcp_project_tools_search' }), 'Scout')).toBe(
      'Connecting to Project tools'
    )
    expect(activityLabel(call({ name: 'mcp__project_tools__search' }), 'Scout')).toBe(
      'Connecting to Project tools'
    )
    expect(toolLabel(call({ name: 'codemode' }))).toBe('Ran code')
    expect(toolLabel(call({ name: 'codemode', status: 'running' }))).toBe('Running code')
    useConnectors.setState({ byBot: {} })
    expect(activityLabel(call({ name: 'weather_lookup' }), 'Scout')).toBe(
      'Scout is using weather lookup'
    )
  })
})

describe('workShown', () => {
  it('waits for the turn to run a while, then keeps long work and drops short work', () => {
    const now = 100_000
    const live = message({ createdAt: now - 500, thinking: 'Hmm.' })
    expect(workShown(live, now)).toBe(false)
    expect(workShown(live, now + 2_000)).toBe(true)
    expect(workShown(message({ createdAt: now - 5_000 }), now)).toBe(false)

    const done = (workUntil: number) =>
      message({ createdAt: now, streaming: false, thinking: 'Hmm.', workUntil })

    expect(workShown(done(now + 800))).toBe(false)
    expect(workShown(done(now + 2_500))).toBe(true)
  })

  it('shows restored steps whose timing is unknown', () => {
    expect(workShown(message({ createdAt: 0, streaming: false, toolCalls: [call({})] }))).toBe(true)
  })
})

describe('workSummary', () => {
  it.each([undefined, 'Hmm.'])(
    'reads a step blocked on approval as live work, trace %s',
    thinking => {
      const pending = call({ status: 'running', summary: 'rm -rf ./approval-probe' })
      const blocked = message({ streaming: false, thinking, toolCalls: [pending] })
      expect(workSummary(blocked, 'Scout')).toBe('Scout is running a command')
      expect(workSummary({ ...blocked, toolCalls: [{ ...pending, status: 'ok' }] })).not.toContain(
        'rm -rf'
      )
    }
  )

  it('names only the time, never the steps or their costs', () => {
    expect(workSummary(message({ createdAt: 1_000, thinking: 'Hmm.', workUntil: 13_400 }))).toBe(
      'Thought for 12s'
    )
    expect(
      workSummary(
        message({
          createdAt: 1_000,
          thinking: 'Hmm.',
          toolCalls: [call({ name: 'terminal' }), call({ name: 'read_file' })],
          workUntil: 61_000
        })
      )
    ).toBe('Thought for 1m')
    expect(
      workSummary(message({ toolCalls: [call({ durationS: 2.6, name: 'web_search' })] }))
    ).toBe('Worked for 3s')
  })

  it('counts steps when restored history has no timing, and is empty for housekeeping', () => {
    expect(workSummary(message({ toolCalls: [call({ durationS: null, name: 'terminal' })] }))).toBe(
      'Worked on 1 step'
    )
    expect(workSummary(message({ toolCalls: [call({ name: 'memory' })] }))).toBe('')
  })
})

describe('liveStatus', () => {
  it('prefers the running step, then a wait notice, then what the bot is doing', () => {
    expect(liveStatus(message({ activity: 'waiting on the provider' }), 'Scout').label).toBe(
      'waiting on the provider'
    )

    const running = liveStatus(
      message({
        activity: 'waiting',
        toolCalls: [call({ name: 'web_search', status: 'running', summary: 'x' })]
      }),
      'Scout'
    )

    expect(running.label).toBe('Scout is searching the web')
    expect(running.call?.name).toBe('web_search')
    expect(liveStatus(message({}), 'Scout')).toEqual({ label: 'Scout is working' })
    expect(liveStatus(message({ thinking: 'Hmm.' }), 'Scout').label).toBe('Scout is thinking')
    expect(liveStatus(message({ text: 'Sure', thinking: 'Hmm.' }), 'Scout').label).toBe(
      'Scout is writing'
    )
  })
})
