import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { WindowLifecycle } from './window-lifecycle'

function fixture(platform: NodeJS.Platform, tray = true) {
  const lifecycle = new WindowLifecycle(platform)
  const window = Object.assign(new EventEmitter(), { hide: vi.fn(), minimize: vi.fn() })
  const onBackground = vi.fn()
  lifecycle.attach(window as unknown as BrowserWindow, () => tray, onBackground)
  const close = () => {
    const event = { preventDefault: vi.fn() }
    window.emit('close', event)
    return event.preventDefault
  }
  return { lifecycle, window, onBackground, close }
}

describe('native window lifecycle', () => {
  it.each(['darwin', 'win32'] as const)('retains the page on %s', platform => {
    const { window, close, onBackground } = fixture(platform)
    expect(close()).toHaveBeenCalledOnce()
    expect(window.hide).toHaveBeenCalledOnce()
    expect(onBackground).toHaveBeenCalledOnce()
  })

  it.each([
    ['linux', true],
    ['linux', false],
    ['win32', false]
  ] as const)('keeps a taskbar entry on %s with tray=%s', (platform, tray) => {
    const { window, close } = fixture(platform, tray)
    expect(close()).toHaveBeenCalledOnce()
    expect(window.minimize).toHaveBeenCalledOnce()
    expect(window.hide).not.toHaveBeenCalled()
  })

  it.each(['darwin', 'win32', 'linux'] as const)(
    'allows explicit and updater quits on %s',
    platform => {
      const { lifecycle, window, close } = fixture(platform)
      lifecycle.setInstalling(true)
      expect(close()).not.toHaveBeenCalled()
      lifecycle.setInstalling(false)
      expect(close()).toHaveBeenCalledOnce()
      lifecycle.beginQuit()
      // An asynchronous install failure must not undo an explicit or OS quit.
      lifecycle.setInstalling(false)
      expect(close()).not.toHaveBeenCalled()
      expect(window.hide.mock.calls.length + window.minimize.mock.calls.length).toBe(1)
    }
  )

  it('does not veto session end or retain the window afterwards', () => {
    const { window, close } = fixture('win32')
    const preventDefault = vi.fn()
    window.emit('query-session-end', { preventDefault })
    expect(preventDefault).not.toHaveBeenCalled()
    // A cancelled query leaves ordinary close behavior intact.
    expect(close()).toHaveBeenCalledOnce()
    window.emit('session-end', { preventDefault })
    expect(preventDefault).not.toHaveBeenCalled()
    expect(close()).not.toHaveBeenCalled()
  })
})
