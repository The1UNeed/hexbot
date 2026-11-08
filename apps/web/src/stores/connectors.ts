/**
 * Connector catalog per bot: daemon-wide credential state plus this bot's
 * switch. Refreshed on demand and on `hexbot.connectors.changed`.
 */

import { create } from 'zustand'

import {
  connectorsAddMcp,
  connectorsClear,
  type ConnectorSetupInput,
  connectorsList,
  connectorsRemoveMcp,
  connectorsSetForBot,
  connectorsSetup,
  type McpServerInput
} from '../lib/api'
import type { Connector, ConnectorTest } from '../lib/types'

import { connectionRead } from './connection'

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))
let latest = 0

export interface ConnectorsState {
  addMcp: (bot: string, input: McpServerInput) => Promise<void>
  byBot: Record<string, Connector[]>
  clear: (bot: string, id: string, botOnly?: boolean) => Promise<void>
  error: null | string
  /**
   * Fetch a bot's catalog once, quietly: the chat names connector tools from
   * it. A failure leaves the plain fallback and no error for settings to show.
   */
  load: (bot: string) => Promise<void>
  loading: boolean
  refresh: (bot: string) => Promise<void>
  /** Refresh every bot that has been loaded (event handler). */
  refreshAll: () => Promise<void>
  removeMcp: (bot: string, name: string) => Promise<void>
  setForBot: (bot: string, id: string, enabled: boolean) => Promise<void>
  setup: (input: ConnectorSetupInput & { bot: string }) => Promise<ConnectorTest>
}

export const useConnectors = create<ConnectorsState>((set, get) => ({
  byBot: {},
  error: null,
  loading: false,

  async load(bot) {
    if (bot in get().byBot) {
      return
    }

    const current = connectionRead()

    try {
      const { connectors } = await connectorsList(bot)

      if (current()) {
        set(state => ({ byBot: { [bot]: connectors, ...state.byBot } }))
      }
    } catch {
      // The labels fall back to the first part of the tool name.
    }
  },

  async refresh(bot) {
    const current = connectionRead()
    const mine = ++latest
    set({ error: null, loading: true })

    try {
      const { connectors } = await connectorsList(bot)

      if (current()) {
        set(state => ({ byBot: { ...state.byBot, [bot]: connectors } }))
      }
    } catch (error) {
      if (current()) {
        set({ error: errorText(error) })
      }
    } finally {
      if (mine === latest) {
        set({ loading: false })
      }
    }
  },

  async refreshAll() {
    await Promise.all(Object.keys(get().byBot).map(bot => get().refresh(bot)))
  },

  async setup(input) {
    const current = connectionRead()
    const result = await connectorsSetup(input)

    if (current()) {
      await get().refresh(input.bot)
    }

    return result.test
  },

  async clear(bot, id, botOnly = false) {
    const current = connectionRead()
    await connectorsClear(id, { bot, bot_only: botOnly })

    if (current()) {
      await get().refresh(bot)
    }
  },

  async setForBot(bot, id, enabled) {
    const current = connectionRead()
    const { connector } = await connectorsSetForBot(id, bot, enabled)

    if (current()) {
      set(state => ({
        byBot: {
          ...state.byBot,
          [bot]: (state.byBot[bot] ?? []).map(item => (item.id === connector.id ? connector : item))
        }
      }))
    }
  },

  async addMcp(bot, input) {
    const current = connectionRead()
    await connectorsAddMcp({ ...input, bot })

    if (current()) {
      await get().refresh(bot)
    }
  },

  async removeMcp(bot, name) {
    const current = connectionRead()
    await connectorsRemoveMcp(name)

    if (current()) {
      await get().refresh(bot)
    }
  }
}))

export function connectorsActions(): ConnectorsState {
  return useConnectors.getState()
}

export function useConnectorsForBot(bot: null | string): Connector[] {
  return useConnectors(state => (bot ? (state.byBot[bot] ?? EMPTY) : EMPTY))
}

const EMPTY: Connector[] = []
