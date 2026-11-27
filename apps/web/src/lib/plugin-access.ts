/**
 * Settings, Plugins as a table: every bot against every plugin, under the
 * account it comes from. Pure, over `hexbot.plugins.list` and the bots, so the
 * web app and the mobile app group, stage and apply changes the same way.
 */

import { ACCOUNT_NAMES, accountProvider, canGive, isConnected, shownBots } from './plugin-rows'
import type { AccountProvider, Bot, Plugin } from './types'

export const pluginKey = (plugin: Plugin) => `${plugin.kind}:${plugin.id}`

/** One bot having one plugin. A bot's handle holds no `|`, so the first one divides them. */
export const grantKey = (bot: string, key: string) => `${bot}|${key}`

export function splitGrant(grant: string): [bot: string, key: string] {
  const at = grant.indexOf('|')

  return [grant.slice(0, at), grant.slice(at + 1)]
}

/** A plugin as a column of the table. */
export interface AccessColumn {
  group: string
  key: string
  name: string
  plugin: Plugin
  /** Its sign-in stopped working: bots keep it, and nothing new is given until a new one. */
  waiting: boolean
}

/** A run of columns: one account's connectors, or the plugins of one kind that need none. */
export interface AccessGroup {
  account?: { email: null | string; provider: AccountProvider }
  columns: AccessColumn[]
  id: string
  name: string
  waiting: boolean
}

const KINDS = [
  ['connectors', 'Connectors'],
  ['servers', 'MCP servers'],
  ['skills', 'Skills']
] as const

/**
 * The table's columns. A plugin is one once it is set up or some bot holds
 * it; the ones still to connect are set up first. An account's connectors sit
 * together, so a second account of the same service is a second group.
 */
export function accessGroups(plugins: Plugin[]): AccessGroup[] {
  const accounts = new Map<string, AccessGroup>()

  const kinds = new Map<string, AccessGroup>(
    KINDS.map(([id, name]) => [id, { columns: [], id, name, waiting: false }])
  )

  for (const plugin of plugins) {
    if (plugin.disabled_globally || (!isConnected(plugin) && !shownBots(plugin).bots.length)) {
      continue
    }

    const account = plugin.kind === 'connector' ? plugin.connector?.account : null
    let group: AccessGroup

    if (account) {
      const provider = accountProvider(account)
      const id = `${provider}:${account.email ?? ''}`

      group = accounts.get(id) ?? {
        account: { email: account.email, provider },
        columns: [],
        id,
        name: account.email ?? ACCOUNT_NAMES[provider],
        waiting: false
      }

      accounts.set(id, group)
    } else {
      group = kinds.get(
        plugin.category === 'mcp' ? 'servers' : plugin.kind === 'connector' ? 'connectors' : 'skills'
      )!
    }

    const waiting = Boolean(account?.signed_in) && !plugin.ready

    group.columns.push({ group: group.id, key: pluginKey(plugin), name: plugin.name, plugin, waiting })
    group.waiting ||= waiting
  }

  return [...accounts.values(), ...kinds.values()].filter(group => group.columns.length)
}

/** One account's connectors, as the page that adds plugins offers them. */
export interface AccountOffer {
  /** Signed in and working. */
  connected: Plugin[]
  /** The addresses signed in so far. */
  emails: string[]
  /** Still to connect. */
  open: Plugin[]
  provider: AccountProvider
  /** Signed in with a sign-in that stopped working. */
  waiting: Plugin[]
}

/** What can still be added: an account's connectors, the other services, and what is switched off. */
export interface Offers {
  accounts: AccountOffer[]
  /** Off for every bot, so not a column until it is turned on again. */
  off: Plugin[]
  /** Connectors set up with a key, or in each bot's own settings, that are not set up yet. */
  services: Plugin[]
}

export function offersOf(plugins: Plugin[]): Offers {
  const accounts: AccountOffer[] = (['google', 'microsoft'] as const).map(provider => ({
    connected: [],
    emails: [],
    open: [],
    provider,
    waiting: []
  }))

  const services: Plugin[] = []

  for (const plugin of plugins) {
    const account = plugin.kind === 'connector' ? plugin.connector?.account : null

    if (account) {
      const offer = accounts.find(each => each.provider === accountProvider(account))!

      offer[!account.signed_in ? 'open' : plugin.ready ? 'connected' : 'waiting'].push(plugin)

      if (account.email && !offer.emails.includes(account.email)) {
        offer.emails.push(account.email)
      }
    } else if (plugin.kind === 'connector' && plugin.category !== 'mcp' && !isConnected(plugin)) {
      services.push(plugin)
    }
  }

  return {
    accounts: accounts.filter(offer => offer.connected.length + offer.open.length + offer.waiting.length),
    off: plugins.filter(plugin => plugin.disabled_globally),
    services
  }
}

/** The columns of an account that wait for a new sign-in, as connector ids. */
export const waitingIds = (group: AccessGroup): string[] =>
  group.columns.filter(column => column.waiting).map(column => column.plugin.id)

/** Grants the user asked for and has not applied yet: what each should be. */
export type Staged = Record<string, boolean>

/** The grants as they stand and as they will be once the staged ones apply. */
export interface Access {
  /** Whether the plugin can be given to the bot now. */
  canGive: (bot: string, key: string) => boolean
  /** Staged to become something it is not yet. */
  changed: (bot: string, key: string) => boolean
  /** Whether the bot has the plugin now. */
  has: (bot: string, key: string) => boolean
  /** Whether the bot has it once the staged changes apply. */
  value: (bot: string, key: string) => boolean
}

export function accessOf(plugins: Plugin[], staged: Staged): Access {
  const byKey = new Map(plugins.map(plugin => [pluginKey(plugin), plugin]))
  const holders = new Map(plugins.map(plugin => [pluginKey(plugin), new Set(shownBots(plugin).bots)]))
  const has = (bot: string, key: string) => holders.get(key)?.has(bot) ?? false

  return {
    canGive: (bot, key) => {
      const plugin = byKey.get(key)

      return Boolean(plugin) && canGive(plugin!, bot)
    },
    changed: (bot, key) => {
      const wanted = staged[grantKey(bot, key)]

      return wanted !== undefined && wanted !== has(bot, key)
    },
    has,
    value: (bot, key) => staged[grantKey(bot, key)] ?? has(bot, key)
  }
}

/**
 * Stages `on` for every bot and plugin given. A grant that is already so is
 * left out, and a plugin that cannot be given to a bot now is not staged for it.
 */
export function stage(
  staged: Staged,
  access: Access,
  bots: string[],
  keys: string[],
  on: boolean
): Staged {
  const next = { ...staged }

  for (const bot of bots) {
    for (const key of keys) {
      const grant = grantKey(bot, key)

      if (access.has(bot, key) === on) {
        delete next[grant]
      } else if (!on || access.canGive(bot, key)) {
        next[grant] = on
      }
    }
  }

  return next
}

/**
 * What pressing a cell for several bots does. All on, then all off; a cell
 * that began with only some of its bots comes back to that after both, so a
 * slip is undone by pressing on.
 */
export function cycle(staged: Staged, access: Access, bots: string[], key: string): Staged {
  const held = bots.filter(bot => access.value(bot, key)).length
  const began = bots.filter(bot => access.has(bot, key)).length
  const mixed = began > 0 && began < bots.length
  const touched = bots.some(bot => access.changed(bot, key))

  if (mixed && touched && held === 0) {
    const next = { ...staged }

    for (const bot of bots) {
      delete next[grantKey(bot, key)]
    }

    return next
  }

  const given = stage(staged, access, bots, [key], true)
  const more = bots.some(bot => (given[grantKey(bot, key)] ?? access.has(bot, key)) !== access.value(bot, key))

  // Nothing more can be given, as when the rest wait for setup: take it away instead.
  return held < bots.length && more ? given : stage(staged, access, bots, [key], false)
}

/** The staged grants that would change something. */
export function pending(staged: Staged, access: Access): Flip[] {
  return Object.entries(staged).flatMap(([grant, on]) => {
    const [bot, key] = splitGrant(grant)

    return access.has(bot, key) === on ? [] : [{ bot, key, on }]
  })
}

/** What a bot's profile calls its label. The primary bot stands alone. */
export const labelOf = (bot: Bot) => (bot.primary ? '' : (bot.title ?? '').trim())

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/**
 * The labels that group bots, each with its bots, the largest first. A label
 * only one bot carries describes that bot and groups nothing, so it is left out.
 */
export function labelsOf(bots: Bot[]): { bots: Bot[]; label: string }[] {
  const found: { bots: Bot[]; label: string }[] = []

  for (const bot of bots) {
    const label = labelOf(bot)

    if (!label) {
      continue
    }

    const entry = found.find(each => same(each.label, label))

    if (entry) {
      entry.bots.push(bot)
    } else {
      found.push({ bots: [bot], label })
    }
  }

  return found.filter(each => each.bots.length > 1).sort((a, b) => b.bots.length - a.bots.length)
}

/** The label a bot shares with others, in lower case, or nothing when it stands alone. */
export function sharedLabels(bots: Bot[]): (bot: Bot) => string {
  const shared = new Set(labelsOf(bots).map(each => each.label.toLowerCase()))

  return bot => {
    const label = labelOf(bot).toLowerCase()

    return shared.has(label) ? label : ''
  }
}

/** Bots that share a label and hold the same plugins, as one row. */
export interface AccessRow {
  bots: Bot[]
  id: string
  label: string
}

/**
 * Bots folded by the label they share and by what they hold among `keys`, in
 * the order they come. `shared` comes from `sharedLabels` over every bot, so a
 * filter does not change how rows fold.
 */
export function foldRows(
  bots: Bot[],
  keys: string[],
  has: (bot: string, key: string) => boolean,
  shared: (bot: Bot) => string = sharedLabels(bots)
): AccessRow[] {
  const rows = new Map<string, AccessRow>()

  for (const bot of bots) {
    const label = shared(bot)

    const id = bot.primary
      ? `bot:${bot.name}`
      : `${label}:${keys.filter(key => has(bot.name, key)).join(',')}`

    const row = rows.get(id)

    if (row) {
      row.bots.push(bot)
    } else {
      rows.set(id, { bots: [bot], id, label })
    }
  }

  return [...rows.values()]
}

/** "1 bot", "48 bots". */
export const count = (size: number, noun: string) => `${size} ${noun}${size === 1 ? '' : 's'}`

/** "Gmail, Calendar and Drive". */
export function listed(words: string[]): string {
  return words.length <= 1
    ? (words[0] ?? '')
    : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`
}

/** "72 Support bots", "Scout", "3 bots". */
export function groupName(bots: Bot[]): string {
  if (bots.length === 1) {
    return bots[0]!.display_name || bots[0]!.name
  }

  // "Sales" before "sales", when the bots write their label differently.
  const label = bots.map(labelOf).sort()[0]!

  return label && bots.every(bot => same(labelOf(bot), label))
    ? `${bots.length} ${label} bots`
    : `${bots.length} bots`
}

/** A plugin in words, with its account when another account could be meant. */
export function columnText(column: AccessColumn, groups: AccessGroup[]): string {
  const group = groups.find(each => each.id === column.group)

  const twins = groups.filter(
    each => each.account && each.columns.some(other => other.name === column.name)
  )

  return group?.account && twins.length > 1 ? `${column.name} from ${group.name}` : column.name
}

/** One grant to give or take away. */
export interface Flip {
  bot: string
  key: string
  on: boolean
}

/** Bots that all gain or all lose one plugin: one line of the review. */
export interface AccessChange {
  bots: Bot[]
  column: AccessColumn
  /** The bots had nothing from the plugin's account before. */
  fresh: boolean
  on: boolean
  /** The bots are a whole label. */
  whole: boolean
}

/** The staged changes as lines: one per plugin, direction and label. */
export function changesOf(
  flips: Flip[],
  access: Access,
  bots: Bot[],
  groups: AccessGroup[]
): AccessChange[] {
  const columns = new Map(groups.flatMap(group => group.columns.map(column => [column.key, column])))
  const byName = new Map(bots.map(bot => [bot.name, bot]))
  const labels = labelsOf(bots)
  const shared = sharedLabels(bots)
  const found = new Map<string, AccessChange>()

  for (const flip of flips) {
    const bot = byName.get(flip.bot)
    const column = columns.get(flip.key)

    if (!bot || !column) {
      continue
    }

    const id = `${flip.on}:${flip.key}:${bot.primary ? `bot:${bot.name}` : shared(bot)}`
    const change = found.get(id)

    if (change) {
      change.bots.push(bot)
    } else {
      found.set(id, { bots: [bot], column, fresh: false, on: flip.on, whole: false })
    }
  }

  for (const change of found.values()) {
    const label = shared(change.bots[0]!)
    const group = groups.find(each => each.id === change.column.group)

    change.whole =
      Boolean(label) &&
      change.bots.length > 1 &&
      change.bots.length === labels.find(each => same(each.label, label))?.bots.length

    change.fresh =
      change.on &&
      Boolean(group?.account) &&
      change.bots.every(bot => group!.columns.every(column => !access.has(bot.name, column.key)))
  }

  return [...found.values()]
}

/** "All 48 Sales bots", "12 Support bots", "Scout". */
export function changeWho(change: AccessChange): string {
  return change.whole
    ? `All ${change.bots.length} ${labelOf(change.bots[0]!)} bots`
    : groupName(change.bots)
}

/** One `hexbot.plugins.set_bots` call: the bots a plugin is given to afterwards. */
export interface AccessStep {
  bots: string[]
  flips: Flip[]
  /** Also keep grants still waiting for setup, which the table does not show. */
  keepWaiting: boolean
  plugin: Plugin
}

/** The calls that make `flips` so, one per plugin they touch. */
export function planOf(flips: Flip[], plugins: Plugin[]): AccessStep[] {
  const steps: AccessStep[] = []

  for (const plugin of plugins) {
    const mine = flips.filter(flip => flip.key === pluginKey(plugin))

    if (!mine.length) {
      continue
    }

    const shown = shownBots(plugin)
    const bots = new Set(shown.bots)

    for (const flip of mine) {
      if (flip.on) {
        bots.add(flip.bot)
      } else {
        bots.delete(flip.bot)
      }
    }

    steps.push({ bots: [...bots], flips: mine, keepWaiting: !shown.exact, plugin })
  }

  return steps
}

/** The same grants the other way round, to put back what an apply did. */
export const reversed = (flips: Flip[]): Flip[] => flips.map(flip => ({ ...flip, on: !flip.on }))

/** The plugins more than half of a label's bots hold: what is usual for the label. */
export function usual(
  label: string,
  bots: Bot[],
  keys: string[],
  has: (bot: string, key: string) => boolean
): string[] {
  const mine = bots.filter(bot => same(labelOf(bot), label))

  return keys.filter(key => mine.filter(bot => has(bot.name, key)).length * 2 > mine.length)
}
