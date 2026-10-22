/**
 * Bots, keyed by name and ordered by `last_activity_at` (the daemon already
 * sorts `hexbot.bots.list`). Refreshed on `hexbot.bots.changed`.
 */

import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'

import { botsCreate, botsDelete, botsGet, botsList, botsUpdate } from '../lib/api'
import { CatalogAuthority, type ReadOutcome } from '../lib/catalog-authority'
import type { Bot, BotCreateInput, BotUpdatePatch, Section } from '../lib/types'

import { connectionRead } from './connection'
import { uiActions } from './ui'

export interface BotsState {
  byName: Record<string, Bot>
  answers: Record<string, ReadOutcome>
  create: (input: BotCreateInput) => Promise<{ bot: Bot; section: Section }>
  error: null | string
  loaded: boolean
  loading: boolean
  order: string[]
  reset: () => void
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

const authority = new CatalogAuthority()

export function botCacheRead(): (id: string) => boolean {
  const connected = connectionRead()
  const current = authority.cacheRead()

  return id => connected() && current(id)
}

export const useBots = create<BotsState>((set, get) => ({
  byName: {},
  answers: {},
  error: null,
  loaded: false,
  loading: false,
  order: [],

  reset() {
    authority.reset()
    set({ byName: {}, answers: {}, order: [], loaded: false, loading: false, error: null })
  },

  async refresh() {
    const current = connectionRead()
    const ticket = authority.request()
    set({ error: null, loading: true })

    try {
      const result = await botsList()

      if (!current()) {
        return
      }

      const listed = authority.list(ticket, result.bots ?? [], get().byName, bot => bot.name)

      if (listed) {
        set({ ...indexBots(listed), answers: authority.outcomes(), loaded: true, loading: false })
      }
    } catch (error) {
      if (!current()) {
        return
      }

      set({ error: error instanceof Error ? error.message : String(error), loading: false })
    }
  },

  async refreshOne(name) {
    const current = connectionRead()
    const ticket = authority.read(name)
    set({ answers: authority.outcomes() })

    try {
      const { bot } = await botsGet(name)

      if (!current() || !authority.finish(name, ticket, 'present')) {
        return
      }

      set(state => ({
        answers: authority.outcomes(),
        byName: { ...state.byName, [bot.name]: bot },
        order: state.order.includes(bot.name) ? state.order : [bot.name, ...state.order]
      }))
    } catch {
      if (!current() || !authority.current(name, ticket)) {
        return
      }

      await get().refresh()
    }
  },

  async create(input) {
    const connected = connectionRead()
    const ticket = authority.request()
    const result = await botsCreate(input)

    if (!connected() || !authority.commit(result.bot.name, ticket, 'present')) {
      return result
    }

    set(state => ({
      answers: authority.outcomes(),
      byName: { ...state.byName, [result.bot.name]: result.bot },
      order: state.order.includes(result.bot.name) ? state.order : [result.bot.name, ...state.order]
    }))

    await get().refresh()

    return result
  },

  async update(name, patch) {
    const connected = connectionRead()
    const ticket = authority.request()
    const { bot } = await botsUpdate(name, patch)

    if (!connected() || !authority.commit(name, ticket, 'present')) {
      return bot
    }

    set(state => ({ answers: authority.outcomes(), byName: { ...state.byName, [bot.name]: bot } }))

    return bot
  },

  async remove(name) {
    const connected = connectionRead()
    const ticket = authority.request()
    await botsDelete(name)

    if (!connected() || !authority.commit(name, ticket, 'gone')) {
      return
    }

    // `/` reopens the last section; one of this bot's would show a bot that is gone.
    if (uiActions().lastSection?.bot === name) {
      uiActions().setLastSection(null)
    }

    set(state => {
      const byName = { ...state.byName }
      delete byName[name]

      return {
        byName,
        answers: authority.outcomes(),
        order: state.order.filter(item => item !== name)
      }
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

/** Only a current network outcome can establish absence for a deep link. */
export function botMissing(state: BotsState, name: string): boolean {
  return state.loaded && !state.byName[name] && state.answers[name] !== 'discarded'
}
