/**
 * Each bot's own Discord app, by bot: loaded when its Discord tab opens and
 * refreshed on `hexbot.discord.changed` once loaded.
 */

import { create } from 'zustand'

import { discordConnect, discordDisconnect, discordGet, discordSetMode } from '../lib/api'
import type { DiscordMode, DiscordStatus } from '../lib/types'

export interface DiscordState {
  /** null: the bot has no Discord app. Missing: not loaded. */
  byBot: Record<string, DiscordStatus | null>
  errors: Record<string, string>
  connect: (bot: string, token: string) => Promise<void>
  /** How the bot acts in Discord; with a server, that server's own mode (null follows the default). */
  setMode: (bot: string, mode: DiscordMode | null, guildId?: string) => Promise<void>
  disconnect: (bot: string) => Promise<void>
  refresh: (bot: string) => Promise<void>
  /** Refresh the bots already loaded, or just `bot` when it is one of them. */
  refreshLoaded: (bot?: string) => Promise<void>
}

/** The latest read by bot, so an older answer arriving last is dropped. */
const reads: Record<string, number> = {}

export const useDiscord = create<DiscordState>((set, get) => ({
  byBot: {},
  errors: {},

  async refresh(bot) {
    const read = (reads[bot] = (reads[bot] ?? 0) + 1)

    try {
      const { discord } = await discordGet(bot)

      if (read !== reads[bot]) {
        return
      }

      const { [bot]: _cleared, ...errors } = get().errors

      set(state => ({ byBot: { ...state.byBot, [bot]: discord }, errors }))
    } catch (error) {
      if (read === reads[bot]) {
        set(state => ({
          errors: { ...state.errors, [bot]: error instanceof Error ? error.message : String(error) }
        }))
      }
    }
  },

  async refreshLoaded(bot) {
    const loaded = Object.keys({ ...get().byBot, ...get().errors })

    await Promise.all(loaded.filter(name => !bot || name === bot).map(name => get().refresh(name)))
  },

  async connect(bot, token) {
    reads[bot] = (reads[bot] ?? 0) + 1
    const { discord } = await discordConnect(bot, token)

    set(state => ({ byBot: { ...state.byBot, [bot]: discord } }))
  },

  async setMode(bot, mode, guildId) {
    reads[bot] = (reads[bot] ?? 0) + 1
    const { discord } = await discordSetMode(bot, mode, guildId)

    set(state => ({ byBot: { ...state.byBot, [bot]: discord } }))
  },

  async disconnect(bot) {
    reads[bot] = (reads[bot] ?? 0) + 1
    await discordDisconnect(bot)

    set(state => ({ byBot: { ...state.byBot, [bot]: null } }))
  }
}))
