/**
 * Typed accessor for the Electron preload bridge (docs/client-architecture.md).
 * In a plain browser `window.hexbot` is undefined and every native-only
 * control hides itself behind `isElectron()`.
 */

import type { PairingReply } from '@hermes/shared'

import type { ComputerRequest } from './types'

export interface DaemonProgress {
  message: string
  /** 0..100 within the stage, sent only while it downloads something. */
  percent?: number
  stage:
    | 'dependencies'
    | 'done'
    | 'error'
    | 'python'
    | 'runtime'
    | 'uv'
    | (string & {})
}

export interface DaemonStatus {
  pid?: null | number
  port?: null | number
  running?: boolean
  /** The daemon manager's state (apps/desktop/src/main/backend/manager.ts). */
  state?: 'error' | 'external' | 'running' | 'starting' | 'stopped' | (string & {})
  /** The install id of the daemon this app runs, while it runs one. */
  installId?: null | string
  version?: null | string
}

/** A request from Update everything on this app (apps/desktop/src/main/updater.ts). */
export interface RemoteRequest {
  requestId: string
  state: 'countdown' | 'failed' | 'installing' | 'not_applied' | 'postponed' | 'preparing' | 'ready'
  version: null | string
  error: null | string
  installsAt: null | number
}

export interface BridgeHttpResponse {
  status: number
  statusText: string
  headers: Record<string, string>
  text: string
}

/**
 * What this computer lets bots use (apps/desktop/src/main/computer.ts). The
 * main process owns it: turning on asks natively, and it runs every request.
 */
export interface ComputerShare {
  desktop: boolean
  /** Cua is installed and this computer's desktop is set up for it. */
  desktopReady: boolean
  /** Why the desktop can't be shared yet, when it can't. */
  desktopNote?: null | string
  name: string
  os: string
  terminal: boolean
}

export interface HexbotBridge {
  /** This computer as one of the user's computers; apps from before computers leave it out. */
  computer?: {
    /** Turn the terminal or desktop on (asks first) or off. */
    allow(change: { desktop?: boolean; terminal?: boolean }): Promise<ComputerShare>
    onState?(callback: (share: ComputerShare) => void): () => void
    /** The connection ended: stop what bots started here; the switch stays. */
    release?(): Promise<void>
    /** The daemon stopped one request: end its command. */
    cancel?(requestId: string): Promise<void>
    /** Run one request from the daemon; refused unless allowed here. */
    run(request: ComputerRequest): Promise<unknown>
    /** Set up Cua so bots can use this computer's desktop. */
    setupDesktop(): Promise<ComputerShare>
    state(): Promise<ComputerShare>
  }
  daemon: {
    localToken(): Promise<null | string>
    onProgress(callback: (progress: DaemonProgress) => void): () => void
    start(): Promise<DaemonStatus>
    status(): Promise<DaemonStatus>
    /** Apps from before Update everything leave it out. */
    onStatus?(callback: (status: DaemonStatus) => void): () => void
    stop(): Promise<void>
  }
  /** The build's app id; apps from before Update everything leave it out. */
  appId?: string
  /** Test-only daemon origin supplied by the Electron main process. */
  e2eTarget?: string
  /** 'full' ships the daemon runtime; 'client' can only connect to one elsewhere. */
  edition: 'client' | 'full'
  isPackaged: boolean
  notify(input: { backgroundOnly?: boolean; body: string; sectionId?: string; title: string }): void
  openExternal(url: string): Promise<void> | void
  /**
   * Google's return to 127.0.0.1 on this computer, for a daemon elsewhere:
   * `open` gives the port to send Google back to, `wait` the address the
   * browser came back to (null once closed). Apps from before it leave it out.
   */
  oauthReturn?: {
    close(port: number): Promise<void>
    open(): Promise<number>
    wait(port: number): Promise<null | string>
  }
  /** Opens the system's page for Hexbot's notifications; apps from before it leave it out. */
  openNotificationSettings?(): Promise<void>
  onNavigate?(callback: (url: string) => void): () => void
  /** Whether the app's window is open and not minimized; apps from before it leave it out. */
  onWindowShown?(callback: (shown: boolean) => void): () => void
  pairWithGrant?(input: {
    host: string
    grant: string
    deviceName: string
    tls?: boolean
    proof?: string
  }): Promise<PairingReply<PairResult>>
  pair(host: string, port: number, code: string, deviceName: string, proof?: string): Promise<PairingReply<PairResult>>
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
  /** The app's own privacy switches. Apps from before usage data leave these out. */
  privacy?(): Promise<PrivacyState>
  setUsageData?(enabled: boolean): Promise<void>
  updater: {
    channel(): Promise<UpdateChannel>
    check(): Promise<UpdateState>
    download(): Promise<UpdateState>
    install(): Promise<UpdateState>
    onStatus(callback: (state: UpdateState) => void): () => void
    setChannel(channel: UpdateChannel): Promise<UpdateState>
    state(): Promise<UpdateState>
    // Update everything; apps from before it leave these out.
    remote?(): Promise<null | RemoteRequest>
    prepare?(
      requestId: string,
      track: null | UpdateChannel,
      daemon: null | string
    ): Promise<null | RemoteRequest>
    commit?(requestId: string, countdown: boolean): Promise<null | RemoteRequest>
    cancel?(requestId: string, later: boolean): Promise<null | RemoteRequest>
    onRemote?(callback: (request: null | RemoteRequest) => void): () => void
  }
  version: string
}

/**
 * What the desktop app itself shares (apps/desktop/src/main/usage-data.ts).
 * `*Available` is false in builds that cannot send it, such as dev builds.
 */
export interface PrivacyState {
  crashReports: boolean
  crashReportsAvailable: boolean
  usageData: boolean
  usageDataAvailable: boolean
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

/** The desktop updater's state (apps/desktop/src/main/update-state.ts). */
export interface UpdateState {
  availableVersion: null | string
  channel: UpdateChannel
  checkedAt: null | string
  currentVersion: string
  downloadedVersion: null | string
  errorContext: 'check' | 'download' | 'install' | null
  /** Why updates are off, or the last error. */
  message: null | string
  percent: null | number
  status:
    | 'available'
    | 'checking'
    | 'disabled'
    | 'downloaded'
    | 'downloading'
    | 'error'
    | 'idle'
    | 'installing'
    | 'up-to-date'
}

/** The one thing the user can do with an update state, if anything. */
export function updateAction(state: UpdateState): 'check' | 'download' | 'install' | null {
  if (
    state.downloadedVersion &&
    (state.status === 'downloaded' ||
      (state.status === 'error' && state.errorContext === 'install'))
  ) {
    return 'install'
  }

  if (state.status === 'available') {
    return 'download'
  }

  if (state.status === 'error' && state.errorContext === 'download' && state.availableVersion) {
    return 'download'
  }

  if (state.status === 'idle' || state.status === 'up-to-date' || state.status === 'error') {
    return 'check'
  }

  return null
}

declare global {
  interface Window {
    __HERMES_AUTH_REQUIRED__?: boolean
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
