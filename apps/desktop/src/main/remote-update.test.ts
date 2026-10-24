import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
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
  const status = async (): Promise<{
    status: string
    version: string | null
    message: string | null
  }> => JSON.parse(await readFile(join(home, 'runtime/update-status.json'), 'utf8'))

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'hexbot-remote-update-'))
    vi.stubEnv('HEXBOT_HOME', home)
    vi.resetAllMocks()
    updater.runRemoteUpdate.mockResolvedValue({
      outcome: 'up-to-date',
      message: 'The app is already up to date.'
    })
  })
  afterEach(async () => {
    vi.unstubAllEnvs()
    await rm(home, { recursive: true, force: true })
  })

  it('keeps an already-current app result without attempting the held runtime transition', async () => {
    await handleDaemonUpdateRequest('0.1.5-nightly.20261022.59')
    expect(runtime.bootstrap).not.toHaveBeenCalled()
    expect(await status()).toMatchObject({
      status: 'up-to-date',
      message: 'The app is already up to date.'
    })
  })

  it('preserves the useful AppImage failure', async () => {
    updater.runRemoteUpdate.mockResolvedValue({
      outcome: 'failed',
      message: 'Updates on Linux need the AppImage package.'
    })
    await handleDaemonUpdateRequest('0.1.5-nightly.20261022.59')
    expect(await status()).toMatchObject({
      status: 'failed',
      message: 'Updates on Linux need the AppImage package.'
    })
  })

  it('reports a rejected update and preserves its cause and recovery errors', async () => {
    const original = new Error('AppImage required')
    const activation = new Error('Runtime verification failed', { cause: original })
    updater.runRemoteUpdate.mockRejectedValue(
      new AggregateError([activation, new Error('Recovery failed')], 'Update failed')
    )
    await expect(handleDaemonUpdateRequest('0.1.5')).resolves.toBeUndefined()
    const result = await status()
    expect(result.status).toBe('failed')
    for (const message of [
      'Update failed',
      'Runtime verification failed',
      'AppImage required',
      'Recovery failed'
    ])
      expect(result.message).toContain(message)
  })

  it('does not let progress or late notifications overwrite terminal failure', async () => {
    let report: (state: { status: string; message?: string }) => void = () => undefined
    updater.runRemoteUpdate.mockImplementation(async callback => {
      report = callback
      callback({ status: 'error', message: 'AppImage required' })
      callback({ status: 'installing' })
      throw new Error('Installation failed')
    })
    await handleDaemonUpdateRequest('0.1.5')
    report({ status: 'installing' })
    expect(await status()).toMatchObject({ status: 'failed' })
    expect((await status()).message).toContain('AppImage required')
    expect((await status()).message).toContain('Installation failed')
  })

  it('leaves the daemon alone while an app update installs', async () => {
    updater.runRemoteUpdate.mockResolvedValue({ outcome: 'installing', message: null })
    await handleDaemonUpdateRequest('0.1.5-nightly.20261022.59')
    expect(runtime.bootstrap).not.toHaveBeenCalled()
    expect(await status()).toMatchObject({ status: 'installing' })
  })

  it('keeps concurrent requests behind one update and releases the gate after failure', async () => {
    let finish: () => void = () => undefined
    let started: () => void = () => undefined
    const pending = new Promise<void>(resolve => {
      finish = resolve
    })
    const entered = new Promise<void>(resolve => {
      started = resolve
    })
    updater.runRemoteUpdate.mockImplementationOnce(async () => {
      started()
      await pending
      throw new Error('Download interrupted')
    })
    const first = handleDaemonUpdateRequest('0.1.5')
    await entered
    await handleDaemonUpdateRequest('0.1.6')
    expect(updater.runRemoteUpdate).toHaveBeenCalledTimes(1)
    finish()
    await first
    expect(await status()).toMatchObject({ status: 'failed', message: 'Download interrupted' })
    await handleDaemonUpdateRequest('0.1.6')
    expect(updater.runRemoteUpdate).toHaveBeenCalledTimes(2)
  })

  it('releases the request gate even when removing stale status fails', async () => {
    const path = join(home, 'runtime/update-status.json')
    await mkdir(path, { recursive: true })
    await expect(handleDaemonUpdateRequest('0.1.5')).resolves.toBeUndefined()
    await rm(path, { recursive: true })
    await handleDaemonUpdateRequest('0.1.5')
    expect(updater.runRemoteUpdate).toHaveBeenCalledTimes(1)
    expect(await status()).toMatchObject({ status: 'up-to-date' })
  })
})
