import { contextBridge, ipcRenderer } from 'electron'

const metadata = ipcRenderer.sendSync('hexbot:metadata') as { platform: NodeJS.Platform; version: string; isPackaged: boolean }
const listen = <T>(channel: string, callback: (value: T) => void): (() => void) => {
  const listener = (_event: Electron.IpcRendererEvent, value: T): void => callback(value)
  ipcRenderer.on(channel, listener); return () => ipcRenderer.removeListener(channel, listener)
}
const hexbot = Object.freeze({
  ...metadata,
  daemon: Object.freeze({
    status: () => ipcRenderer.invoke('hexbot:daemon:status'), start: () => ipcRenderer.invoke('hexbot:daemon:start'), stop: () => ipcRenderer.invoke('hexbot:daemon:stop'),
    onProgress: (callback: (value: unknown) => void) => listen('hexbot:daemon:progress', callback), localToken: () => ipcRenderer.invoke('hexbot:daemon:local-token')
  }),
  pair: (host: string, port: number, code: string, deviceName: string) => ipcRenderer.invoke('hexbot:pair', { host, port, code, deviceName }),
  notify: (options: unknown) => ipcRenderer.invoke('hexbot:notify', options), openExternal: (url: string) => ipcRenderer.invoke('hexbot:open-external', url), pickFiles: () => ipcRenderer.invoke('hexbot:pick-files'),
  updater: Object.freeze({ check: () => ipcRenderer.invoke('hexbot:updater:check'), onStatus: (callback: (value: unknown) => void) => listen('hexbot:updater:status', callback), install: () => ipcRenderer.invoke('hexbot:updater:install') }),
  service: Object.freeze({ install: () => ipcRenderer.invoke('hexbot:service:install'), uninstall: () => ipcRenderer.invoke('hexbot:service:uninstall'), status: () => ipcRenderer.invoke('hexbot:service:status') }),
  onNavigate: (callback: (value: string) => void) => listen('hexbot:navigate', callback)
})
contextBridge.exposeInMainWorld('hexbot', hexbot)
