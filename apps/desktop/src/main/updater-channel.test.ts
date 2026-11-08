import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  readUpdateChannel: vi.fn(),
  updateDesktopState: vi.fn(),
  checkForUpdates: vi.fn(),
  downloadUpdate: vi.fn(),
  quitAndInstall: vi.fn()
}))
vi.mock('electron', () => ({ app: { isPackaged: true, getVersion: () => '0.1.5' } }))
vi.mock('./desktop-state', () => ({
  defaultUpdateChannel: () => 'stable',
  readUpdateChannel: mocks.readUpdateChannel,
  updateDesktopState: mocks.updateDesktopState,
  isNightlyVersion: (version: string) => /-nightly\./.test(version)
}))
vi.mock('./log', () => ({ log: { info: vi.fn(), error: vi.fn() }, errorMessage: String }))

let autoUpdater: EventEmitter & {
  channel?: string
  checkForUpdates: typeof mocks.checkForUpdates
  downloadUpdate: typeof mocks.downloadUpdate
  quitAndInstall: typeof mocks.quitAndInstall
}
vi.mock('electron-updater', () => ({
  default: { get autoUpdater() { return autoUpdater } }
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

beforeEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
  vi.useFakeTimers()
  vi.stubEnv('APPIMAGE', '/test/Hexbot.AppImage')
  mocks.readUpdateChannel.mockResolvedValue('stable')
  mocks.updateDesktopState.mockResolvedValue(undefined)
  mocks.checkForUpdates.mockResolvedValue(null)
  autoUpdater = Object.assign(new EventEmitter(), {
    checkForUpdates: mocks.checkForUpdates,
    downloadUpdate: mocks.downloadUpdate,
    quitAndInstall: mocks.quitAndInstall
  })
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('updater track changes', () => {
  it('does not persist a rejected track change during a check', async () => {
    const updater = await import('./updater')
    const request = deferred<null>()
    const entered = deferred<void>()
    mocks.checkForUpdates.mockImplementationOnce(() => {
      entered.resolve()
      return request.promise
    })
    const checking = updater.checkForUpdates('test')
    await entered.promise
    await expect(updater.setUpdateChannel('nightly')).rejects.toThrow('Wait for the current update')
    expect(mocks.updateDesktopState).not.toHaveBeenCalled()
    expect((await updater.getUpdateState()).channel).toBe('stable')
    expect(autoUpdater.channel).toBe('latest')
    request.resolve(null)
    await checking
  })

  it('blocks update checks and competing switches until the new track is saved', async () => {
    const updater = await import('./updater')
    const saving = deferred<void>()
    const entered = deferred<void>()
    mocks.updateDesktopState.mockImplementationOnce(() => {
      entered.resolve()
      return saving.promise
    })
    const switching = updater.setUpdateChannel('nightly')
    await entered.promise
    await updater.checkForUpdates('poll')
    expect(mocks.checkForUpdates).not.toHaveBeenCalled()
    await expect(updater.setUpdateChannel('nightly')).rejects.toThrow('Wait for the current update')
    saving.resolve()
    expect((await switching).channel).toBe('nightly')
    expect(autoUpdater.channel).toBe('nightly')
    expect(mocks.updateDesktopState).toHaveBeenCalledTimes(1)
    expect(mocks.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it.each(['download', 'installation'])('does not persist a rejected switch during %s', async phase => {
    const updater = await import('./updater')
    await updater.getUpdateState()
    autoUpdater.emit('update-available', { version: '0.1.6' })
    if (phase === 'download') {
      const request = deferred<void>()
      const entered = deferred<void>()
      mocks.downloadUpdate.mockImplementationOnce(() => {
        entered.resolve()
        return request.promise
      })
      const downloading = updater.downloadUpdate()
      await entered.promise
      try {
        await expect(updater.setUpdateChannel('nightly')).rejects.toThrow('Wait for the current update')
        expect(mocks.updateDesktopState).not.toHaveBeenCalled()
      } finally {
        request.resolve()
        await downloading
      }
    } else {
      autoUpdater.emit('update-downloaded', { version: '0.1.6' })
      await updater.installUpdate()
      expect(mocks.quitAndInstall).toHaveBeenCalledTimes(1)
      await expect(updater.setUpdateChannel('nightly')).rejects.toThrow('Wait for the current update')
      expect(mocks.updateDesktopState).not.toHaveBeenCalled()
    }
  })

  it('releases the switch guard after a failed save', async () => {
    const updater = await import('./updater')
    mocks.updateDesktopState.mockRejectedValueOnce(new Error('Disk full'))
    await expect(updater.setUpdateChannel('nightly')).rejects.toThrow('Disk full')
    expect((await updater.getUpdateState()).channel).toBe('stable')
    expect(autoUpdater.channel).toBe('latest')
    await expect(updater.setUpdateChannel('nightly')).resolves.toMatchObject({ channel: 'nightly' })
  })
})
