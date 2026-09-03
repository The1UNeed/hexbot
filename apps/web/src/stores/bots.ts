/**
 * Bots, keyed by name and ordered by `last_activity_at` (the daemon already
 * sorts `hexbot.bots.list`). Refreshed on `hexbot.bots.changed`.
 */

import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'

import { botsCreate, botsDelete, botsGet, botsList, botsUpdate } from '../lib/api'
import type { Bot, BotCreateInput, BotUpdatePatch, Section } from '../lib/types'

export interface BotsState {
  byName: Record<string, Bot>
  create: (input: BotCreateInput) => Promise<{ bot: Bot; section: Section }>
  error: null | string
  loaded: boolean
  loading: boolean
  order: string[]
  refresh: () => Promise<void>
  refreshOne: (name: string) => Promise<void>
  remove: (name: string) => Promise<void>
  update: (name: string, patch: BotUpdatePatch) => Promise<Bot>
}

function indexBots(bots: Bot[]): Pick<BotsState, 'byName' | 'order'> {
  const byName: Record<string, Bot> = {}

  for (const bot of bots) {
    byName[bot.name] = bot
  }

  return { byName, order: bots.map(bot => bot.name) }
}

export const useBots = create<BotsState>((set, get) => ({
  byName: {},
  error: null,
  loaded: false,
  loading: false,
  order: [],

  async refresh() {
    set({ error: null, loading: true })

    try {
      const result = await botsList()

      set({ ...indexBots(result.bots ?? []), loaded: true, loading: false })
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error), loading: false })
    }
  },

  async refreshOne(name) {
    try {
      const { bot } = await botsGet(name)

      set(state => ({
        byName: { ...state.byName, [bot.name]: bot },
        order: state.order.includes(bot.name) ? state.order : [bot.name, ...state.order]
      }))
    } catch {
      await get().refresh()
    }
  },

  async create(input) {
    const result = await botsCreate(input)

    await get().refresh()

    return result
  },

  async update(name, patch) {
    const { bot } = await botsUpdate(name, patch)

    set(state => ({ byName: { ...state.byName, [bot.name]: bot } }))

    return bot
  },

  async remove(name) {
    await botsDelete(name)
    set(state => {
      const byName = { ...state.byName }
      delete byName[name]

      return { byName, order: state.order.filter(item => item !== name) }
    })
  }
}))

export function botsActions(): BotsState {
  return useBots.getState()
}

export function selectBotList(state: BotsState): Bot[] {
  return state.order.map(name => state.byName[name]).filter((bot): bot is Bot => Boolean(bot))
}

export function useBotList(): Bot[] {
  return useBots(useShallow(selectBotList))
}

export function useBot(name: null | string): Bot | undefined {
  return useBots(state => (name ? state.byName[name] : undefined))
}
