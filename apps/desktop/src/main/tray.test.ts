import { describe, expect, it, vi } from 'vitest'

import type { DaemonStatus } from './backend/manager'
import { trayMenuTemplate } from './tray'

vi.mock('electron', () => ({ app: {}, Menu: {}, Tray: class {}, nativeImage: {} }))

const actions = { openWindow: vi.fn(), startDaemon: vi.fn(), stopDaemon: vi.fn(), quit: vi.fn() }
const labels = (status: DaemonStatus, hasRuntime = true): (string | undefined)[] =>
  trayMenuTemplate(status, actions, { hasRuntime }).map(item => item.label)

describe('trayMenuTemplate', () => {
  it('offers Stop only for a daemon this app runs', () => {
    expect(labels({ state: 'running', port: 9119, pid: 42 })).toEqual(['Open Hexbot', 'Daemon: running', 'Stop daemon', undefined, 'Quit'])
    expect(labels({ state: 'starting', port: 9119 })).toContain('Stop daemon')
    expect(labels({ state: 'stopped' })).toContain('Start daemon')
    expect(labels({ state: 'crashed', lastError: 'Daemon exited (1)' })).toContain('Start daemon')
  })

  it('names a daemon that runs as a service and hides Stop', () => {
    const items = trayMenuTemplate({ state: 'external', port: 9119 }, actions)
    expect(items.map(item => item.label)).toEqual(['Open Hexbot', 'Daemon: running outside this app', undefined, 'Quit'])
    expect(items[1]!.enabled).toBe(false)
    expect(items.some(item => item.click === actions.stopDaemon || item.click === actions.startDaemon)).toBe(false)
  })

  it('shows the client-only app without daemon controls', () => {
    expect(labels({ state: 'external', port: 9119 }, false)).toEqual(['Open Hexbot', 'Client-only app', undefined, 'Quit'])
  })
})
