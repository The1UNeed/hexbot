import type {
  DaemonStatus,
  Detection,
  InstallerApi,
  InstallOption,
  InstallResult,
  OnProgress,
  Progress,
  Track
} from '../api'

/**
 * A fake engine for previewing the screens in a plain browser (`pnpm dev`).
 * Only loaded in development outside Tauri. Query parameters pick the start:
 * `?installed=full|client|headless`, `?unsupported`, `?fail=apply|manifest`,
 * `?track=stable`, `?speed=0` (finish instantly), `?hold=<stage>` (stop there).
 */
export function previewApi(params: URLSearchParams): InstallerApi {
  const installed = params.get('installed') as InstallOption | null
  const fail = params.get('fail')
  const hold = params.get('hold')
  const speed = Number(params.get('speed') ?? '1')
  const home = '/Users/sam'
  const version = '0.1.5-nightly.20261004.1'

  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms * speed))
  const forever = () => new Promise<never>(() => undefined)

  const detection: Detection = {
    installed: installed
      ? {
          apps:
            installed === 'headless'
              ? []
              : [
                  { path: `/Applications/${installed === 'full' ? 'Hexbot Nightly' : 'Hexbot Client Nightly'}.app`, managed_by_dpkg: params.has('dpkg') }
                ],
          option: installed,
          service: installed === 'headless',
          track: 'nightly',
          version
        }
      : null,
    daemonFiles: false,
    installerVersion: '0.1.5',
    locations: {
      apps: '/Applications',
      cli: `${home}/.local/bin/hexbot`,
      hexbotHome: `${home}/.hexbot`,
      home
    },
    platform: params.has('unsupported') ? 'linux/aarch64' : 'macos/aarch64',
    target: params.has('unsupported') ? null : 'macos-aarch64'
  }

  const status: DaemonStatus = {
    connect_hostname: params.has('connect') ? 'sam-mac.hexbot.app' : null,
    lan_addresses: ['192.168.1.24'],
    lan_enabled: true,
    port: 9119,
    running: true,
    sandbox_available: true,
    service: { installed: true, running: true },
    tailscale_ipv4: '100.101.102.103',
    version
  }

  async function run(
    option: InstallOption,
    track: Track,
    onProgress: OnProgress,
    from: InstallOption | null
  ) {
    const emit = async (event: Progress, ms = 500) => {
      onProgress(event)

      if (hold === event.stage) {
        await forever()
      }

      await sleep(ms)
    }

    const total =
      option === 'headless' ? 48_200_000 : option === 'client' ? 112_000_000 : 196_000_000

    for (let step = 0; step <= 20; step++) {
      await emit(
        {
          downloaded: Math.round((total * step) / 20),
          message: 'Downloading Hexbot.',
          stage: 'download',
          total
        },
        90
      )
    }

    await emit({ message: 'Checking the download.', stage: 'verify' })

    if (fail === 'apply') {
      throw `Quit ${from === 'full' ? 'Hexbot Nightly' : 'Hexbot Client Nightly'}, then run the installer again.`
    }

    if (option === 'headless') {
      await emit({ message: 'Extracting the daemon.', stage: 'extract' })
      await emit({ message: 'Copying the native runtime', stage: 'copy' })
      await emit({ message: 'Activating the native runtime', stage: 'activate' })
      await emit({ message: 'Preparing the code runtime installer', stage: 'uv' })
      await emit({ message: 'Installing Python for code tools', stage: 'python' }, 1200)
      await emit({ message: 'Installing voice tools', stage: 'voice' }, 1000)
      await emit({ message: `CLI installed at ${home}/.local/bin/hexbot`, stage: 'link' })
      await emit({ message: 'Daemon service installed', stage: 'service' })
    } else {
      await emit({ message: 'Extracting the app.', stage: 'extract' })
      await emit({ message: 'Installing the app.', stage: 'install' })
    }

    if (from) {
      await emit({
        message: `Removing ${detection.installed?.apps[0]?.path ?? 'the daemon service'}.`,
        stage: 'remove'
      })
    }

    const result: InstallResult = {
      receipt: {
        channel: track,
        installedAt: new Date().toISOString(),
        option,
        paths:
          option === 'headless'
            ? [`${home}/.hexbot/runtime/native-executable`]
            : [
                `/Applications/${option === 'full' ? 'Hexbot Nightly' : 'Hexbot Client Nightly'}.app`
              ],
        version
      },
      status: option === 'headless' || (option === 'full' && from === 'headless') ? status : null,
      warnings: params.has('warn')
        ? ['Install bubblewrap for the Auto mode sandbox: sudo apt install bubblewrap.']
        : []
    }

    return result
  }

  return {
    apply: (option, track, onProgress) => run(option, track, onProgress, null),
    change: (from, to, track, onProgress) => run(to, track, onProgress, from),
    defaultTrack: async () => {
      await sleep(150)

      return (params.get('track') as Track | null) ?? 'nightly'
    },
    detect: async () => detection,
    fetchManifest: async track => {
      await sleep(350)

      if (fail === 'manifest' || (track === 'stable' && params.get('track') !== 'stable')) {
        throw track === 'stable'
          ? 'No Stable release is published yet.'
          : 'error sending request for url (https://updates.hexbot.app/install/nightly.json)'
      }

      return {
        client: { size: 112_000_000 },
        full: { size: 196_000_000 },
        headless: { size: 48_200_000 },
        track,
        version
      }
    },
    openApp: async () => undefined,
    quit: async () => undefined,
    repair: onProgress => run(detection.installed!.option, 'nightly', onProgress, null),
    showPairing: async () => {
      await sleep(200)

      return {
        address: '192.168.1.24:9119',
        code: '7KQ2-M9XD',
        expires: '10 minutes',
        link: 'hexbot://pair?host=192.168.1.24&port=9119#code=7KQ2-M9XD'
      }
    },
    status: async () => status,
    uninstall: async (_removeData, onProgress) => {
      onProgress({ message: 'Daemon service stopped', stage: 'service' })
      await sleep(600)
      onProgress({
        message: `Removing ${detection.installed?.apps[0]?.path ?? 'the daemon'}.`,
        stage: 'remove'
      })
      await sleep(600)
    }
  }
}
