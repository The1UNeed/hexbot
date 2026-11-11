/**
 * `hexbot.plugins.list` as one list of rows, whatever their kind. Pure, so
 * the mobile app reads the plugin list the same way.
 */

import { serverIcon, skillIcon } from './plugin-icons'
import type {
  AccountProvider,
  ConnectorAccount,
  Plugin,
  PluginsList,
  SkillRequirement
} from './types'

/** Google or Microsoft, as people call the account. */
export const ACCOUNT_NAMES: Record<AccountProvider, string> = {
  google: 'Google',
  microsoft: 'Microsoft'
}

/**
 * The account a connector signs in to. A daemon from before each service
 * had its own connector names the account as the service.
 */
export function accountProvider(account: ConnectorAccount): AccountProvider {
  return account.provider ?? (account.service === 'microsoft' ? 'microsoft' : 'google')
}

/**
 * Where a connector that is not connected yet is offered. Google's and
 * Microsoft's sit together under their account, the rest by what they do.
 */
export const CONNECTOR_SHELVES: { description?: string; id: string; title: string }[] = [
  {
    description:
      'Connect the ones you want, one at a time or several in one sign-in. Bots reach only what you connect.',
    id: 'google',
    title: 'Google'
  },
  {
    description:
      'Connect the ones you want, one at a time or several in one sign-in. Bots reach only what you connect.',
    id: 'microsoft',
    title: 'Microsoft'
  },
  { id: 'search', title: 'Search and browsing' },
  { id: 'work', title: 'Notes and work' },
  { id: 'social_home', title: 'Social' }
]

/** The shelf a connector sits on: its account's, or its group's. */
export function shelfOf(plugin: Plugin): string {
  return (
    plugin.connector?.family ??
    (plugin.connector?.account ? accountProvider(plugin.connector.account) : plugin.category)
  )
}

/** Set up, working or not: anything past "not set up" is the user's to look after. */
export function isConnected(plugin: Plugin): boolean {
  return plugin.state !== 'not_set_up'
}

/**
 * The other connectors of `plugin`'s account that still wait for a sign-in:
 * the ones one sign-in can connect along with it.
 */
export function accountSiblings(plugin: Plugin, plugins: Plugin[]): Plugin[] {
  const account = plugin.connector?.account

  if (!account) {
    return []
  }

  const provider = accountProvider(account)

  return plugins.filter(
    item =>
      item.kind === 'connector' &&
      item.id !== plugin.id &&
      item.connector?.account &&
      accountProvider(item.connector.account) === provider &&
      !item.connector.account.signed_in
  )
}

/** "Needs memo installed", as the bot's Skills tab words it. */
function needs(missing: SkillRequirement[] = []): string {
  const words = missing.map(item =>
    item.kind === 'command'
      ? `${item.name} installed`
      : item.kind === 'env'
        ? item.name
        : `to run on ${item.name.join(' or ')}`
  )

  return words.length ? `Needs ${words.join(', ')}` : 'Not set up'
}

/**
 * Whether a plugin can be given to a bot now: set up for every bot, or for
 * that one through a key in its own settings.
 */
export function canGive(plugin: Plugin, bot: string): boolean {
  return plugin.ready || Boolean(plugin.ready_bots?.includes(bot))
}

/**
 * The bots to give a plugin to when the user picks `next`: a grant still
 * waiting for setup is kept, since the picker does not show it.
 */
export function withWaiting(plugin: Plugin, next: string[]): string[] {
  return [...new Set([...next, ...(plugin.waiting_bots ?? [])])]
}

/**
 * The bots a plugin's switches show as on. A Google or Microsoft connector
 * whose sign-in stopped working keeps its bots waiting for a new one; they
 * show as on, so the user can take the connector away from them before
 * signing in again. `exact` says the switches hold every grant, so a
 * change sends just what they show and adds no waiting grant back.
 */
export function shownBots(plugin: Plugin): { bots: string[]; exact: boolean } {
  const expired = Boolean(plugin.connector?.account?.signed_in) && !plugin.ready

  return expired
    ? { bots: [...new Set([...plugin.bots, ...(plugin.waiting_bots ?? [])])], exact: true }
    : { bots: plugin.bots, exact: false }
}

/**
 * The plugin a tag in a message names, by its name or its id. A skill tag
 * finds a skill or a package of skills; a plugin tag a connector or a server.
 */
export function namedPlugin(
  plugins: Plugin[],
  kind: 'plugin' | 'skill',
  name: string
): Plugin | undefined {
  const needle = name.trim().toLowerCase()
  const skill = (plugin: Plugin) => plugin.category !== 'mcp' && plugin.kind !== 'connector'

  return plugins.find(
    plugin =>
      (kind === 'skill') === skill(plugin) &&
      (plugin.name.toLowerCase() === needle || plugin.id.toLowerCase() === needle)
  )
}

/** One list of rows, whatever their kind. */
export function pluginRows(list: PluginsList): Plugin[] {
  return [
    ...list.connectors.map((row): Plugin => ({
      bots: row.bots,
      category: row.mcp ? 'mcp' : row.group,
      connector: row,
      description: row.description,
      icon: row.mcp ? serverIcon(row.mcp.name ?? row.name, row.server) : row.icon,
      id: row.id,
      kind: 'connector',
      name: row.mcp?.name ?? row.name,
      ready: row.ready !== false,
      ready_bots: row.ready_bots,
      waiting_bots: row.waiting_bots,
      server: row.server ?? null,
      state: row.state,
      state_text: row.state_text
    })),
    ...(list.packages ?? []).map((row): Plugin => ({
      bots: row.bots,
      category: row.server ? 'mcp' : 'skills',
      connector: row.connector,
      description:
        row.description ||
        (row.server ? (row.connector?.description ?? '') : 'Skills installed together.'),
      icon: row.server ? serverIcon(row.name, row.server) : 'glyph:package',
      id: row.id,
      installed_by: row.installed_by,
      kind: 'package',
      name: row.name,
      ready: row.ready,
      ready_bots: row.ready_bots,
      waiting_bots: row.waiting_bots,
      server: row.server,
      skills: row.skills,
      state: row.state,
      state_text: row.state_text
    })),
    ...list.skills.map((row): Plugin => ({
      bots: row.bots,
      category: row.category || 'other',
      description: row.description,
      disabled_globally: row.disabled_globally,
      icon: skillIcon(row),
      id: row.id,
      kind: 'skill',
      name: row.name,
      ready: row.ready !== false,
      ready_bots: row.ready_bots,
      waiting_bots: row.waiting_bots,
      source: row.source,
      state: row.ready === false ? 'not_set_up' : 'ready',
      state_text:
        row.ready === false
          ? needs(row.missing)
          : row.disabled_globally
            ? 'Off for every bot'
            : row.source === 'bundled'
              ? 'Comes with Hexbot'
              : row.source === 'bot'
                ? 'Written by a bot'
                : 'Added by you'
    }))
  ]
}
