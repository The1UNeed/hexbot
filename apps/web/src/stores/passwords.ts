/**
 * Settings, Passwords: the logins, SSH keys and API keys saved for the
 * user's bots, without their secrets. Refreshed when the page opens and on
 * `hexbot.passwords.changed`, which every change sends, a bot's card included.
 */

import { create } from 'zustand'

import {
  type PasswordInput,
  passwordsConnect,
  passwordsDelete,
  passwordsDisconnect,
  passwordsList,
  passwordsSave,
  passwordsSetBots,
  type VaultwardenInput
} from '../lib/api'
import type { PasswordItem, PasswordKeyStore, PasswordVault } from '../lib/types'

import { connectionRead } from './connection'

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

export interface PasswordsState {
  /** Signs in to a Vaultwarden, which then keeps every item; says how many were copied. */
  connect: (input: VaultwardenInput) => Promise<number>
  /** Goes back to the vault on the daemon. */
  disconnect: () => Promise<void>
  error: null | string
  /** True once the page has asked for the list; events refresh only then. */
  loaded: boolean
  loading: boolean
  logins: PasswordItem[]
  refresh: () => Promise<void>
  remove: (id: string) => Promise<void>
  /** Forget everything: another daemon has other passwords. */
  reset: () => void
  save: (input: PasswordInput) => Promise<PasswordItem>
  setBots: (id: string, bots: null | string[]) => Promise<void>
  store: PasswordKeyStore
  vault: PasswordVault
}

/** Only the latest refresh may change the list or end the loading state. */
let latest = 0

export const usePasswords = create<PasswordsState>((set, get) => {
  const put = (login: PasswordItem) =>
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
    vault: { kind: 'local' },

    // The page names the new store at once; the list follows when it loads.
    async connect(input) {
      const { copied, vault } = await passwordsConnect(input)
      set({ vault })
      await get().refresh()

      return copied
    },

    async disconnect() {
      const { vault } = await passwordsDisconnect()
      set({ vault })
      await get().refresh()
    },

    async refresh() {
      const current = connectionRead()
      const mine = ++latest
      set({ error: null, loaded: true, loading: true })

      try {
        const list = await passwordsList()

        if (current() && mine === latest) {
          set({
            error: list.error ?? null,
            logins: list.logins,
            store: list.store,
            vault: list.vault ?? { kind: 'local' }
          })
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
      set({
        error: null,
        loaded: false,
        loading: false,
        logins: [],
        store: null,
        vault: { kind: 'local' }
      })
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
