import type { BrowserWindow } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { notify } from './notify'

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

  it('keeps check-in and approval notifications independent of window visibility', () => {
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
  })
})
