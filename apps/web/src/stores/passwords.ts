/**
 * Settings, Passwords: the logins saved for the user's bots, without their
 * passwords. Refreshed when the page opens and on `hexbot.passwords.changed`,
 * which every change sends, a bot's sign-in card included.
 */

import { create } from 'zustand'

import {
  type PasswordInput,
  passwordsDelete,
  passwordsList,
  passwordsSave,
  passwordsSetBots
} from '../lib/api'
import type { PasswordKeyStore, PasswordLogin } from '../lib/types'

import { connectionRead } from './connection'

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

export interface PasswordsState {
  error: null | string
  /** True once the page has asked for the list; events refresh only then. */
  loaded: boolean
  loading: boolean
  logins: PasswordLogin[]
  refresh: () => Promise<void>
  remove: (id: string) => Promise<void>
  /** Forget everything: another daemon has other passwords. */
  reset: () => void
  save: (input: PasswordInput) => Promise<PasswordLogin>
  setBots: (id: string, bots: null | string[]) => Promise<void>
  store: PasswordKeyStore
}

/** Only the latest refresh may change the list or end the loading state. */
let latest = 0

export const usePasswords = create<PasswordsState>((set, get) => {
  const put = (login: PasswordLogin) =>
    set(state => {
      const rest = state.logins.filter(item => item.id !== login.id)

      return {
        logins: [...rest, login].sort((a, b) =>
          a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })
        )
      }
    })

  return {
    error: null,
    loaded: false,
    loading: false,
    logins: [],
    store: null,

    async refresh() {
      const current = connectionRead()
      const mine = ++latest
      set({ error: null, loaded: true, loading: true })

      try {
        const list = await passwordsList()

        if (current() && mine === latest) {
          set({ logins: list.logins, store: list.store })
        }
      } catch (error) {
        if (current() && mine === latest) {
          set({ error: errorText(error) })
        }
      } finally {
        if (mine === latest) {
          set({ loading: false })
        }
      }
    },

    async remove(id) {
      await passwordsDelete(id)
      set(state => ({ logins: state.logins.filter(item => item.id !== id) }))
    },

    reset() {
      latest++
      set({ error: null, loaded: false, loading: false, logins: [], store: null })
    },

    async save(input) {
      const { login } = await passwordsSave(input)
      put(login)

      if (!get().store) {
        void get().refresh()
      }

      return login
    },

    async setBots(id, bots) {
      const { login } = await passwordsSetBots(id, bots)
      put(login)
    }
  }
})

export function refreshPasswordsIfLoaded(): void {
  if (usePasswords.getState().loaded) {
    void usePasswords.getState().refresh()
  }
}
