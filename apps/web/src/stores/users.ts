import { create } from 'zustand'

import { usageSummary, usersList, usersMe } from '../lib/api'
import type { CurrentUser, User } from '../lib/types'

function unknownMethod(error: unknown): boolean {
  const value = error as { code?: number; message?: string }

  return (
    value?.code === -32601 ||
    /unknown method|method not found/i.test(value?.message ?? String(error))
  )
}

interface UsersState {
  current: CurrentUser | null
  users: User[]
  supported: boolean | null
  usageSupported: boolean | null
  refresh: () => Promise<void>
}

export const useUsers = create<UsersState>(set => ({
  current: null,
  users: [],
  supported: null,
  usageSupported: null,
  async refresh() {
    try {
      const current = await usersMe()
      const result = current.role === 'admin' ? await usersList() : { users: [] }
      let usageSupported = true

      try {
        await usageSummary()
      } catch (error) {
        usageSupported = !unknownMethod(error)
      }

      set({ current, supported: true, usageSupported, users: result.users ?? [] })
    } catch (error) {
      if (unknownMethod(error)) {
        set({ current: null, supported: false, usageSupported: false, users: [] })
      }
    }
  }
}))
