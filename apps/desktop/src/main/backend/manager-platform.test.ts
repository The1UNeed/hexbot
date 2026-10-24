import { PassThrough } from 'node:stream'
import { expect, it, vi } from 'vitest'
import { DaemonManager, requestOwnedShutdown } from './manager'

const lifecycle = vi.hoisted(() => ({ quit: undefined as undefined | ((event: { preventDefault(): void }) => void), exit: vi.fn() }))
vi.mock('electron', () => ({ app: {
  on: (_event: string, listener: typeof lifecycle.quit) => { lifecycle.quit = listener },
  exit: lifecycle.exit,
  isPackaged: true
} }))

it('uses the owned pipe on Windows and SIGTERM on Unix', () => {
  const stdin = new PassThrough()
  let received = ''
  stdin.on('data', data => { received += data })
  const kill = vi.fn()
  requestOwnedShutdown({ stdin, kill }, 'win32')
  expect(received).toBe('HEXBOT_SHUTDOWN_V1\n')
  expect(stdin.writableEnded).toBe(true)
  expect(kill).not.toHaveBeenCalled()
  requestOwnedShutdown({ stdin: new PassThrough(), kill }, 'linux')
  expect(kill).toHaveBeenCalledWith('SIGTERM')
})

it('drains and cancels preparation before the serialized quit stop', async () => {
  lifecycle.exit.mockReset()
  const manager = new DaemonManager()
  let release!: () => void
  let entered!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  const preparing = new Promise<void>(resolve => { entered = resolve })
  const start = manager.start(async () => {
    entered()
    await waiting
    return { executable: '/unused', version: '1.0.0' }
  })
  const failed = expect(start).rejects.toThrow('superseded')
  await preparing
  const preventDefault = vi.fn()
  lifecycle.quit!({ preventDefault })
  expect(preventDefault).toHaveBeenCalledOnce()
  expect(lifecycle.exit).not.toHaveBeenCalled()
  release()
  await failed
  await vi.waitFor(() => expect(lifecycle.exit).toHaveBeenCalledWith(0))
  expect(manager.status().state).toBe('stopped')
})
