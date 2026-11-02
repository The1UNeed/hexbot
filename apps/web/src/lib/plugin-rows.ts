/**
 * `hexbot.plugins.list` as one list of rows, whatever their kind. Pure, so
 * the mobile app reads the plugin list the same way.
 */

import { serverIcon, skillIcon } from './plugin-icons'
import type { Plugin, PluginsList, SkillRequirement } from './types'

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
