/** What the plugins table and its parts read: the bots, the columns, and the grants with the staged ones. */

import { useCallback, useMemo } from 'react'

import {
  type Access,
  type AccessColumn,
  type AccessGroup,
  accessGroups,
  accessOf,
  cycle,
  type Flip,
  pending,
  stage
} from '../../../lib/plugin-access'
import type { Bot, Plugin } from '../../../lib/types'
import { useBots } from '../../../stores/bots'
import { usePluginAccess } from '../../../stores/plugin-access'
import { usePlugins } from '../../../stores/plugins'

export interface AccessData {
  access: Access
  bots: Bot[]
  /** The colour that follows an account through the table; plugins without one take the text colour. */
  colorOf: (group: string) => string
  columns: AccessColumn[]
  /** The staged grants that would change something. */
  flips: Flip[]
  /** Stages `on` for every bot and plugin given. */
  give: (bots: string[], keys: string[], on: boolean) => void
  groups: AccessGroup[]
  plugins: Plugin[]
  /** What pressing a cell does: on, off, and back to where a mixed cell began. */
  press: (bots: string[], key: string) => void
  /** Drops what is staged for these bots and plugins. */
  unstage: (bots: string[], keys: string[]) => void
}

const CHART = 6

export function useAccessData(): AccessData {
  const byName = useBots(state => state.byName)
  const order = useBots(state => state.order)
  const plugins = usePlugins(state => state.plugins)
  const staged = usePluginAccess(state => state.staged)
  const setStaged = usePluginAccess(state => state.setStaged)

  // The primary bot first, then the others as the chat list orders them.
  const bots = useMemo(
    () =>
      order
        .map(name => byName[name])
        .filter(bot => bot !== undefined)
        .sort((a, b) => Number(Boolean(b.primary)) - Number(Boolean(a.primary)))
        .map(bot => ({ ...bot, display_name: bot.display_name || bot.name })),
    [byName, order]
  )

  const groups = useMemo(() => accessGroups(plugins), [plugins])
  const columns = useMemo(() => groups.flatMap(group => group.columns), [groups])
  const access = useMemo(() => accessOf(plugins, staged), [plugins, staged])
  const flips = useMemo(() => pending(staged, access), [access, staged])

  const colorOf = useCallback(
    (group: string) => {
      const at = groups.filter(each => each.account).findIndex(each => each.id === group)

      return at < 0 ? 'var(--hex-text)' : `var(--hex-chart-${(at % CHART) + 1})`
    },
    [groups]
  )

  const give = useCallback(
    (names: string[], keys: string[], on: boolean) =>
      setStaged(stage(usePluginAccess.getState().staged, access, names, keys, on)),
    [access, setStaged]
  )

  const press = useCallback(
    (names: string[], key: string) =>
      setStaged(cycle(usePluginAccess.getState().staged, access, names, key)),
    [access, setStaged]
  )

  const unstage = useCallback(
    (names: string[], keys: string[]) => {
      const next = { ...usePluginAccess.getState().staged }

      for (const name of names) {
        for (const key of keys) {
          delete next[`${name}|${key}`]
        }
      }

      setStaged(next)
    },
    [setStaged]
  )

  return { access, bots, colorOf, columns, flips, give, groups, plugins, press, unstage }
}
