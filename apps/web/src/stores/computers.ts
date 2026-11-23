/**
 * Every computer bots can use and the bots on each (`machines.rs`). Loaded
 * when Settings, Computers or onboarding shows it; `hexbot.computers.changed`
 * keeps it current as computers come online, go away, or change bots.
 */

import { create } from 'zustand'

import {
  computersForget,
  computersGrant,
  computersList,
  computersRemoveApp,
  computersSet,
  unknownMethod
} from '../lib/api'
import type { Computer } from '../lib/types'

import { useConnection } from './connection'

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

export interface ComputersState {
  computers: Computer[] | null
  /** Clears one notice once the user has read it. */
  dismissNotice: (notice: string) => void
  error: null | string
  /**
   * What actions left the user to do, such as stopping bots on a computer
   * that didn't confirm, oldest first: each kept until its own OK, so a later
   * Forget never replaces or clears an unread one.
   */
  notices: string[]
  /** The daemon is from before computers: it has no list, and a bot's tools say what it uses. */
  older: boolean
  /**
   * The connection (`connects`) whose list, or whose answer that it has none,
   * is here; null until one answers. A list kept from an earlier connection
   * may name grants changed since, so a bot's Computer tab waits for its own.
   */
  answered: null | number
  /** Why this connection's list failed, apart from what Settings actions report in `error`. */
  listFailed: { connects: number; message: string } | null
  forget: (computer: string) => Promise<void>
  grant: (
    computer: string,
    capability: 'terminal',
    bot: string,
    on: boolean
  ) => Promise<void>
  refresh: () => Promise<void>
  /** Refresh only when something already showed the list. */
  refreshLoaded: () => Promise<void>
  removeApp: (computer: string, bot: string, app: string) => Promise<void>
  set: (computer: 'host' | 'vm', change: { desktop?: boolean; on?: boolean }) => Promise<void>
}

export const useComputers = create<ComputersState>((set, get) => {
  // Each read's number; an answer to any but the latest is dropped.
  let latest = 0
  // Reads on their way: a change during the first read starts a newer one.
  let reading = 0

  const run = async (request: () => Promise<unknown>) => {
    const target = useConnection.getState().target

    try {
      set({ error: null })
      await request()

      if (useConnection.getState().target === target) {
        await get().refresh()
      }
    } catch (error) {
      // A failure from a daemon the app has since left isn't this one's.
      if (useConnection.getState().target === target) {
        set({ error: message(error) })
      }
    }
  }

  return {
    computers: null,
    error: null,
    dismissNotice: notice =>
      set(state => ({ notices: state.notices.filter(other => other !== notice) })),
    // An app that didn't confirm bots stopped there: say what to do, until read.
    forget: computer =>
      run(async () => {
        const target = useConnection.getState().target
        const result = await computersForget(computer)

        const note = result.note

        if (note && useConnection.getState().target === target) {
          set(state => ({
            notices: state.notices.includes(note) ? state.notices : [...state.notices, note]
          }))
        }
      }),
    notices: [],
    older: false,
    answered: null,
    listFailed: null,
    grant: (computer, capability, bot, on) =>
      run(() => computersGrant(computer, capability, bot, on)),
    async refresh() {
      const { connects, target } = useConnection.getState()
      const mine = ++latest
      // An answer from a daemon the app has since left describes other
      // computers, and one overtaken by a newer read may name a grant since
      // taken back: only the latest read of this daemon counts.
      const current = () => useConnection.getState().target === target && mine === latest

      reading++
      set({ listFailed: null })

      try {
        const { computers } = await computersList()

        if (current()) {
          set({ answered: connects, computers, error: null, listFailed: null, older: false })
        }
      } catch (error) {
        if (!current()) {
          return
        }

        // Settings still says why. Only a daemon without the method is older;
        // any other failure leaves a bot's Computer tab waiting, with the error.
        const older = unknownMethod(error)

        set({
          answered: older ? connects : null,
          // A daemon from before computers has none: a list kept from before
          // it was rolled back would name grants it can't honour.
          ...(older ? { computers: null } : {}),
          error: message(error),
          listFailed: older ? null : { connects, message: message(error) },
          older
        })
      } finally {
        reading--
      }
    },
    // A list that failed, or is on its way, is read again too, so a change
    // can mend it and an answer that predates the change is overtaken.
    async refreshLoaded() {
      if (get().computers || get().listFailed || reading > 0) {
        await get().refresh()
      }
    },
    removeApp: (computer, bot, app) => run(() => computersRemoveApp(computer, bot, app)),
    set: (computer, change) => run(() => computersSet(computer, change))
  }
})
