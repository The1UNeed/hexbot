import { Channel, invoke } from '@tauri-apps/api/core'

/**
 * The commands in src-tauri/src/main.rs, which wrap the installer engine in
 * backend/hexbot-installer. Shapes follow the engine's serde output.
 */

export type InstallOption = 'client' | 'full' | 'headless'
export type Track = 'nightly' | 'stable'

export interface Progress {
  downloaded?: number
  message: string
  stage: string
  total?: number
}

export interface Locations {
  apps: string
  cli: string
  hexbotHome: string
  home: string
}

export interface InstalledApp {
  path: string
  managed_by_dpkg: boolean
}

export interface Installed {
  apps: InstalledApp[]
  option: InstallOption
  service: boolean
  track: null | Track
  version: null | string
}

export interface Detection {
  daemonFiles: boolean
  installed: Installed | null
  installerVersion: string
  locations: Locations | null
  /** `os/arch`, for the unsupported screen. */
  platform: string
  /** Null when Hexbot has no build for this computer. */
  target: null | string
}

export interface Offer {
  size: number
}

export interface ManifestSummary {
  client: null | Offer
  full: null | Offer
  headless: null | Offer
  track: Track
  version: string
}

export interface Receipt {
  channel: Track
  installedAt: string
  option: InstallOption
  paths: string[]
  version: string
}

/** `hexbot status --json` (backend/hexbot-core/src/daemon_status.rs). */
export interface DaemonStatus {
  connect_hostname?: null | string
  lan_addresses?: null | string[]
  lan_enabled?: boolean
  port?: null | number
  running?: boolean
  sandbox_available?: boolean
  service?: { installed?: boolean; running?: boolean }
  tailscale_ipv4?: null | string
  version?: null | string
}

export interface InstallResult {
  receipt: Receipt
  status: DaemonStatus | null
  warnings: string[]
}

export interface Pairing {
  address: string
  code: string
  expires: string
  link: string
}

export type OnProgress = (event: Progress) => void

export interface InstallerApi {
  apply(option: InstallOption, track: Track, onProgress: OnProgress): Promise<InstallResult>
  change(
    from: InstallOption,
    to: InstallOption,
    track: Track,
    onProgress: OnProgress
  ): Promise<InstallResult>
  defaultTrack(): Promise<Track>
  detect(): Promise<Detection>
  fetchManifest(track: Track): Promise<ManifestSummary>
  openApp(path: string): Promise<void>
  quit(): Promise<void>
  repair(onProgress: OnProgress): Promise<InstallResult>
  showPairing(): Promise<Pairing>
  status(): Promise<DaemonStatus>
  uninstall(removeData: boolean, onProgress: OnProgress): Promise<void>
}

function channel(onProgress: OnProgress): Channel<Progress> {
  const progress = new Channel<Progress>()

  progress.onmessage = onProgress

  return progress
}

export const tauriApi: InstallerApi = {
  apply: (option, track, onProgress) =>
    invoke('apply', { onProgress: channel(onProgress), option, track }),
  change: (from, to, track, onProgress) =>
    invoke('change', { from, onProgress: channel(onProgress), to, track }),
  defaultTrack: () => invoke('default_track'),
  detect: () => invoke('detect'),
  fetchManifest: track => invoke('fetch_manifest', { track }),
  openApp: path => invoke('open_app', { path }),
  quit: () => invoke('quit'),
  repair: onProgress => invoke('repair', { onProgress: channel(onProgress) }),
  showPairing: () => invoke('show_pairing'),
  status: () => invoke('status'),
  uninstall: (removeData, onProgress) =>
    invoke('uninstall', { onProgress: channel(onProgress), removeData })
}

/** Tauri rejects with the command's error string; anything else is a bug worth showing. */
export function errorMessage(error: unknown): string {
  if (typeof error === 'string') {
    return error
  }

  return error instanceof Error ? error.message : String(error)
}
