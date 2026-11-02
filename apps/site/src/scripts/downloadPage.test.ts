import { afterEach, expect, it, vi } from 'vitest'
import { downloadChoices } from '../lib/downloadChoices'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.resetModules()
})

it('starts the installer and copies the terminal command without DownloadList', async () => {
  vi.useFakeTimers()
  const choices = downloadChoices(null, {
    track: 'stable', version: '0.1.6', builds: [
      { key: 'linux', name: 'Linux', pill: 'AppImage', url: 'https://updates.hexbot.app/linux.AppImage' },
    ],
  })
  const primary = { href: '', hidden: false, dataset: { builds: JSON.stringify(choices) }, click: vi.fn() }
  const title = { textContent: '' }
  const sub = { textContent: '' }
  const label = { textContent: '' }
  const command = 'curl -fsSL https://hexbot.app/install.sh | sh'
  const copied = { textContent: 'Copy' }
  let copy: (() => Promise<void>) | undefined
  const button = {
    hidden: true, dataset: { copy: command }, querySelector: () => copied,
    addEventListener: (_event: string, handler: () => Promise<void>) => { copy = handler },
  }
  const elements: Record<string, unknown> = { '#dl-primary': primary, '#dl-title': title, '#dl-sub': sub, '#dl-primary-label': label, '#dl-terminal': {} }
  vi.stubGlobal('document', {
    querySelector: (selector: string) => elements[selector] ?? null,
    querySelectorAll: (selector: string) => selector === 'button[data-copy]' ? [button] : [],
    createElement: () => ({ getContext: () => null }),
  })
  const writeText = vi.fn(async () => {})
  vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)', maxTouchPoints: 0, clipboard: { writeText } })
  await import('./downloadPage')
  await vi.advanceTimersByTimeAsync(600)
  expect(primary.hidden).toBe(false)
  expect(primary.href).toBe(choices[0].url)
  expect(primary.click).toHaveBeenCalledOnce()
  expect(sub.textContent).toBe('The Hexbot Installer for Linux should begin downloading.')
  expect(label.textContent).toBe('Download again')
  expect(button.hidden).toBe(false)
  await copy!()
  expect(writeText).toHaveBeenCalledWith(command)
  expect(copied.textContent).toBe('Copied')
})

it.each(['x86', 'arm'])('uses Windows CPU hints before starting a download: %s', async architecture => {
  vi.useFakeTimers()
  const url = 'https://updates.hexbot.app/install/1.2.3/hexbot-install-1.2.3-windows-x86_64.exe'
  const primary = { href: '', hidden: false, dataset: { builds: JSON.stringify([
    { key: 'win-x64', name: 'Windows (x64)', kind: 'installer', url },
  ]) }, click: vi.fn() }
  const windows = { hidden: true, dataset: { os: 'win', for: 'installer' } }
  const mac = { hidden: false, dataset: { os: 'mac', for: 'installer' } }
  const sub = { textContent: '' }
  const elements: Record<string, unknown> = { '#dl-primary': primary, '#dl-title': {}, '#dl-sub': sub, '#dl-primary-label': {} }
  vi.stubGlobal('document', {
    querySelector: (selector: string) => elements[selector] ?? null,
    querySelectorAll: (selector: string) => selector === '[data-os], [data-for]' ? [windows, mac] : [],
    createElement: () => ({ getContext: () => null }),
  })
  vi.stubGlobal('navigator', {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    userAgentData: { getHighEntropyValues: async () => ({ architecture, bitness: '64' }) },
  })
  await import('./downloadPage')
  await vi.advanceTimersByTimeAsync(600)
  expect(primary.hidden).toBe(architecture === 'arm')
  expect(primary.click).toHaveBeenCalledTimes(architecture === 'arm' ? 0 : 1)
  if (architecture === 'x86') {
    expect(primary.href).toBe(url)
    expect(windows.hidden).toBe(false)
    expect(mac.hidden).toBe(true)
    expect(sub.textContent).toContain('Windows (x64)')
  }
})
