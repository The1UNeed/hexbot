import { contextBridge, ipcRenderer } from 'electron'

const metadata = ipcRenderer.sendSync('hexbot:metadata') as {
  e2eTarget?: string
  platform: NodeJS.Platform
  version: string
  isPackaged: boolean
  edition: 'full' | 'client'
}
const listen = <T>(channel: string, callback: (value: T) => void): (() => void) => {
  if (typeof callback !== 'function') throw new TypeError('Listener must be a function')
  const listener = (_event: Electron.IpcRendererEvent, value: T): void => callback(value)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}
const updateStatuses = new Set([
  'disabled',
  'idle',
  'checking',
  'available',
  'downloading',
  'downloaded',
  'up-to-date',
  'error'
])
// The updater state (src/main/update-state.ts); the renderer only ever sees
// a well-formed one.
function validUpdateState(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return (
    typeof item.status === 'string' &&
    updateStatuses.has(item.status) &&
    (item.channel === 'stable' || item.channel === 'nightly') &&
    typeof item.currentVersion === 'string'
  )
}
const hexbot = Object.freeze({
  ...metadata,
  daemon: Object.freeze({
    status: () => ipcRenderer.invoke('hexbot:daemon:status'),
    start: () => ipcRenderer.invoke('hexbot:daemon:start'),
    stop: () => ipcRenderer.invoke('hexbot:daemon:stop'),
    onProgress: (callback: (value: unknown) => void) => listen('hexbot:daemon:progress', callback),
    localToken: () => ipcRenderer.invoke('hexbot:daemon:local-token')
  }),
  // The main process returns camelCase; the renderer reads the daemon's wire
  // shape (daemon_name, device_id, device_token), so normalise here.
  pair: async (host: string, port: number, code: string, deviceName: string) => {
    const result = (await ipcRenderer.invoke('hexbot:pair', { host, port, code, deviceName })) as {
      deviceToken: string
      daemonName: string
    }
    return { daemon_name: result.daemonName, device_id: '', device_token: result.deviceToken }
  },
  pairWithGrant: async (input: {
    host: string
    grant: string
    deviceName: string
    tls?: boolean
  }) => {
    const token = (await ipcRenderer.invoke('hexbot:pair-with-grant', {
      tls: true,
      ...input
    })) as string
    return { daemon_name: input.host, device_id: '', device_token: token }
  },
  httpFetch: (
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string }
  ) => ipcRenderer.invoke('hexbot:http-fetch', url, init ?? {}),
  notify: (options: unknown) => ipcRenderer.invoke('hexbot:notify', options),
  openExternal: (url: string) => ipcRenderer.invoke('hexbot:open-external', url),
  pickFiles: () => ipcRenderer.invoke('hexbot:pick-files'),
  updater: Object.freeze({
    state: () => ipcRenderer.invoke('hexbot:updater:state'),
    channel: () => ipcRenderer.invoke('hexbot:updater:channel'),
    check: () => ipcRenderer.invoke('hexbot:updater:check'),
    download: () => ipcRenderer.invoke('hexbot:updater:download'),
    install: () => ipcRenderer.invoke('hexbot:updater:install'),
    onStatus: (callback: (value: unknown) => void) =>
      listen<unknown>('hexbot:updater:status', value => {
        if (validUpdateState(value)) callback(value)
      }),
    setChannel: (channel: 'stable' | 'nightly') =>
      ipcRenderer.invoke('hexbot:updater:set-channel', channel)
  }),
  setCrashReports: (enabled: boolean) => ipcRenderer.invoke('hexbot:crash-reports:set', enabled),
  service: Object.freeze({
    install: () => ipcRenderer.invoke('hexbot:service:install'),
    uninstall: () => ipcRenderer.invoke('hexbot:service:uninstall'),
    status: () => ipcRenderer.invoke('hexbot:service:status')
  }),
  onNavigate: (callback: (value: string) => void) => listen('hexbot:navigate', callback)
})
contextBridge.exposeInMainWorld('hexbot', hexbot)
