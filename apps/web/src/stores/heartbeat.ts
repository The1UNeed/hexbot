/**
 * Each bot's heartbeat, by bot: what the daemon reports, loaded when a
 * Heartbeat tab opens. Refreshed on `hexbot.heartbeat.changed` once loaded.
 */

import { create } from 'zustand'

import { heartbeatRunNow, heartbeatSet, heartbeatStatus, sectionsDelete } from '../lib/api'
import type { HeartbeatStatus } from '../lib/types'

import { sectionsActions, useSections } from './sections'
import { useTranscripts } from './transcripts'

export interface HeartbeatState {
  byBot: Record<string, HeartbeatStatus>
  errors: Record<string, string>
  /** Delete the Check-ins conversation from before the heartbeat. */
  deleteEarlier: (bot: string) => Promise<void>
  refresh: (bot: string) => Promise<void>
  /** Refresh the bots already loaded, or just `bot` when it is one of them. */
  refreshLoaded: (bot?: string) => Promise<void>
  runNow: (bot: string) => Promise<void>
  save: (bot: string, text: string) => Promise<void>
}

export const useHeartbeat = create<HeartbeatState>((set, get) => ({
  byBot: {},
  errors: {},

  async refresh(bot) {
    try {
      const status = await heartbeatStatus(bot)
      const { [bot]: _cleared, ...errors } = get().errors

      set(state => ({ byBot: { ...state.byBot, [bot]: status }, errors }))
    } catch (error) {
      set(state => ({
        errors: {
          ...state.errors,
          [bot]: error instanceof Error ? error.message : String(error)
        }
      }))
    }
  },

  async refreshLoaded(bot) {
    const loaded = Object.keys({ ...get().byBot, ...get().errors })

    await Promise.all(loaded.filter(name => !bot || name === bot).map(name => get().refresh(name)))
  },

  async save(bot, text) {
    const status = await heartbeatSet(bot, text)

    set(state => ({ byBot: { ...state.byBot, [bot]: status } }))
  },

  async runNow(bot) {
    await heartbeatRunNow(bot)
    await get().refresh(bot)
  },

  async deleteEarlier(bot) {
    const id = get().byBot[bot]?.earlier_checkins

    if (id) {
      const live =
        useSections.getState().liveSessionId[id] ?? useSections.getState().byId[id]?.live_session_id

      await sectionsDelete(id)

      // Its transcript and listing go with it.
      if (live) {
        useTranscripts.getState().drop(live)
      }

      useSections.setState(state => {
        const { [id]: _deleted, ...liveSessionId } = state.liveSessionId

        return { liveSessionId }
      })

      await sectionsActions().refresh()
    }

    await get().refresh(bot)
  }
}))
