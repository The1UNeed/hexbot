/**
 * Typed accessor for the Electron preload bridge (docs/client-architecture.md).
 * In a plain browser `window.hexbot` is undefined and every native-only
 * control hides itself behind `isElectron()`.
 */

export interface DaemonProgress {
  /** Free-form log line for the disclosure panel. */
  detail?: string
  /** 0..1 when known. */
  fraction?: number
  message: string
  stage:
    | 'dependencies'
    | 'done'
    | 'error'
    | 'git'
    | 'python'
    | 'ripgrep'
    | 'starting'
    | 'uv'
    | (string & {})
}

export interface DaemonStatus {
  pid?: null | number
  port?: null | number
  running: boolean
  version?: null | string
}

export interface BridgeHttpResponse {
  status: number
  statusText: string
  headers: Record<string, string>
  text: string
}

export interface HexbotBridge {
  daemon: {
    localToken(): Promise<null | string>
    onProgress(callback: (progress: DaemonProgress) => void): () => void
    start(): Promise<DaemonStatus>
    status(): Promise<DaemonStatus>
    stop(): Promise<void>
  }
  /** Test-only daemon origin supplied by the Electron main process. */
  e2eTarget?: string
  /** 'full' ships the daemon runtime; 'client' can only connect to one elsewhere. */
  edition: 'client' | 'full'
  isPackaged: boolean
  notify(input: { body: string; sectionId?: string; title: string }): void
  openExternal(url: string): Promise<void> | void
  onNavigate?(callback: (url: string) => void): () => void
  pairWithGrant?(input: {
    host: string
    grant: string
    deviceName: string
    tls?: boolean
  }): Promise<PairResult>
  pair(host: string, port: number, code: string, deviceName: string): Promise<PairResult>
  httpFetch(
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string }
  ): Promise<BridgeHttpResponse>
  pickFiles(): Promise<PickedFile[]>
  platform: string
  service: {
    install(): Promise<ServiceStatus>
    status(): Promise<ServiceStatus>
  }
  setCrashReports(enabled: boolean): Promise<void>
  updater: {
    channel(): Promise<UpdateChannel>
    check(): Promise<UpdateStatus>
    install(): Promise<void>
    onStatus(callback: (status: UpdateStatus) => void): () => void
    setChannel(channel: UpdateChannel): Promise<void>
  }
  version: string
}

/** The update track (docs/channels.md): tagged releases, or nightly builds of main. */
export type UpdateChannel = 'nightly' | 'stable'

export interface PairResult {
  daemon_name: string
  device_id: string
  device_token: string
}

export interface PickedFile {
  data_url: string
  mime: string
  name: string
  size: number
}

export interface ServiceStatus {
  installed: boolean
  message?: string
  running?: boolean
}

/** What the desktop updater reports (apps/desktop/src/main/updater.ts). */
export interface UpdateStatus {
  message?: string
  percent?: number
  state: 'available' | 'checking' | 'downloaded' | 'downloading' | 'error' | 'idle' | 'none'
  version?: string
}

declare global {
  interface Window {
    __HERMES_AUTH_REQUIRED__?: boolean
    __HERMES_SESSION_TOKEN__?: string
    hexbot?: HexbotBridge
  }
}

/** The Electron bridge, or `null` in a plain browser. */
export function getBridge(): HexbotBridge | null {
  if (typeof window === 'undefined') {
    return null
  }

  return window.hexbot ?? null
}

export function isElectron(): boolean {
  return getBridge() !== null
}

/** True when this app can run a daemon on this machine. */
export function hasLocalRuntime(): boolean {
  return getBridge()?.edition === 'full'
}

/** Default device name for the connect screen. */
export function defaultDeviceName(): string {
  const bridge = getBridge()
  const platform = bridge?.platform ?? guessBrowserPlatform()

  return bridge ? `Hexbot on ${platform}` : `Hexbot web on ${platform}`
}

function guessBrowserPlatform(): string {
  if (typeof navigator === 'undefined') {
    return 'this device'
  }

  const agent = navigator.userAgent

  if (/Mac/i.test(agent)) {
    return 'macOS'
  }

  if (/Windows/i.test(agent)) {
    return 'Windows'
  }

  if (/Linux|X11/i.test(agent)) {
    return 'Linux'
  }

  return 'this device'
}
