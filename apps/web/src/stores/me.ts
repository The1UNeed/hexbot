import { create } from 'zustand'

import { usageSummary, usersMe, usersMeSet } from '../lib/api'
import type { CurrentUser } from '../lib/types'

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
  usageSupported: boolean | null
  refresh: () => Promise<void>
  rename: (displayName: string) => Promise<void>
}

export const useMe = create<MeState>(set => ({
  me: null,
  usageSupported: null,
  async refresh() {
    try {
      const me = await usersMe()
      let usageSupported = true

      try {
        await usageSummary()
      } catch (error) {
        usageSupported = !unknownMethod(error)
      }

      set({ me, usageSupported })
    } catch (error) {
      if (unknownMethod(error)) {
        set({ me: null, usageSupported: false })
      }
    }
  },
  async rename(displayName) {
    set({ me: await usersMeSet(displayName) })
  }
}))
