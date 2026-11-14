/**
 * Where bots work (`hexbot.computers.*`): the user's choice, every computer
 * with the bots allowed on it, and each open bot's own list with its active
 * computer. `hexbot.computers.changed` reloads what is loaded.
 */

import { create } from 'zustand'

import { computersConfigure, computersForBot, computersList, computersUse } from '../lib/api'
import type { ComputerChoice, ComputerInfo, ComputersList } from '../lib/types'

import { useConnection } from './connection'

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

export interface ComputersStoreState {
  /** Allow or stop one bot on one computer. */
  allow: (computer: string, bot: string, allowed: boolean) => Promise<void>
  /** Let one bot see and use a computer's screen, the daemon's or a lent one's, or stop it. */
  allowScreen: (computer: string, bot: string, screen: boolean) => Promise<void>
  /** Each bot's computers, once something showed them. */
  byBot: Record<string, ComputerInfo[]>
  choose: (choice: ComputerChoice) => Promise<void>
  error: null | string
  list: ComputersList | null
  /** Reload what is loaded, after a change anywhere. */
  reload: () => Promise<void>
  refresh: () => Promise<void>
  refreshBot: (bot: string) => Promise<void>
  /** Switch the computer a bot uses when it names none. */
  pick: (bot: string, computer: string) => Promise<void>
}

export const useComputers = create<ComputersStoreState>((set, get) => {
  // An answer from a daemon the app has since left describes other computers.
  const guard = async <T>(request: () => Promise<T>, apply: (result: T) => void) => {
    const target = useConnection.getState().target

    try {
      set({ error: null })
      const result = await request()

      if (useConnection.getState().target === target) {
        apply(result)
      }
    } catch (error) {
      set({ error: message(error) })
    }
  }

  const setBot = (bot: string, computers: ComputerInfo[]) =>
    set(state => ({ byBot: { ...state.byBot, [bot]: computers } }))

  return {
    async allow(computer, bot, allowed) {
      await guard(
        () => computersConfigure({ allowed, bot, computer }),
        list => set({ list })
      )
      await get().refreshBot(bot)
    },
    async allowScreen(computer, bot, screen) {
      await guard(
        () => computersConfigure({ bot, computer, screen }),
        list => set({ list })
      )
      await get().refreshBot(bot)
    },
    byBot: {},
    async choose(choice) {
      await guard(
        () => computersConfigure({ choice }),
        list => set({ list })
      )
      await get().reload()
    },
    error: null,
    list: null,
    async refresh() {
      await guard(computersList, list => set({ list }))
    },
    async refreshBot(bot) {
      await guard(
        () => computersForBot(bot),
        result => setBot(bot, result.computers)
      )
    },
    async reload() {
      const { byBot, list } = get()
      await Promise.all([
        list ? get().refresh() : null,
        ...Object.keys(byBot).map(bot => get().refreshBot(bot))
      ])
    },
    async pick(bot, computer) {
      // Show the switch at once; the answer confirms it.
      const before = get().byBot[bot]

      if (before) {
        setBot(
          bot,
          before.map(item => ({ ...item, active: item.id === computer }))
        )
      }

      await guard(
        () => computersUse(bot, computer),
        result => setBot(bot, result.computers)
      )

      if (get().error && before) {
        setBot(bot, before)
      }
    }
  }
})

/** How a computer is named in a picker: the bots' computer, or the user's by its name. */
export function computerTitle(computer: ComputerInfo): string {
  return computer.kind === 'bots' ? "Bots' computer" : computer.name
}
