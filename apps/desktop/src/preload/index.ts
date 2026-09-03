import { contextBridge, ipcRenderer } from 'electron'

const metadata = ipcRenderer.sendSync('hexbot:metadata') as {
  e2eTarget?: string
  platform: NodeJS.Platform
  version: string
  isPackaged: boolean
}
const listen = <T>(channel: string, callback: (value: T) => void): (() => void) => {
  if (typeof callback !== 'function') throw new TypeError('Listener must be a function')
  const listener = (_event: Electron.IpcRendererEvent, value: T): void => callback(value)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}
const updateStates = new Set([
  'idle',
  'checking',
  'available',
  'downloading',
  'downloaded',
  'none',
  'error'
])
interface UpdateStatus {
  state: string
  percent?: number
  message?: string
}
function validUpdateStatus(value: unknown): value is UpdateStatus {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return (
    typeof item.state === 'string' &&
    updateStates.has(item.state) &&
    (item.percent === undefined || typeof item.percent === 'number') &&
    (item.message === undefined || typeof item.message === 'string')
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
  pair: (host: string, port: number, code: string, deviceName: string) =>
    ipcRenderer.invoke('hexbot:pair', { host, port, code, deviceName }),
  notify: (options: unknown) => ipcRenderer.invoke('hexbot:notify', options),
  openExternal: (url: string) => ipcRenderer.invoke('hexbot:open-external', url),
  pickFiles: () => ipcRenderer.invoke('hexbot:pick-files'),
  updater: Object.freeze({
    check: () => ipcRenderer.invoke('hexbot:updater:check'),
    onStatus: (callback: (value: UpdateStatus) => void) =>
      listen<unknown>('hexbot:updater:status', value => {
        if (validUpdateStatus(value)) callback(value)
      }),
    install: () => ipcRenderer.invoke('hexbot:updater:install')
  }),
  service: Object.freeze({
    install: () => ipcRenderer.invoke('hexbot:service:install'),
    uninstall: () => ipcRenderer.invoke('hexbot:service:uninstall'),
    status: () => ipcRenderer.invoke('hexbot:service:status')
  }),
  onNavigate: (callback: (value: string) => void) => listen('hexbot:navigate', callback)
})
contextBridge.exposeInMainWorld('hexbot', hexbot)
