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

export interface HexbotBridge {
  daemon: {
    localToken(): Promise<null | string>
    onProgress(callback: (progress: DaemonProgress) => void): () => void
    start(): Promise<DaemonStatus>
    status(): Promise<DaemonStatus>
    stop(): Promise<void>
  }
  isPackaged: boolean
  notify(input: { body: string; sectionId?: string; title: string }): void
  openExternal(url: string): Promise<void> | void
  pair(host: string, port: number, code: string, deviceName: string): Promise<PairResult>
  pickFiles(): Promise<PickedFile[]>
  platform: string
  service: {
    install(): Promise<ServiceStatus>
    status(): Promise<ServiceStatus>
  }
  updater: {
    check(): Promise<UpdateStatus>
    install(): Promise<void>
    onStatus(callback: (status: UpdateStatus) => void): () => void
  }
  version: string
}

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

export interface UpdateStatus {
  message?: string
  state: 'available' | 'checking' | 'downloading' | 'error' | 'idle' | 'ready' | (string & {})
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
