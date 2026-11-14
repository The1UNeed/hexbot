import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { HexbotBridge, LendState } from './bridge'
import { answerRequest, offerComputer } from './lend'
import { rpcCall } from './rpc'

vi.mock('./rpc', () => ({ rpcCall: vi.fn().mockResolvedValue({}) }))

const state = (change: Partial<LendState> = {}): LendState => ({
  cua: true,
  name: 'Laptop',
  on: true,
  os: 'macOS',
  sandbox: true,
  screen: false,
  ...change
})

describe('lending this computer from the page', () => {
  const computer = { run: vi.fn(), set: vi.fn(), state: vi.fn() }

  beforeEach(() => {
    vi.mocked(rpcCall).mockClear()
    window.hexbot = { computer } as unknown as HexbotBridge
  })
  afterEach(() => {
    delete window.hexbot
  })

  it('offers it when lent and withdraws it when not', async () => {
    computer.state.mockResolvedValue(state({ screen: true }))
    await offerComputer()
    expect(rpcCall).toHaveBeenCalledWith('hexbot.computers.offer', {
      name: 'Laptop',
      os: 'macOS',
      screen: true
    })
    await offerComputer(state({ on: false }))
    expect(rpcCall).toHaveBeenLastCalledWith('hexbot.computers.withdraw')
  })

  it('answers each request with what the app ran, or why it could not', async () => {
    computer.run.mockResolvedValueOnce({ exit_code: 0, output: 'Darwin' })
    await answerRequest({ command: 'uname', id: 'r1', kind: 'shell', level: 'confined' })
    expect(rpcCall).toHaveBeenLastCalledWith('hexbot.computers.reply', {
      id: 'r1',
      result: { exit_code: 0, output: 'Darwin' }
    })
    computer.run.mockRejectedValueOnce(new Error('This computer is no longer lent to your bots.'))
    await answerRequest({ id: 'r2', kind: 'shell' })
    expect(rpcCall).toHaveBeenLastCalledWith('hexbot.computers.reply', {
      error: 'This computer is no longer lent to your bots.',
      id: 'r2'
    })
  })

  it('lends nothing in a browser', async () => {
    delete window.hexbot
    expect(await offerComputer()).toBeNull()
    expect(rpcCall).not.toHaveBeenCalled()
  })
})
