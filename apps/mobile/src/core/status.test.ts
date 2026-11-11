import { describe, expect, it } from 'vitest'

import { emptyTurn } from './chat'
import { waitingStatus } from './status'
import type { ChatTool } from './types'

const tool = (partial: Partial<ChatTool>): ChatTool => ({
  args: undefined,
  detail: '',
  id: 't',
  name: 'terminal',
  status: 'running',
  ...partial
})

describe('waitingStatus', () => {
  it('thinks before anything happens and works between steps', () => {
    expect(waitingStatus(emptyTurn())).toEqual({ label: { verb: 'Thinking…' }, mood: 'thinking' })
    expect(waitingStatus({ ...emptyTurn(), tools: [tool({ status: 'ok' })] })).toEqual({
      label: { verb: 'Working…' },
      mood: 'working'
    })
    expect(waitingStatus({ ...emptyTurn(), interim: ['On it.'] }).label.verb).toBe('Working…')
  })

  it('names the running step as the web app does, with its face', () => {
    expect(
      waitingStatus({
        ...emptyTurn(),
        tools: [
          tool({
            action: 'open',
            args: { action: 'open', url: 'https://www.taobao.com/' },
            name: 'computer_use'
          })
        ]
      })
    ).toEqual({ label: { object: 'Taobao', verb: 'Opening' }, mood: 'computer' })
    expect(
      waitingStatus({ ...emptyTurn(), tools: [tool({ action: 'notes.md', name: 'read_file' })] })
    ).toEqual({ label: { object: 'notes.md', verb: 'Reading' }, mood: 'reading' })
    // A command is never quoted.
    expect(
      waitingStatus({ ...emptyTurn(), tools: [tool({ action: 'rm -rf ./x', args: { command: 'rm -rf ./x' } })] })
        .label
    ).toEqual({ object: 'a command', verb: 'Running' })
  })

  it('names the bot it asks, and only works while Auto mode checks a step', () => {
    const asking = { ...emptyTurn(), tools: [tool({ action: 'biology', name: 'message_bot' })] }
    expect(waitingStatus(asking, () => 'Biology')).toEqual({
      label: { object: 'Biology', verb: 'Asking' },
      mood: 'listening'
    })
    expect(waitingStatus({ ...asking, checking: 'Checking this step' }).label.verb).toBe('Working…')
  })
})
