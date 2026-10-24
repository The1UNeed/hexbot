import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import type net from 'node:net'
import { expect, it, vi } from 'vitest'
import { DaemonManager, runningDaemonPort } from './manager'

const controls = vi.hoisted(() => ({
  spawn: vi.fn(),
  beforeQuit: undefined as undefined | ((event: { preventDefault(): void }) => void),
  exit: vi.fn()
}))
vi.mock('node:child_process', () => ({ spawn: controls.spawn }))
vi.mock('electron', () => ({ app: {
  isPackaged: true,
  on: (_event: string, listener: typeof controls.beforeQuit) => { controls.beforeQuit = listener },
  exit: controls.exit
} }))

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

for (const intent of ['stop', 'start', 'quit'] as const)
for (const identity of ['valid', 'wrong-home', 'wrong-pid'] as const)
it(`observes entered service readiness before a newer ${intent}, identity=${identity}`, async () => {
  const home = await mkdtemp(join(tmpdir(), 'hexbot-service-observation-'))
  const previousHome = process.env.HEXBOT_HOME
  process.env.HEXBOT_HOME = home
  const probing = deferred(), release = deferred(), reprobed = deferred(), releaseRetry = deferred()
  const exited = deferred()
  controls.spawn.mockReset()
  controls.exit.mockReset().mockImplementation(() => { exited.resolve() })
  const owner = { install_id: 'post-cli-owner', pid: process.pid }
  let requests = 0, cliCompleted = false, installSettled = false
  const server = http.createServer(async (request, response) => {
    expect(request.url).toBe('/api/daemon/identity')
    const number = ++requests
    if (number === 1) { probing.resolve(); await release.promise }
    if (number === 2 && identity !== 'valid') { reprobed.resolve(); await releaseRetry.promise }
    response.end(JSON.stringify(number !== 1 || identity === 'valid' ? owner : {
      ...owner,
      ...(identity === 'wrong-home' ? { install_id: 'another-home' } : { pid: process.ppid })
    }))
  })
  // Observe the real fetch signal without replacing HTTP or its authentication.
  const fetchIdentity = fetch
  let endpoint: string
  let firstSignal: AbortSignal | undefined
  const capture = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    if (String(input) !== endpoint) throw new Error('Readiness left its owned loopback fixture')
    firstSignal ??= init?.signal ?? undefined
    return fetchIdentity(input, init)
  })
  const manager = new DaemonManager()
  let outcome: Promise<unknown> | undefined, newer: Promise<unknown> | undefined
  try {
    const port = await new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)))
    endpoint = `http://127.0.0.1:${port}/api/daemon/identity`
    const installing = manager.installService(async () => {
      await writeFile(join(home, 'native-daemon.lock'), String(process.pid))
      await writeFile(join(home, 'install_id'), owner.install_id)
      await writeFile(join(home, 'serve-state.json'), JSON.stringify({ port }))
      cliCompleted = true
    })
    outcome = installing.then(() => undefined, error => error).finally(() => { installSettled = true })
    await probing.promise
    expect(cliCompleted).toBe(true)
    if (intent === 'quit') {
      const preventDefault = vi.fn()
      controls.beforeQuit!({ preventDefault })
      expect(preventDefault).toHaveBeenCalledOnce()
      newer = exited.promise
    } else newer = intent === 'stop' ? manager.stop() : manager.start()
    const abortedBeforeResponse = firstSignal!.aborted
    release.resolve()
    if (identity !== 'valid') {
      await reprobed.promise
      expect(manager.status()).toEqual({ state: 'stopped' })
      expect(installSettled).toBe(false)
      expect(controls.spawn).not.toHaveBeenCalled()
      releaseRetry.resolve()
    }
    expect(await outcome).toMatchObject({ message: 'Service change was superseded' })
    const result = await newer
    expect(await runningDaemonPort(home)).toBe(port)
    expect(manager.status()).toEqual({ state: 'external', port })
    if (intent !== 'quit') expect(result).toEqual({ state: 'external', port })
    else expect(controls.exit).toHaveBeenCalledExactlyOnceWith(0)
    expect(abortedBeforeResponse).toBe(false)
    expect(firstSignal!.aborted).toBe(true) // Successful completion still cleans its probe.
    expect(manager.listenerCount('transition-cancelled')).toBe(0)
    expect(controls.spawn).not.toHaveBeenCalled()
  } finally {
    release.resolve(); releaseRetry.resolve()
    await Promise.allSettled([outcome, newer])
    capture.mockRestore()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    if (previousHome === undefined) delete process.env.HEXBOT_HOME
    else process.env.HEXBOT_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})
