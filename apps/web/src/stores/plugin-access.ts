/**
 * Settings, Plugins as a table: the changes that wait for review, the last
 * ones applied (for Undo), and what the page has open. The grants themselves
 * stay in the plugins store; applying sends one `hexbot.plugins.set_bots` per
 * plugin and reads the list again.
 */

import { create } from 'zustand'

import { pluginsSetBots } from '../lib/api'
import { type Flip, grantKey, notUndone, planOf, reversed, type Staged } from '../lib/plugin-access'
import { withWaiting } from '../lib/plugin-rows'
import type { AccountProvider, Plugin, PluginKind } from '../lib/types'

import { connectionRead, useConnection } from './connection'
import { usePlugins } from './plugins'

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Where the page that adds a plugin stands. */
export type AddStep =
  /** Choosing what to add. */
  | { at: 'pick'; query?: string }
  /** Choosing which of an account's connectors to connect. */
  | { at: 'services'; chosen?: string[]; provider: AccountProvider }
  /** Signing in for them; `again` renews a sign-in that stopped working. */
  | { again: boolean; at: 'sign-in'; provider: AccountProvider; services: string[] }
  | { at: 'server' }
  | { at: 'skill' }
  /** Choosing the bots that get what was just connected; `everyone` when every bot has it already. */
  | { at: 'give'; everyone?: boolean; keys: string[]; note?: string }

export interface PluginAccessState {
  /** The page that adds a plugin, while it is open. */
  adding: AddStep | null
  /** Sends `flips`, the staged changes as reviewed. What a plugin refuses stays staged, with the reason in `error`. */
  apply: (text: string, flips: Flip[]) => Promise<void>
  /** The bot whose page is open. */
  bot: null | string
  busy: boolean
  discard: () => void
  error: null | string
  /** Columns that just arrived: brought into view and lit for a moment. */
  arrived: string[]
  /** What the last apply changed, so Undo puts back exactly that. */
  last: { flips: Flip[]; text: string } | null
  /**
   * The grants as they were before the last apply. Rows stay grouped by them,
   * so a row does not move from under the pointer; `regroup` lets them go.
   */
  pinned: null | Plugin[]
  regroup: () => void
  /** Forget everything: another daemon has other plugins and bots. */
  reset: () => void
  reviewing: boolean
  setAdding: (adding: AddStep | null) => void
  setBot: (bot: null | string) => void
  setArrived: (arrived: string[]) => void
  setReviewing: (reviewing: boolean) => void
  /** Opens a plugin's own window: its connection, its test, its skills. */
  setSheet: (sheet: null | string) => void
  setStaged: (staged: Staged) => void
  /** The plugin whose window is open, as a column key. */
  sheet: null | string
  staged: Staged
  undo: () => Promise<void>
}

/** Sends `flips` plugin by plugin; returns the ones the daemon took and why others failed. */
async function send(flips: Flip[], plugins: Plugin[]): Promise<{ done: Flip[]; failed: string[] }> {
  const done: Flip[] = []
  const failed: string[] = []

  for (const step of planOf(flips, plugins)) {
    try {
      await pluginsSetBots(
        step.plugin.kind as PluginKind,
        step.plugin.id,
        step.keepWaiting ? withWaiting(step.plugin, step.bots) : step.bots
      )
      done.push(...step.flips)
    } catch (error) {
      failed.push(`${step.plugin.name}: ${errorText(error)}`)
    }
  }

  return { done, failed }
}

export const usePluginAccess = create<PluginAccessState>((set, get) => ({
  adding: null,
  bot: null,
  busy: false,
  error: null,
  arrived: [],
  last: null,
  pinned: null,
  reviewing: false,
  sheet: null,
  staged: {},

  async apply(text, flips) {
    const current = connectionRead()
    const plugins = usePlugins.getState().plugins

    if (!flips.length || get().busy) {
      return
    }

    set({ busy: true, error: null })

    const { done, failed } = await send(flips, plugins)

    await usePlugins.getState().refresh()

    if (!current()) {
      set({ busy: false })

      return
    }

    // What a plugin refused stays staged, so nothing asked for is lost.
    const left = flips.filter(flip => !done.includes(flip))

    set(state => ({
      busy: false,
      error: failed.length ? failed.join(' ') : null,
      last: done.length ? { flips: done, text: failed.length ? 'some of the changes' : text } : null,
      pinned: state.pinned ?? plugins,
      reviewing: false,
      staged: Object.fromEntries(left.map(flip => [grantKey(flip.bot, flip.key), flip.on]))
    }))
  },

  discard() {
    set({ error: null, staged: {} })
  },

  regroup() {
    set({ pinned: null })
  },

  reset() {
    set({
      adding: null,
      bot: null,
      busy: false,
      error: null,
      arrived: [],
      last: null,
      pinned: null,
      reviewing: false,
      sheet: null,
      staged: {}
    })
  },

  setAdding(adding) {
    set({ adding })
  },

  setBot(bot) {
    set({ bot })
  },

  setArrived(arrived) {
    set({ arrived })
  },

  setReviewing(reviewing) {
    set({ reviewing })
  },

  setSheet(sheet) {
    set({ sheet })
  },

  setStaged(staged) {
    set({ error: null, staged })
  },

  async undo() {
    const last = get().last

    if (!last || get().busy) {
      return
    }

    const current = connectionRead()

    set({ busy: true, error: null })

    const { done, failed } = await send(reversed(last.flips), usePlugins.getState().plugins)

    await usePlugins.getState().refresh()

    // What a plugin refused to put back keeps its Undo, to try again.
    const left = notUndone(last.flips, done)

    set(
      current()
        ? {
            busy: false,
            error: failed.length ? failed.join(' ') : null,
            last: left.length ? { ...last, flips: left } : null
          }
        : { busy: false }
    )
  }
}))

// Another daemon has other plugins and bots: what waits for one is never
// applied to another, whether or not the page is open when it changes.
useConnection.subscribe((next, previous) => {
  if (next.target !== previous.target || next.epoch !== previous.epoch) {
    usePluginAccess.getState().reset()
  }
})
