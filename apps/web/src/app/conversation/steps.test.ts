import { describe, expect, it } from 'vitest'

import type { Message, ToolCall } from '../../lib/types'

import {
  liveLabel,
  runningLabel,
  stepsSummary,
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
  })

  it('drops the preview for tools where it is noise', () => {
    expect(toolLabel(call({ name: 'memory', summary: '+: "</think><tool_call>"' }))).toBe(
      'Updated memory'
    )
  })

  it('falls back to the tool name', () => {
    expect(toolLabel(call({ name: 'mcp_calendar_list', status: 'running' }))).toBe(
      'Using mcp calendar list'
    )
    expect(toolLabel(call({ name: 'mcp_calendar_list' }))).toBe('Used mcp calendar list')
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

describe('stepsSummary', () => {
  it('is empty when only housekeeping ran', () => {
    expect(stepsSummary([call({ name: 'memory' }), call({ name: 'todo_list' })])).toBe('')
    expect(visibleSteps([call({ name: 'memory' }), call({ name: 'terminal' })])).toHaveLength(1)
  })

  it('uses the single step label and the total time', () => {
    expect(stepsSummary([call({ name: 'web_search', summary: 'apple', durationS: 2.6 })])).toBe(
      'Searched the web for apple · 3s'
    )
  })

  it('counts several steps, including time spent on housekeeping', () => {
    expect(
      stepsSummary([
        call({ name: 'memory', durationS: 60 }),
        call({ name: 'terminal', durationS: 30 }),
        call({ name: 'read_file', durationS: 0.2 })
      ])
    ).toBe('2 steps · 2m')
    expect(stepsSummary([call({ name: 'terminal' }), call({ name: 'read_file' })])).toBe('2 steps')
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
    expect(
      workShown(message({ createdAt: 0, streaming: false, toolCalls: [call({})] }))
    ).toBe(true)
  })
})

describe('workSummary', () => {
  it('names the thinking time and the steps', () => {
    expect(
      workSummary(message({ createdAt: 1_000, thinking: 'Hmm.', workUntil: 13_400 }))
    ).toBe('Thought for 12s')
    expect(
      workSummary(
        message({
          createdAt: 1_000,
          thinking: 'Hmm.',
          toolCalls: [call({ name: 'terminal' }), call({ name: 'read_file' })],
          workUntil: 61_000
        })
      )
    ).toBe('Thought for 1m · 2 steps')
  })

  it('falls back to the step summary without a trace', () => {
    expect(workSummary(message({ toolCalls: [call({ name: 'terminal', summary: 'date' })] }))).toBe(
      'Ran date'
    )
  })
})

describe('liveLabel', () => {
  it('prefers the running step, then a wait notice, then "Thinking"', () => {
    expect(liveLabel(message({ activity: 'waiting on the provider' }))).toBe(
      'waiting on the provider'
    )
    expect(
      liveLabel(
        message({
          activity: 'waiting',
          toolCalls: [call({ name: 'web_search', status: 'running', summary: 'x' })]
        })
      )
    ).toBe('Searching the web for x')
    expect(liveLabel(message({ thinking: 'Hmm.' }))).toBe('Thinking')
    expect(liveLabel(message({ text: 'Sure', thinking: 'Hmm.' }))).toBe('Thought for 1s')
  })
})
