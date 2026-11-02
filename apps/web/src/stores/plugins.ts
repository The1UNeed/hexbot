/**
 * Settings, Plugins: every connector, MCP server, skill, built-in tool and
 * package with the bots it is given to. Refreshed when the page opens and on
 * `hexbot.connectors.changed`, which every plugin change sends.
 */

import { create } from 'zustand'

import {
  type PluginConfigureInput,
  type PluginInstallInput,
  pluginsConfigure,
  pluginsInstall,
  pluginsList,
  pluginsRemove,
  pluginsSetBots
} from '../lib/api'
import { pluginRows } from '../lib/plugin-rows'
import type { Plugin, PluginKind } from '../lib/types'

import { connectionRead } from './connection'

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

export interface PluginsState {
  configure: (plugin: Plugin, change: PluginConfigureInput) => Promise<void>
  error: null | string
  install: (input: PluginInstallInput) => Promise<void>
  /** True once the page has asked for the list; events refresh only then. */
  loaded: boolean
  loading: boolean
  plugins: Plugin[]
  refresh: () => Promise<void>
  remove: (plugin: Plugin) => Promise<void>
  /** Forget everything: another daemon has other plugins and bots. */
  reset: () => void
  setBots: (plugin: Plugin, bots: string[]) => Promise<void>
}

/** Only the latest refresh may change the list or end the loading state. */
let latest = 0

export const usePlugins = create<PluginsState>((set, get) => {
  const replace = (key: string, plugin: Plugin) =>
    set(state => ({
      plugins: state.plugins.map(item => (`${item.kind}:${item.id}` === key ? plugin : item))
    }))

  return {
    error: null,
    loaded: false,
    loading: false,
    plugins: [],

    async refresh() {
      const current = connectionRead()
      const mine = ++latest
      set({ error: null, loaded: true, loading: true })

      try {
        const list = await pluginsList()

        if (current() && mine === latest) {
          set({ plugins: pluginRows(list) })
        }
      } catch (error) {
        if (current() && mine === latest) {
          set({ error: errorText(error) })
        }
      } finally {
        if (mine === latest) {
          set({ loading: false })
        }
      }
    },

    reset() {
      latest++
      set({ error: null, loaded: false, loading: false, plugins: [] })
    },

    async setBots(plugin, bots) {
      const key = `${plugin.kind}:${plugin.id}`

      // Show the switch where the user put it while the daemon catches up.
      replace(key, { ...plugin, bots })

      try {
        await pluginsSetBots(plugin.kind as PluginKind, plugin.id, bots)
      } catch (error) {
        replace(key, plugin)

        throw error
      }

      // Giving a package or a skill can change other rows; read them all again.
      await get().refresh()
    },

    async install(input) {
      await pluginsInstall(input)
      await get().refresh()
    },

    async configure(plugin, change) {
      await pluginsConfigure(plugin.kind, plugin.id, change)
      await get().refresh()
    },

    async remove(plugin) {
      await pluginsRemove(plugin.id)
      set(state => ({
        plugins: state.plugins.filter(item => item.kind !== plugin.kind || item.id !== plugin.id)
      }))
    }
  }
})

/** For the event router: refresh only once Settings, Plugins has loaded. */
export function refreshPluginsIfLoaded(): void {
  if (usePlugins.getState().loaded) {
    void usePlugins.getState().refresh()
  }
}
