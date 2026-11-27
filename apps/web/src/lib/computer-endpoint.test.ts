import { afterEach, describe, expect, it, vi } from 'vitest'

import { useConnection } from '../stores/connection'

import {
  canOfferComputer,
  connectionClosed,
  handleComputerRequest,
  offerThisComputer
} from './computer-endpoint'
import { setActiveRpc } from './rpc'

const bridge = (computer: Record<string, unknown>) => {
  ;(window as unknown as { hexbot: unknown }).hexbot = { computer }
}

afterEach(() => {
  delete (window as unknown as { hexbot?: unknown }).hexbot
  useConnection.setState({ target: null })
})

describe('this computer as one of the user computers', () => {
  it('is offered only by the desktop app connected to another computer', () => {
    expect(canOfferComputer()).toBe(false)
    bridge({ run: vi.fn() })
    useConnection.setState({ target: { kind: 'local' } })
    expect(canOfferComputer()).toBe(false)
    useConnection.setState({
      target: { deviceToken: 't', host: 'studio', kind: 'remote', port: 9119, tls: false }
    })
    expect(canOfferComputer()).toBe(true)
  })

  it('stops what bots started here when the connection ends', () => {
    const release = vi.fn().mockResolvedValue(undefined)
    bridge({ release })
    connectionClosed()
    expect(release).toHaveBeenCalledOnce()
  })

  it('refuses work when this computer is not offered, and runs it in the main process when it is', async () => {
    const call = vi.fn().mockResolvedValue({ ok: true })
    setActiveRpc({ call } as never)
    const run = vi.fn().mockResolvedValue({ exit_code: 0, output: 'ok' })
    bridge({ run })
    useConnection.setState({ target: { kind: 'local' } })
    await handleComputerRequest({ command: 'ls', kind: 'terminal', request_id: 'r1' })
    expect(run).not.toHaveBeenCalled()
    expect(call).toHaveBeenCalledWith('hexbot.computers.reply', {
      error: 'This computer does not let bots use it.',
      request_id: 'r1'
    })
    useConnection.setState({
      target: { deviceToken: 't', host: 'studio', kind: 'remote', port: 9119, tls: false }
    })
    await handleComputerRequest({ command: 'ls', kind: 'terminal', request_id: 'r2' })
    expect(run).toHaveBeenCalledOnce()
    expect(call).toHaveBeenCalledWith('hexbot.computers.reply', {
      request_id: 'r2',
      result: { exit_code: 0, output: 'ok' }
    })
  })

  it('answers only on the connection that asked, never on the daemon it switched to', async () => {
    const first = vi.fn().mockResolvedValue({ ok: true })
    const second = vi.fn().mockResolvedValue({ ok: true })
    setActiveRpc({ call: first } as never)

    let finish: (value: unknown) => void = () => {}
    const run = vi.fn(() => new Promise(resolve => (finish = resolve)))
    bridge({ run })
    useConnection.setState({
      target: { deviceToken: 't', host: 'studio', kind: 'remote', port: 9119, tls: false }
    })
    const handling = handleComputerRequest({ command: 'ls', kind: 'terminal', request_id: 'r1' })
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
    // The app switches to another daemon while the command runs.
    setActiveRpc({ call: second } as never)
    finish({ exit_code: 0, output: 'secret' })
    await handling
    expect(first).not.toHaveBeenCalled()
    expect(second).not.toHaveBeenCalled()
  })

  it('ends one stopped request in the main process and answers nothing', async () => {
    const call = vi.fn().mockResolvedValue({ ok: true })
    setActiveRpc({ call } as never)
    const cancel = vi.fn().mockResolvedValue(undefined)
    bridge({ cancel, run: vi.fn() })
    useConnection.setState({
      target: { deviceToken: 't', host: 'studio', kind: 'remote', port: 9119, tls: false }
    })
    await handleComputerRequest({ cancels: 'r1', kind: 'cancel', request_id: 'c1' })
    expect(cancel).toHaveBeenCalledWith('r1')
    expect(call).not.toHaveBeenCalled()
  })

  it('sends a stop that comes while an earlier offer is on its way, last', async () => {
    let release: (value: unknown) => void = () => {}

    const call = vi.fn((_method: string, params: Record<string, unknown>) =>
      params.terminal ? new Promise(resolve => (release = resolve)) : Promise.resolve({ attached: false })
    )

    setActiveRpc({ call } as never)
    let share = { desktop: false, desktopReady: false, name: 'mac', os: 'macOS', terminal: true }
    bridge({ state: vi.fn(async () => share) })
    useConnection.setState({
      status: 'connected',
      target: { deviceToken: 't', host: 'studio', kind: 'remote', port: 9119, tls: false }
    })
    const first = offerThisComputer()
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    share = { ...share, terminal: false }
    const second = offerThisComputer()
    release({ attached: true })
    await Promise.all([first, second])
    expect(call).toHaveBeenCalledTimes(2)
    expect(call.mock.calls[1]![1]).toMatchObject({ desktop: false, terminal: false })
  })

  it('keeps offering after a release for a replaced connection, so a later stop reaches the daemon', async () => {
    const call = vi.fn().mockResolvedValue({ attached: true, ok: true })
    setActiveRpc({ call } as never)
    let share = { desktop: false, desktopReady: false, name: 'mac', os: 'macOS', terminal: true }
    bridge({ release: vi.fn().mockResolvedValue(undefined), state: vi.fn(async () => share) })
    useConnection.setState({
      status: 'connected',
      target: { deviceToken: 't', host: 'studio', kind: 'remote', port: 9119, tls: false }
    })
    await offerThisComputer()
    await handleComputerRequest({ kind: 'release', reason: 'replaced', request_id: 'x' })
    // The user then stops bots here: the daemon hears it.
    share = { ...share, terminal: false }
    await offerThisComputer()
    expect(call).toHaveBeenLastCalledWith(
      'hexbot.computers.attach',
      expect.objectContaining({ desktop: false, terminal: false })
    )
  })

  it('ends what bots started here when the daemon forgets this computer, and confirms it', async () => {
    const call = vi.fn().mockResolvedValue({ ok: true })
    setActiveRpc({ call } as never)
    const release = vi.fn().mockResolvedValue(undefined)
    bridge({ release })
    await handleComputerRequest({ kind: 'release', request_id: 'x' })
    expect(release).toHaveBeenCalledOnce()
    expect(call).toHaveBeenCalledWith('hexbot.computers.reply', { request_id: 'x', result: { released: true } })
  })
})
