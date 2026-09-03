import { contextBridge } from 'electron'

const hexbot = Object.freeze({
  platform: process.platform,
  version: process.versions.electron
})

contextBridge.exposeInMainWorld('hexbot', hexbot)
