/**
 * Bots, keyed by name and ordered by `last_activity_at` (the daemon already
 * sorts `hexbot.bots.list`). Refreshed on `hexbot.bots.changed`.
 */

import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'

import { botsCreate, botsDelete, botsGet, botsList, botsPin, botsUpdate } from '../lib/api'
import { CatalogAuthority, type CatalogRead, type ReadOutcome } from '../lib/catalog-authority'
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
  pin: (name: string, pinned: boolean) => Promise<void>
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

/**
 * The list on its way, and the one that follows it. Every change elsewhere
 * asks for the whole list again; overlapping requests only queued up on the
 * daemon. A request while one runs is served by one list asked after it.
 */
let listing: null | Promise<void> = null
let following: null | Promise<void> = null

export const useBots = create<BotsState>((set, get) => {
  async function list() {
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
  }

  return {
    byName: {},
    answers: {},
    error: null,
    loaded: false,
    loading: false,
    order: [],

    reset() {
      authority.reset()
      listing = following = null
      set({ byName: {}, answers: {}, order: [], loaded: false, loading: false, error: null })
    },

    refresh() {
      if (listing) {
        // The list on its way was asked before this; the next one starts after it.
        following ??= listing.then(() => {
          following = null

          return get().refresh()
        })

        return following
      }

      const mine = list().finally(() => {
        if (listing === mine) {
          listing = null
        }
      })

      listing = mine

      return mine
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
        order: state.order.includes(result.bot.name)
          ? state.order
          : [result.bot.name, ...state.order]
      }))

      await get().refresh()

      return result
    },

    async update(name, patch) {
      const connected = connectionRead()
      // A new name shows at once; the rest of a patch waits for the daemon's bot.
      const shown = patch.display_name === undefined ? {} : { display_name: patch.display_name }
      const ticket = Object.keys(shown).length ? optimistic(name, shown) : authority.request()

      try {
        const { bot } = await botsUpdate(name, patch)

        if (!connected() || !authority.commit(name, ticket, 'present')) {
          return bot
        }

        set(state => ({
          answers: authority.outcomes(),
          byName: { ...state.byName, [bot.name]: bot }
        }))

        return bot
      } catch (error) {
        undo(name, ticket)
        throw error
      }
    },

    async pin(name, pinned) {
      const connected = connectionRead()
      const before = get().byName[name]?.pinned_at
      // Pinning again keeps the bot's place among the pinned, as the daemon does.
      const ticket = optimistic(name, { pinned_at: pinned ? (before ?? Date.now() / 1000) : null })

      try {
        const { bot } = await botsPin(name, pinned)

        if (!connected() || !authority.commit(name, ticket, 'present')) {
          return
        }

        set(state => ({
          answers: authority.outcomes(),
          byName: { ...state.byName, [bot.name]: bot }
        }))
      } catch (error) {
        undo(name, ticket)
        throw error
      }
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
  }
})

/** What each change shown early replaced, so a refused one can put it back. */
const shownBefore = new WeakMap<CatalogRead, Partial<Bot>>()

/**
 * Shows a change to a listed bot before the daemon answers, so a pin or a
 * rename lands at once. Older lists and replies can no longer overwrite it.
 */
function optimistic(name: string, patch: Partial<Bot>): CatalogRead {
  const bot = useBots.getState().byName[name]

  if (!bot) {
    return authority.request()
  }

  const ticket = authority.claim(name)
  shownBefore.set(
    ticket,
    Object.fromEntries(Object.keys(patch).map(key => [key, bot[key as keyof Bot]]))
  )
  useBots.setState(state => {
    const current = state.byName[name]

    return current ? { byName: { ...state.byName, [name]: { ...current, ...patch } } } : state
  })

  return ticket
}

/** The daemon refused the change: unless something newer came, the bot looks as before. */
function undo(name: string, ticket: CatalogRead) {
  const before = shownBefore.get(ticket)

  if (!before || !authority.current(name, ticket)) {
    return
  }

  useBots.setState(state => {
    const current = state.byName[name]

    return current ? { byName: { ...state.byName, [name]: { ...current, ...before } } } : state
  })
}

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
