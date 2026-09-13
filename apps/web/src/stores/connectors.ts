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

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

export interface ConnectorsState {
  addMcp: (bot: string, input: McpServerInput) => Promise<void>
  byBot: Record<string, Connector[]>
  clear: (bot: string, id: string, botOnly?: boolean) => Promise<void>
  error: null | string
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

  async refresh(bot) {
    set({ error: null, loading: true })

    try {
      const { connectors } = await connectorsList(bot)

      set(state => ({ byBot: { ...state.byBot, [bot]: connectors }, loading: false }))
    } catch (error) {
      set({ error: errorText(error), loading: false })
    }
  },

  async refreshAll() {
    await Promise.all(Object.keys(get().byBot).map(bot => get().refresh(bot)))
  },

  async setup(input) {
    const result = await connectorsSetup(input)

    await get().refresh(input.bot)

    return result.test
  },

  async clear(bot, id, botOnly = false) {
    await connectorsClear(id, { bot, bot_only: botOnly })
    await get().refresh(bot)
  },

  async setForBot(bot, id, enabled) {
    const { connector } = await connectorsSetForBot(id, bot, enabled)

    set(state => ({
      byBot: {
        ...state.byBot,
        [bot]: (state.byBot[bot] ?? []).map(item => (item.id === connector.id ? connector : item))
      }
    }))
  },

  async addMcp(bot, input) {
    await connectorsAddMcp(input)
    await get().refresh(bot)
  },

  async removeMcp(bot, name) {
    await connectorsRemoveMcp(name)
    await get().refresh(bot)
  }
}))

export function connectorsActions(): ConnectorsState {
  return useConnectors.getState()
}

export function useConnectorsForBot(bot: null | string): Connector[] {
  return useConnectors(state => (bot ? (state.byBot[bot] ?? EMPTY) : EMPTY))
}

const EMPTY: Connector[] = []
