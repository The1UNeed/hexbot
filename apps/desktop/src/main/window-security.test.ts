import type { BrowserWindow, IpcMainInvokeEvent, WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { guardWindow, isRendererUrl, isTrustedSender } from './window-security'

describe('renderer trust', () => {
  it('admits app routes and only the configured development origin', () => {
    expect(isRendererUrl('hexbot-app://app/settings/network')).toBe(true)
    expect(isRendererUrl('http://localhost:5173/b/owl', 'http://localhost:5173')).toBe(true)
    for (const url of [
      'https://attacker.test',
      'hexbot-app://app.evil/',
      'hexbot-app://evil/',
      'hexbot-app://app:123/',
      'hexbot-app://user@app/',
      'file:///bundle/index.html',
      'data:text/html,hello',
      'about:blank',
      'invalid',
      'http://localhost:5174/'
    ])
      expect(isRendererUrl(url, 'http://localhost:5173')).toBe(false)
    expect(isRendererUrl('http://localhost:5173/')).toBe(false)
  })

  it('requires the live main window, its main frame, and an allowed URL for IPC', () => {
    const mainFrame = { url: 'hexbot-app://app/' }
    const contents = { mainFrame } as WebContents
    const window = { webContents: contents, isDestroyed: () => false } as BrowserWindow
    const event = { sender: contents, senderFrame: mainFrame } as IpcMainInvokeEvent
    expect(isTrustedSender(event, window)).toBe(true)
    expect(isTrustedSender(event, null)).toBe(false)
    expect(isTrustedSender(event, { ...window, isDestroyed: () => true } as BrowserWindow)).toBe(
      false
    )
    expect(isTrustedSender({ ...event, sender: {} } as IpcMainInvokeEvent, window)).toBe(false)
    expect(
      isTrustedSender({ ...event, senderFrame: { ...mainFrame } } as IpcMainInvokeEvent, window)
    ).toBe(false)
    mainFrame.url = 'https://attacker.test/'
    expect(isTrustedSender(event, window)).toBe(false)
  })
})

describe('window navigation', () => {
  it('denies child windows and opens only HTTP(S) links in the browser', async () => {
    const contents = { setWindowOpenHandler: vi.fn(), on: vi.fn() } as unknown as WebContents
    const open = vi.fn().mockResolvedValue(undefined)
    guardWindow(contents, open)
    const handler = vi.mocked(contents.setWindowOpenHandler).mock.calls[0]![0]
    for (const url of ['https://example.test/', 'http://example.test/']) {
      expect(handler({ url } as Electron.HandlerDetails)).toEqual({ action: 'deny' })
      expect(open).toHaveBeenLastCalledWith(url)
    }
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'hexbot://pair', 'invalid']) {
      expect(handler({ url } as Electron.HandlerDetails)).toEqual({ action: 'deny' })
    }
    expect(open).toHaveBeenCalledTimes(2)
    await Promise.resolve()
  })

  it('blocks external navigations, redirects, and webview attachment', () => {
    const handlers = new Map<string, (event: { preventDefault: () => void }, url: string) => void>()
    const contents = {
      setWindowOpenHandler: vi.fn(),
      on: (name: string, handler: (event: { preventDefault: () => void }, url: string) => void) =>
        handlers.set(name, handler)
    } as unknown as WebContents
    guardWindow(contents, vi.fn())
    for (const name of ['will-navigate', 'will-redirect']) {
      const event = { preventDefault: vi.fn() }
      handlers.get(name)!(event, 'hexbot-app://app/settings')
      expect(event.preventDefault).not.toHaveBeenCalled()
      handlers.get(name)!(event, 'https://attacker.test/')
      expect(event.preventDefault).toHaveBeenCalledOnce()
    }
    const event = { preventDefault: vi.fn() }
    handlers.get('will-attach-webview')!(event, '')
    expect(event.preventDefault).toHaveBeenCalledOnce()
  })
})
