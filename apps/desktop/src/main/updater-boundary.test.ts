import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({
  handlers: new Map<string, (error: Error) => void>(),
  check: vi.fn(),
  info: vi.fn(),
  error: vi.fn()
}))
vi.mock('electron', () => ({ app: { isPackaged: true, getVersion: () => '1.0.0' } }))
vi.mock('electron-updater', () => ({
  default: {
    autoUpdater: {
      on: (event: string, handler: (error: Error) => void) => mock.handlers.set(event, handler),
      checkForUpdates: mock.check
    }
  }
}))
vi.mock('./desktop-state', () => ({
  defaultUpdateChannel: () => 'stable',
  readUpdateChannel: async () => 'stable',
  updateDesktopState: vi.fn()
}))
vi.mock('./log', () => ({
  log: { info: mock.info, error: mock.error },
  errorMessage: (error: Error) => error.message
}))

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  mock.handlers.clear()
  vi.useFakeTimers()
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  Object.defineProperty(process, 'platform', platformDescriptor)
  vi.unstubAllEnvs()
})

it.each(['win32', 'darwin', 'linux'])(
  'keeps raw %s check failures in the log and normalizes only Windows IPC state',
  async platform => {
    Object.defineProperty(process, 'platform', { ...platformDescriptor, value: platform })
    vi.stubEnv('APPIMAGE', '/tmp/Hexbot.AppImage')
    mock.check.mockRejectedValueOnce(new Error('HTTP 404 missing latest.yml'))
    const { checkForUpdates } = await import('./updater')
    const state = await checkForUpdates('test')
    expect(state.status).toBe('error')
    expect(mock.error).toHaveBeenCalledWith('update check failed: HTTP 404 missing latest.yml')
    if (platform === 'win32') {
      expect(state).toMatchObject({
        message: 'No update is available for this channel yet.',
        rawError: 'HTTP 404 missing latest.yml'
      })
    } else {
      expect(state.message).toBe('HTTP 404 missing latest.yml')
    }
  }
)

it('normalizes and logs unsolicited Windows updater errors as well', async () => {
  Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' })
  const { getUpdateState } = await import('./updater')
  await getUpdateState()
  mock.handlers.get('error')!(new Error('net::ERR_CONNECTION_RESET'))
  expect(await getUpdateState()).toMatchObject({
    status: 'error',
    message: 'Could not reach the update server. Check your connection and try again.',
    rawError: 'net::ERR_CONNECTION_RESET'
  })
  expect(mock.error).toHaveBeenCalledWith('update check failed: net::ERR_CONNECTION_RESET')
})
