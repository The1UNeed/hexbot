import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const updater = vi.hoisted(() => ({ runRemoteUpdate: vi.fn() }))
const runtime = vi.hoisted(() => ({ bootstrap: vi.fn(), selectedNativeVersion: vi.fn() }))
vi.mock('./updater', () => updater)
vi.mock('./backend/bootstrap', () => runtime)

const { handleDaemonUpdateRequest } = await import('./remote-update')

describe('handleDaemonUpdateRequest', () => {
  let home: string
  const calls: string[] = []
  const stopped = { state: 'stopped' } as const
  const daemon = {
    stop: vi.fn(async () => (calls.push('stop'), stopped)),
    start: vi.fn(async () => (calls.push('start'), stopped))
  }
  const status = async (): Promise<{ status: string; version: string | null }> =>
    JSON.parse(await readFile(join(home, 'runtime/update-status.json'), 'utf8'))

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'hexbot-remote-update-'))
    vi.stubEnv('HEXBOT_HOME', home)
    calls.length = 0
    vi.clearAllMocks()
    updater.runRemoteUpdate.mockResolvedValue({ outcome: 'up-to-date', message: 'The app is already up to date.' })
    runtime.bootstrap.mockImplementation(async () => void calls.push('bootstrap'))
  })
  afterEach(async () => {
    vi.unstubAllEnvs()
    await rm(home, { recursive: true, force: true })
  })

  it('restarts the daemon on the app runtime when only the daemon is behind', async () => {
    runtime.selectedNativeVersion.mockResolvedValue('0.1.5-nightly.20261022.59')
    await handleDaemonUpdateRequest('0.1.5-nightly.20261022.59', daemon)
    expect(calls).toEqual(['bootstrap', 'stop', 'start'])
    expect(await status()).toMatchObject({ status: 'installing', version: '0.1.5-nightly.20261022.59' })
  })

  it('reports nothing to install when the runtime is not the requested version', async () => {
    runtime.selectedNativeVersion.mockResolvedValue('0.1.5-alpha.2')
    await handleDaemonUpdateRequest('0.1.5-nightly.20261022.59', daemon)
    expect(calls).toEqual(['bootstrap'])
    expect(await status()).toMatchObject({ status: 'up-to-date' })
  })

  it('reports a runtime that cannot be prepared and keeps the daemon running', async () => {
    runtime.bootstrap.mockRejectedValue(new Error('This system cannot run the Hexbot runtime'))
    await handleDaemonUpdateRequest('0.1.5-nightly.20261022.59', daemon)
    expect(daemon.stop).not.toHaveBeenCalled()
    expect(await status()).toMatchObject({ status: 'failed' })
  })

  it('leaves the daemon alone while an app update installs', async () => {
    updater.runRemoteUpdate.mockResolvedValue({ outcome: 'installing', message: null })
    await handleDaemonUpdateRequest('0.1.5-nightly.20261022.59', daemon)
    expect(runtime.bootstrap).not.toHaveBeenCalled()
    expect(daemon.stop).not.toHaveBeenCalled()
  })
})
