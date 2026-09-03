/**
 * Deployment settings, providers, models, network and paired devices.
 * Small and cold: refreshed on connect and on `hexbot.*.changed`.
 */

import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'

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
    set({ error: null, loading: true })

    try {
      set({ loading: false, settings: await settingsGet() })
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error), loading: false })
    }
  },

  async patch(patch) {
    set({ settings: await settingsSet(patch) })
  },

  async refreshProviders() {
    const { providers } = await providersList()

    set({ providers })
  },

  async setProviderKey(provider, key) {
    await providersSetKey(provider, key)
    await get().refreshProviders()
  },

  async clearProviderKey(provider) {
    await providersClearKey(provider)
    await get().refreshProviders()
  },

  async refreshModels(provider) {
    const result = await modelsList(provider)

    set({ models: { all: result.all ?? [], curated: result.curated ?? [] } })
  },

  async refreshNetwork() {
    set({ network: await networkGet() })
  },

  async setLanEnabled(enabled) {
    set({ network: await networkSet(enabled) })
    await get().refresh()
  },

  async refreshDevices() {
    try {
      const { devices } = await devicesList()

      set({ devices })
    } catch {
      // Pairing lands with milestone 2; an older daemon answers -32601.
      set({ devices: [] })
    }
  },

  async revokeDevice(id) {
    await devicesRevoke(id)
    await get().refreshDevices()
  }
}))

export function settingsActions(): SettingsState {
  return useSettings.getState()
}

export function useConfiguredProviders(): Provider[] {
  return useSettings(
    useShallow((state: SettingsState) => state.providers.filter(item => item.configured === true))
  )
}

export function useHasProviderKey(): boolean {
  return useSettings(state => state.providers.some(provider => provider.configured === true))
}
