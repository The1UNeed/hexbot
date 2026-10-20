/**
 * The primary bot's check-ins: settings live in `useSettings`; this holds
 * what the daemon reports. Refreshed on `hexbot.checkins.changed` once loaded.
 */

import { create } from 'zustand'

import { checkinsCancelWakeup, checkinsRunNow, checkinsStatus, sectionsDelete } from '../lib/api'
import type { CheckinStatus } from '../lib/types'

export interface CheckinsState {
  cancel: (id: string) => Promise<void>
  /** Delete the Check-ins conversation and what check-ins said there. */
  deleteSection: () => Promise<void>
  error: null | string
  loaded: boolean
  refresh: () => Promise<void>
  runNow: () => Promise<void>
  status: CheckinStatus | null
}

export const useCheckins = create<CheckinsState>((set, get) => ({
  error: null,
  loaded: false,
  status: null,

  async refresh() {
    try {
      set({ error: null, loaded: true, status: await checkinsStatus() })
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error), loaded: true })
    }
  },

  async runNow() {
    await checkinsRunNow()
    await get().refresh()
  },

  async deleteSection() {
    const id = get().status?.section_id

    if (id) {
      await sectionsDelete(id)
    }

    await get().refresh()
  },

  async cancel(id) {
    await checkinsCancelWakeup(id)
    await get().refresh()
  }
}))
