import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import type { Detection, InstallerApi, InstallResult, OnProgress } from './api'
import { App } from './App'
import { HeadlessDone } from './done'

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class {},
  invoke: () => Promise.reject(new Error('Tauri is not available in tests'))
}))

// jsdom has no canvas; the QR code is drawn in the real webview.
vi.mock('qrcode', () => ({ default: { toCanvas: () => Promise.resolve() } }))

const locations = {
  apps: '/Applications',
  cli: '/Users/sam/.local/bin/hexbot',
  hexbotHome: '/Users/sam/.hexbot',
  home: '/Users/sam'
}

const fresh: Detection = {
  daemonFiles: false,
  installed: null,
  installerVersion: '0.1.5',
  locations,
  platform: 'macos/aarch64',
  target: 'macos-aarch64'
}

const installedFull: Detection = {
  ...fresh,
  installed: {
    apps: [{ path: '/Applications/Hexbot Nightly.app', managed_by_dpkg: false }],
    option: 'full',
    service: false,
    track: 'nightly',
    version: '0.1.5-nightly.20261004.1'
  }
}

function headlessResult(): InstallResult {
  return {
    receipt: {
      channel: 'nightly',
      installedAt: '2026-10-04T00:00:00Z',
      option: 'headless',
      paths: ['/Users/sam/.hexbot/runtime/native-executable'],
      version: '0.1.5-nightly.20261004.1'
    },
    status: {
      connect_hostname: null,
      lan_addresses: ['192.168.1.24', '100.101.102.103'],
      lan_enabled: true,
      port: 9119,
      running: true,
      service: { installed: true, running: true },
      tailscale_ipv4: '100.101.102.103'
    },
    warnings: []
  }
}

function fakeApi(detection: Detection, overrides: Partial<InstallerApi> = {}): InstallerApi {
  return {
    apply: vi.fn(async (_option, _track, onProgress: OnProgress) => {
      onProgress({
        downloaded: 24_000_000,
        message: 'Downloading Hexbot.',
        stage: 'download',
        total: 48_000_000
      })

      return headlessResult()
    }),
    change: vi.fn(async () => ({
      ...headlessResult(),
      receipt: {
        ...headlessResult().receipt,
        option: 'client' as const,
        paths: ['/Applications/Hexbot Client Nightly.app']
      },
      status: null
    })),
    defaultTrack: vi.fn(async () => 'nightly' as const),
    detect: vi.fn(async () => detection),
    fetchManifest: vi.fn(async track => ({
      client: { size: 112_000_000 },
      full: { size: 196_000_000 },
      headless: { size: 48_200_000 },
      track,
      version: '0.1.5-nightly.20261004.1'
    })),
    openApp: vi.fn(async () => undefined),
    quit: vi.fn(async () => undefined),
    repair: vi.fn(async () => headlessResult()),
    showPairing: vi.fn(async () => ({
      address: '192.168.1.24:9119',
      code: '7KQ2-M9XD',
      expires: '10 minutes',
      link: 'hexbot://pair?host=192.168.1.24&port=9119#code=7KQ2-M9XD'
    })),
    status: vi.fn(async () => headlessResult().status!),
    uninstall: vi.fn(async () => undefined),
    ...overrides
  }
}

afterEach(cleanup)

const click = (name: RegExp | string) => fireEvent.click(screen.getByRole('button', { name }))

describe('installer', () => {
  it('shows only package manager advice and Quit for a detected deb', async () => {
    const api = fakeApi({ ...installedFull, installed: {
      ...installedFull.installed!, apps: [{ path: '/opt/Hexbot', managed_by_dpkg: true }]
    } })

    render(<App api={api} />)
    await screen.findByText(/Hexbot was installed with your package manager/)
    expect(screen.getAllByRole('button').map(button => button.textContent)).toEqual(['Quit'])
    click('Quit')
    expect(api.quit).toHaveBeenCalledOnce()
  })

  it.each(['repair', 'uninstall'] as const)('refreshes disk state after failed %s before enabling Back', async job => {
    let finishDetection!: (value: Detection) => void

    const detect = vi.fn().mockResolvedValueOnce(installedFull).mockImplementationOnce(
      () => new Promise<Detection>(resolve => { finishDetection = resolve })
    )

    const api = fakeApi(installedFull, { detect, [job]: vi.fn().mockRejectedValue('Partial change') })

    render(<App api={api} />)
    await screen.findByText('Hexbot Full is installed')
    click(job === 'repair' ? /^Update or repair/ : /^Uninstall/)

    if (job === 'uninstall') {click('Uninstall')}
    await waitFor(() => expect(detect).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Escape' })
    finishDetection(fresh)
    await screen.findByText('Partial change')
    click('Back')
    await screen.findByText('Welcome to Hexbot')
  })

  it('installs Headless and shows where to reach the daemon', async () => {
    const api = fakeApi(fresh)

    render(<App api={api} />)
    await screen.findByText('Welcome to Hexbot')
    click('Continue')

    // Only the option page fetches the manifest.
    expect(api.fetchManifest).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('radio', { name: 'Headless' }))
    expect(screen.getByRole('radio', { name: 'Headless' })).toHaveAttribute('aria-checked', 'true')
    click('Continue')

    await screen.findByText('48 MB, then Python and voice tools')
    expect(api.fetchManifest).toHaveBeenCalledWith('nightly')
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true')
    click('Install Headless')

    await screen.findByText('Hexbot Headless is running')
    expect(api.apply).toHaveBeenCalledWith('headless', 'nightly', expect.any(Function))
    expect(screen.getByText('192.168.1.24:9119')).toBeInTheDocument()
    expect(screen.getByText('100.101.102.103:9119')).toBeInTheDocument()
    expect(screen.getByText('hexbot service logs')).toBeInTheDocument()

    click('Show pairing code')
    expect(await screen.findByText('7KQ2-M9XD')).toBeInTheDocument()
  })

  it('moves through the option cards with the arrow keys and continues with Enter', async () => {
    render(<App api={fakeApi(fresh)} />)
    await screen.findByText('Welcome to Hexbot')
    fireEvent.keyDown(window, { key: 'Enter' })
    await screen.findByText('How do you want to use Hexbot?')

    const headless = screen.getByRole('radio', { name: 'Headless' })

    fireEvent.keyDown(headless, { key: 'ArrowRight' })
    expect(screen.getByRole('radio', { name: 'Headless' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.keyDown(headless, { key: 'ArrowRight' })
    expect(screen.getByRole('radio', { name: 'Client' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Client' }), { key: 'Enter' })
    await screen.findByText('Hexbot Client')

    fireEvent.keyDown(window, { key: 'Escape' })
    await screen.findByText('How do you want to use Hexbot?')
  })

  it('shows a readable error and tries the same install again', async () => {
    const apply = vi
      .fn()
      .mockRejectedValueOnce('Quit Hexbot Nightly, then run the installer again.')
      .mockResolvedValueOnce(headlessResult())

    render(<App api={fakeApi(fresh, { apply })} />)
    await screen.findByText('Welcome to Hexbot')
    click('Continue')
    fireEvent.click(screen.getByRole('radio', { name: 'Headless' }))
    click('Continue')
    await screen.findByText('48 MB, then Python and voice tools')
    click('Install Headless')

    expect(await screen.findByText('Quit Hexbot Nightly, then try again.')).toBeInTheDocument()
    expect(screen.getByText('Hexbot Headless was not installed')).toBeInTheDocument()
    click('Try again')
    await screen.findByText('Hexbot Headless is running')
    expect(apply).toHaveBeenCalledTimes(2)
  })

  it('opens on the installed screen and changes Full to Client', async () => {
    const api = fakeApi(installedFull)

    render(<App api={api} />)
    await screen.findByText('Hexbot Full is installed')
    expect(screen.getByText('Nightly 0.1.5-nightly.20261004.1')).toBeInTheDocument()
    click(/^Change/)

    expect(screen.getByRole('radio', { name: 'Full' })).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(screen.getByRole('radio', { name: 'Client' }))
    click('Continue')
    await screen.findByText('112 MB')
    expect(
      screen.getByText('The Hexbot app will be removed. Your Hexbot data stays in ~/.hexbot.')
    ).toBeInTheDocument()
    click('Change to Client')

    await screen.findByText('Hexbot Client is installed')
    expect(api.change).toHaveBeenCalledWith('full', 'client', 'nightly', expect.any(Function))
    click('Open Hexbot')
    expect(api.openApp).toHaveBeenCalledWith('/Applications/Hexbot Client Nightly.app')
  })

  it('uninstalls and keeps data unless asked', async () => {
    const api = fakeApi(installedFull)

    render(<App api={api} />)
    await screen.findByText('Hexbot Full is installed')
    click(/^Uninstall/)

    expect(screen.getByRole('checkbox')).not.toBeChecked()
    expect(screen.getByText('/Applications/Hexbot Nightly.app')).toBeInTheDocument()
    expect(screen.getByText('The daemon runtime in ~/.hexbot/runtime')).toBeInTheDocument()
    // Enter must not uninstall by accident.
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(api.uninstall).not.toHaveBeenCalled()

    click('Uninstall')
    await screen.findByText('Hexbot is uninstalled')
    expect(api.uninstall).toHaveBeenCalledWith(false, expect.any(Function))
    expect(screen.getByText(/Your Hexbot data is still in ~\/\.hexbot/)).toBeInTheDocument()
  })

  it('deletes data only when the box is ticked', async () => {
    const api = fakeApi(installedFull)

    render(<App api={api} />)
    await screen.findByText('Hexbot Full is installed')
    click(/^Uninstall/)
    fireEvent.click(screen.getByRole('checkbox'))
    click('Uninstall and delete data')
    await screen.findByText('Hexbot is uninstalled')
    expect(api.uninstall).toHaveBeenCalledWith(true, expect.any(Function))
  })

  it('updates the installed option in one step', async () => {
    const api = fakeApi({
      ...installedFull,
      installed: { ...installedFull.installed!, option: 'headless', apps: [] }
    })

    render(<App api={api} />)
    await screen.findByText('Hexbot Headless is installed')
    click(/^Update or repair/)
    await screen.findByText('Hexbot Headless is up to date')
    expect(api.repair).toHaveBeenCalledTimes(1)
  })

  it('says so on a computer Hexbot does not support', async () => {
    render(
      <App api={fakeApi({ ...fresh, locations: null, platform: 'linux/aarch64', target: null })} />
    )
    await screen.findByText('Hexbot is not available for this computer')
    expect(screen.getByText(/This computer is linux\/aarch64/)).toBeInTheDocument()
  })

  it('keeps the install button off while no release exists on a track', async () => {
    const fetchManifest = vi.fn(async () => {
      throw 'No Stable release is published yet.'
    })

    render(
      <App
        api={fakeApi(fresh, { defaultTrack: vi.fn(async () => 'stable' as const), fetchManifest })}
      />
    )
    await screen.findByText('Welcome to Hexbot')
    click('Continue')
    fireEvent.click(screen.getByRole('radio', { name: 'Full' }))
    click('Continue')
    await screen.findByText('No Stable release is published yet.')
    expect(screen.getByRole('button', { name: 'Install Full' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()

    await waitFor(() => expect(screen.getByRole('switch')).not.toBeDisabled())
  })
})

it('does not retry a failed uninstall with the Enter shortcut', async () => {
  const uninstall = vi.fn().mockRejectedValueOnce('Could not remove the app.').mockResolvedValueOnce(undefined)

  render(<App api={fakeApi(installedFull, { uninstall })} />)
  await screen.findByText('Hexbot Full is installed')
  click(/^Uninstall/)
  click('Uninstall')
  await screen.findByText('Hexbot was not uninstalled')
  fireEvent.keyDown(window, { key: 'Enter' })
  expect(uninstall).toHaveBeenCalledTimes(1)
  click('Try again')
  await screen.findByText('Hexbot is uninstalled')
  expect(uninstall).toHaveBeenCalledTimes(2)
})

it('reports daemon files without offering Headless repair', async () => {
  const api = fakeApi({ ...fresh, daemonFiles: true })

  render(<App api={api} />)
  await screen.findByText('Welcome to Hexbot')
  expect(screen.getByText('Hexbot daemon files were found in ~/.hexbot. Your data stays.')).toBeInTheDocument()
  fireEvent.keyDown(window, { key: 'Enter' })
  await screen.findByText('How do you want to use Hexbot?')
  expect(api.repair).not.toHaveBeenCalled()
  expect(api.apply).not.toHaveBeenCalled()
})

it.each([false, true])('Full repair reports the retained service: %s', async service => {
  const detection = { ...installedFull, installed: { ...installedFull.installed!, service } }

  const repair = vi.fn(async () => ({
    ...headlessResult(),
    receipt: { ...headlessResult().receipt, option: 'full' as const, paths: ['/Applications/Hexbot Nightly.app'] },
    status: null
  }))

  render(<App api={fakeApi(detection, { repair })} />)
  await screen.findByText('Hexbot Full is installed')
  click(/^Update or repair/)
  await screen.findByText('Hexbot Full is up to date')
  expect(screen.getByText(service
    ? 'The app uses the daemon that already runs here as a background service.'
    : 'Open Hexbot to set up the daemon and meet your first bot.')).toBeInTheDocument()
})

it.each(['headless', 'client'] as const)('uninstall lists the runtime for %s with daemon files', async option => {
  render(<App api={fakeApi({ ...installedFull, daemonFiles: true, installed: { ...installedFull.installed!, option } })} />)
  await screen.findByText(`Hexbot ${option === 'headless' ? 'Headless' : 'Client'} is installed`)
  click(/^Uninstall/)
  expect(screen.getByText('The daemon runtime in ~/.hexbot/runtime')).toBeInTheDocument()
})

it.each([undefined, { installed: true, running: false }])('polls until the installed service runs, even with another daemon running: %s', async service => {
  vi.useFakeTimers()
  const result = headlessResult()

  result.status = { ...result.status, service }

  const status = vi.fn().mockResolvedValueOnce(result.status).mockResolvedValueOnce({
    ...result.status, running: false, service: { installed: true, running: true }
  })

  try {
    render(<HeadlessDone api={fakeApi(fresh, { status })} job={{ kind: 'install', from: null, option: 'headless', track: 'nightly' }} notes={[]} result={result} />)
    expect(screen.getByText('The daemon service is starting.')).toBeInTheDocument()
    await act(() => vi.advanceTimersByTimeAsync(1500))
    expect(status).toHaveBeenCalledTimes(1)
    expect(screen.getByText('The daemon service is starting.')).toBeInTheDocument()
    await act(() => vi.advanceTimersByTimeAsync(1500))
    expect(screen.getByText('Hexbot Headless is running')).toBeInTheDocument()
    await act(() => vi.advanceTimersByTimeAsync(1500))
    expect(status).toHaveBeenCalledTimes(2)
  } finally {
    cleanup()
    vi.useRealTimers()
  }
})

it('stops polling and reports a service that never started', async () => {
  vi.useFakeTimers()
  const result = headlessResult()

  result.status = { ...result.status, service: { installed: true, running: false } }
  const status = vi.fn().mockResolvedValue(result.status)

  try {
    render(<HeadlessDone api={fakeApi(fresh, { status })} job={{ kind: 'repair', option: 'headless' }} notes={[]} result={result} />)

    for (let attempt = 0; attempt < 8; attempt++) {
      await act(() => vi.advanceTimersByTimeAsync(1500))
    }

    expect(screen.getByText('The daemon service is installed but has not started. Check hexbot service logs.')).toBeInTheDocument()
    await act(() => vi.advanceTimersByTimeAsync(1500))
    expect(status).toHaveBeenCalledTimes(8)
  } finally {
    cleanup()
    vi.useRealTimers()
  }
})

it.each([false, undefined])('offers the copyable LAN command instead of pairing when LAN is %s', async lan => {
  const result = headlessResult()

  result.status = { ...result.status, lan_enabled: lan }
  const api = fakeApi(fresh)
  const writeText = vi.fn().mockResolvedValue(undefined)

  vi.stubGlobal('navigator', { clipboard: { writeText } })

  try {
    render(<HeadlessDone api={api} job={{ kind: 'repair', option: 'headless' }} notes={[]} result={result} />)
    expect(screen.queryByRole('button', { name: 'Show pairing code' })).not.toBeInTheDocument()
    expect(screen.queryByText('100.101.102.103:9119')).not.toBeInTheDocument()
    expect(screen.getByText(/LAN access is off/)).toHaveTextContent('LAN access is off. Turn it on with hexbot lan on to pair over your network, or use Hex Connect.')
    click('Copy hexbot lan on')
    expect(writeText).toHaveBeenCalledWith('hexbot lan on')
    await screen.findByRole('button', { name: 'hexbot lan on copied' })
    expect(api.showPairing).not.toHaveBeenCalled()
  } finally {
    vi.unstubAllGlobals()
  }
})

it('offers pairing over Tailscale when LAN is on', async () => {
  const result = headlessResult()

  result.status = { ...result.status, lan_addresses: [] }
  const api = fakeApi(fresh)

  render(<HeadlessDone api={api} job={{ kind: 'repair', option: 'headless' }} notes={[]} result={result} />)
  expect(screen.getByText('100.101.102.103:9119')).toBeInTheDocument()
  click('Show pairing code')
  expect(await screen.findByText('7KQ2-M9XD')).toBeInTheDocument()
})

it.each([false, undefined])('hides pairing until the service is running (%s)', running => {
  const result = headlessResult()

  result.status = { ...result.status, service: { installed: true, running } }
  const api = fakeApi(fresh)

  render(<HeadlessDone api={api} job={{ kind: 'repair', option: 'headless' }} notes={[]} result={result} />)
  expect(screen.queryByRole('button', { name: 'Show pairing code' })).not.toBeInTheDocument()
  expect(screen.getByText('The daemon service has not started. Check hexbot service logs.')).toBeInTheDocument()
  expect(api.showPairing).not.toHaveBeenCalled()
})

it.each([
  { lanAddresses: [] },
  { lanAddresses: ['127.0.0.1', '127.0.1.2', '::1', '[::1]', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1', 'localhost'] }
])(
  'requires a network address beyond loopback ($lanAddresses)', ({ lanAddresses }) => {
    const result = headlessResult()

    result.status = { ...result.status, lan_addresses: lanAddresses, tailscale_ipv4: null }
    const api = fakeApi(fresh)

    render(<HeadlessDone api={api} job={{ kind: 'repair', option: 'headless' }} notes={[]} result={result} />)
    expect(screen.queryByRole('button', { name: 'Show pairing code' })).not.toBeInTheDocument()
    expect(screen.getByText('No network address found. Connect this computer to a network, or use Hex Connect.')).toBeInTheDocument()
    expect(api.showPairing).not.toHaveBeenCalled()
  }
)

it('offers pairing when service polling first reports a running daemon', async () => {
  vi.useFakeTimers()
  const result = headlessResult()

  result.status = { ...result.status, service: { running: false } }

  try {
    render(<HeadlessDone api={fakeApi(fresh)} job={{ kind: 'repair', option: 'headless' }} notes={[]} result={result} />)
    expect(screen.queryByRole('button', { name: 'Show pairing code' })).not.toBeInTheDocument()
    await act(() => vi.advanceTimersByTimeAsync(1500))
    expect(screen.getByRole('button', { name: 'Show pairing code' })).toBeInTheDocument()
    expect(screen.queryByText('The daemon service has not started. Check hexbot service logs.')).not.toBeInTheDocument()
  } finally {
    cleanup()
    vi.useRealTimers()
  }
})

it.each([['2 minutes', 120_000], ['1 second', 1000], ['', 600_000], ['unknown', 600_000]] as const)(
  'clears the pairing code and QR at expiry (%s), then allows renewal', async (expires, lifetime) => {
    vi.useFakeTimers()

    const showPairing = vi.fn().mockResolvedValue({
      address: '192.168.1.24:9119', code: '7KQ2-M9XD', expires,
      link: 'hexbot://pair?host=192.168.1.24&port=9119#code=7KQ2-M9XD'
    })

    try {
      render(<HeadlessDone api={fakeApi(fresh, { showPairing })} job={{ kind: 'repair', option: 'headless' }} notes={[]} result={headlessResult()} />)
      await act(async () => click('Show pairing code'))
      expect(screen.getByLabelText('Pairing code')).toHaveTextContent('7KQ2-M9XD')
      expect(screen.getByRole('img', { name: 'Pairing QR code' })).toBeInTheDocument()
      expect(vi.getTimerCount()).toBe(1)
      await act(() => vi.advanceTimersByTimeAsync(lifetime - 1))
      expect(screen.getByLabelText('Pairing code')).toBeInTheDocument()
      await act(() => vi.advanceTimersByTimeAsync(1))
      expect(screen.queryByLabelText('Pairing code')).not.toBeInTheDocument()
      expect(screen.queryByRole('img', { name: 'Pairing QR code' })).not.toBeInTheDocument()
      expect(screen.getByText('This code expired.')).toBeInTheDocument()
      expect(vi.getTimerCount()).toBe(0)
      await act(async () => click('New code'))
      expect(screen.queryByText('This code expired.')).not.toBeInTheDocument()
      expect(screen.getByLabelText('Pairing code')).toBeInTheDocument()
      expect(showPairing).toHaveBeenCalledTimes(2)
      expect(vi.getTimerCount()).toBe(1)
      cleanup()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      cleanup()
      vi.useRealTimers()
    }
  }
)

it('replaces the expiry timeout when a new code is requested early', async () => {
  vi.useFakeTimers()

  try {
    render(<HeadlessDone api={fakeApi(fresh)} job={{ kind: 'repair', option: 'headless' }} notes={[]} result={headlessResult()} />)
    await act(async () => click('Show pairing code'))
    await act(() => vi.advanceTimersByTimeAsync(300_000))
    await act(async () => click('New code'))
    expect(vi.getTimerCount()).toBe(1)
    await act(() => vi.advanceTimersByTimeAsync(300_000))
    expect(screen.getByLabelText('Pairing code')).toBeInTheDocument()
    await act(() => vi.advanceTimersByTimeAsync(300_000))
    expect(screen.getByText('This code expired.')).toBeInTheDocument()
  } finally {
    cleanup()
    vi.useRealTimers()
  }
})

it.each(['nightly', 'stable'] as const)('the Nightly toggle overrides the %s default', async track => {
  const other = track === 'nightly' ? 'stable' : 'nightly'
  const api = fakeApi(fresh, { defaultTrack: vi.fn(async () => track) })

  render(<App api={api} />)
  await screen.findByText('Welcome to Hexbot')
  click('Continue')
  fireEvent.click(screen.getByRole('radio', { name: 'Headless' }))
  click('Continue')
  await waitFor(() => expect(screen.getByRole('button', { name: 'Install Headless' })).toBeEnabled())
  expect(api.fetchManifest).toHaveBeenCalledWith(track)
  fireEvent.click(screen.getByRole('switch'))
  await waitFor(() => expect(api.fetchManifest).toHaveBeenLastCalledWith(other))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Install Headless' })).toBeEnabled())
  click('Install Headless')
  await screen.findByText('Hexbot Headless is running')
  expect(api.apply).toHaveBeenCalledWith('headless', other, expect.any(Function))
})
