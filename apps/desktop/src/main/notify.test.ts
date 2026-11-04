import type { BrowserWindow } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { notify, reportShown } from './notify'

const native = vi.hoisted(() => ({ show: vi.fn(), on: vi.fn(), create: vi.fn() }))
vi.mock('electron', () => ({
  Notification: class {
    constructor(options: unknown) {
      native.create(options)
    }
    on = native.on
    show = native.show
  }
}))

const options = { title: 'Owl', body: 'Reply', sectionId: 'chat', backgroundOnly: true }
const window = (visible: boolean, minimized: boolean) => ({
  isDestroyed: () => false,
  isVisible: () => visible,
  isMinimized: () => minimized,
  restore: vi.fn(),
  show: vi.fn(),
  focus: vi.fn(),
  webContents: { send: vi.fn() }
})

beforeEach(() => vi.clearAllMocks())

describe('native reply notifications', () => {
  it.each([
    [false, false, true],
    [true, true, true],
    [true, false, false]
  ])('visible=%s minimized=%s delivers=%s', (visible, minimized, delivers) => {
    const win = window(visible, minimized)
    notify(options, () => win as unknown as BrowserWindow)
    expect(native.show).toHaveBeenCalledTimes(delivers ? 1 : 0)
    expect(native.create).toHaveBeenCalledTimes(delivers ? 1 : 0)
  })

  it('checks visibility when delivering, including a reopen racing completion', () => {
    let win = window(false, false)
    const getWindow = () => win as unknown as BrowserWindow
    notify(options, getWindow)
    win = window(true, false)
    notify(options, getWindow)
    expect(native.show).toHaveBeenCalledOnce()
  })

  it('keeps heartbeat and approval notifications independent of window visibility', () => {
    notify(
      { ...options, backgroundOnly: undefined },
      () => window(true, false) as unknown as BrowserWindow
    )
    expect(native.show).toHaveBeenCalledOnce()
  })

  it('restores the window and opens the conversation on click', () => {
    const win = window(true, true)
    notify(options, () => win as unknown as BrowserWindow)
    native.on.mock.calls.find(([event]) => event === 'click')![1]()
    expect(win.restore).toHaveBeenCalledOnce()
    expect(win.show).toHaveBeenCalledOnce()
    expect(win.focus).toHaveBeenCalledOnce()
    expect(win.webContents.send).toHaveBeenCalledWith('hexbot:navigate', 'chat')
    // The app showed it, so it says so: macOS sends no show event for that.
    expect(win.webContents.send).toHaveBeenCalledWith('hexbot:window-shown', expect.any(Boolean))
  })

  it('shows a notification about no chat, and a click only brings the window back', () => {
    const win = window(false, false)
    notify({ ...options, sectionId: undefined }, () => win as unknown as BrowserWindow)
    native.on.mock.calls.find(([event]) => event === 'click')![1]()
    expect(native.show).toHaveBeenCalledOnce()
    expect(win.show).toHaveBeenCalledOnce()
    expect(win.webContents.send).not.toHaveBeenCalledWith('hexbot:navigate', expect.anything())
  })

  it('tells the page when its window is closed, minimized or back', async () => {
    const handlers = new Map<string, () => void>()
    let [visible, minimized] = [true, false]
    const win = {
      isDestroyed: () => false,
      isVisible: () => visible,
      isMinimized: () => minimized,
      on: (event: string, handler: () => void) => handlers.set(event, handler),
      webContents: { on: (event: string, handler: () => void) => handlers.set(event, handler), send: vi.fn() }
    }
    reportShown(win as unknown as BrowserWindow)
    handlers.get('did-finish-load')!()
    visible = false
    handlers.get('hide')!()
    ;[visible, minimized] = [true, true]
    handlers.get('minimize')!()
    minimized = false
    handlers.get('restore')!()
    // A close hides the window in its own handler, with no hide event.
    handlers.get('close')!()
    visible = false
    await new Promise(resolve => setImmediate(resolve))
    expect(win.webContents.send.mock.calls).toEqual([
      ['hexbot:window-shown', true],
      ['hexbot:window-shown', false],
      ['hexbot:window-shown', false],
      ['hexbot:window-shown', true],
      ['hexbot:window-shown', false]
    ])
  })
})
