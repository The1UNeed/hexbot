import { create } from 'zustand'

import { usageSummary, usersMe, usersMeSet } from '../lib/api'
import type { CurrentUser } from '../lib/types'

import { connectionRead } from './connection'

export function unknownMethod(error: unknown): boolean {
  const value = error as { code?: number; message?: string }

  return (
    value?.code === -32601 ||
    /unknown method|method not found/i.test(value?.message ?? String(error))
  )
}

interface MeState {
  /** You, the person this daemon belongs to. */
  me: CurrentUser | null
  /** The daemon answered, with you or without. */
  loaded: boolean
  usageSupported: boolean | null
  refresh: () => Promise<void>
  rename: (displayName: string) => Promise<void>
}

export const useMe = create<MeState>(set => ({
  me: null,
  loaded: false,
  usageSupported: null,
  async refresh() {
    const current = connectionRead()

    try {
      const me = await usersMe()

      if (current()) {
        set({ loaded: true, me })
      }

      let usageSupported = true

      try {
        await usageSummary()
      } catch (error) {
        usageSupported = !unknownMethod(error)
      }

      if (current()) {
        set({ usageSupported })
      }
    } catch (error) {
      if (!current()) {
        return
      }

      if (unknownMethod(error)) {
        set({ loaded: true, me: null, usageSupported: false })
      } else {
        set({ loaded: true })
      }
    }
  },
  async rename(displayName) {
    const current = connectionRead()
    const me = await usersMeSet(displayName)

    if (current()) {
      set({ me })
    }
  }
}))
