/**
 * Deployment settings, providers, models, network and paired devices.
 * Small and cold: refreshed on connect and on `hexbot.*.changed`.
 */

import { create } from 'zustand'

import {
  devicesList,
  devicesRevoke,
  modelsList,
  networkGet,
  networkSet,
  providersClearKey,
  providersList,
  providersSetKey,
  settingsGet,
  settingsSet
} from '../lib/api'
import type { Device, ModelOption, NetworkInfo, Provider, Settings } from '../lib/types'

import { connectionRead } from './connection'

let latest = 0

export interface SettingsState {
  clearProviderKey: (provider: string) => Promise<void>
  devices: Device[]
  error: null | string
  loading: boolean
  models: { all: ModelOption[]; curated: ModelOption[] }
  network: NetworkInfo | null
  patch: (patch: Partial<Settings>) => Promise<void>
  providers: Provider[]
  refresh: () => Promise<void>
  refreshDevices: () => Promise<void>
  refreshModels: (provider?: string) => Promise<void>
  refreshNetwork: () => Promise<void>
  refreshProviders: () => Promise<void>
  revokeDevice: (id: string) => Promise<void>
  setLanEnabled: (enabled: boolean) => Promise<void>
  setProviderKey: (provider: string, key: string) => Promise<void>
  settings: null | Settings
}

export const useSettings = create<SettingsState>((set, get) => ({
  devices: [],
  error: null,
  loading: false,
  models: { all: [], curated: [] },
  network: null,
  providers: [],
  settings: null,

  async refresh() {
    const current = connectionRead()
    const mine = ++latest
    set({ error: null, loading: true })

    try {
      const settings = await settingsGet()

      if (current()) {
        set({ settings })
      }
    } catch (error) {
      if (current()) {
        set({ error: error instanceof Error ? error.message : String(error) })
      }
    } finally {
      if (mine === latest) {
        set({ loading: false })
      }
    }
  },

  async patch(patch) {
    const current = connectionRead()
    const settings = await settingsSet(patch)

    if (current()) {
      set({ settings })
    }
  },

  async refreshProviders() {
    const current = connectionRead()
    const { providers } = await providersList()

    if (current()) {
      set({ providers })
    }
  },

  async setProviderKey(provider, key) {
    const current = connectionRead()
    await providersSetKey(provider, key)

    if (current()) {
      await get().refreshProviders()
    }
  },

  async clearProviderKey(provider) {
    const current = connectionRead()
    await providersClearKey(provider)

    if (current()) {
      // Removing the provider also drops its default and fallback models.
      await Promise.all([get().refreshProviders(), get().refresh()])
    }
  },

  async refreshModels(provider) {
    const current = connectionRead()
    const result = await modelsList(provider)

    if (current()) {
      set({ models: { all: result.all ?? [], curated: result.curated ?? [] } })
    }
  },

  async refreshNetwork() {
    const current = connectionRead()
    const network = await networkGet()

    if (current()) {
      set({ network })
    }
  },

  async setLanEnabled(enabled) {
    const current = connectionRead()
    const network = await networkSet(enabled)

    if (current()) {
      set({ network })
      await get().refresh()
    }
  },

  async refreshDevices() {
    const current = connectionRead()

    try {
      const { devices } = await devicesList()

      if (current()) {
        set({ devices })
      }
    } catch {
      // Pairing lands with milestone 2; an older daemon answers -32601.
      if (current()) {
        set({ devices: [] })
      }
    }
  },

  async revokeDevice(id) {
    const current = connectionRead()
    await devicesRevoke(id)

    if (current()) {
      await get().refreshDevices()
    }
  }
}))

export function settingsActions(): SettingsState {
  return useSettings.getState()
}
