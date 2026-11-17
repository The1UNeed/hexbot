/**
 * Icons for plugin rows the daemon sends without one: skills and MCP
 * servers. A value is a key of `BRAND_ICONS` or `glyph:<name>`, as
 * `ConnectorIcon` draws it. Pure, so the mobile app can share it.
 */

import { BRAND_ICONS } from './connector-icons'
import type { PluginForm, PluginServer } from './types'

/** The icon for a skill you or a bot wrote. */
export const DEFAULT_SKILL_ICON = 'glyph:sparkles'
/** The icon for a server no brand matches. */
export const DEFAULT_SERVER_ICON = 'glyph:server'

/** Skills that come with Hexbot, by name. */
const SKILL_ICONS: Record<string, string> = {
  'blocked-page-recovery': 'glyph:shield-alert',
  'computer-use': 'glyph:monitor',
  docx: 'microsoftword',
  email: 'glyph:inbox',
  'google-workspace': 'google',
  mcp: 'glyph:server',
  'microsoft-365': 'microsoft',
  notion: 'notion',
  pdf: 'glyph:file-type',
  powerpoint: 'microsoftpowerpoint',
  'skill-creator': 'glyph:wand',
  'skill-installer': 'glyph:package',
  xlsx: 'microsoftexcel',
  xurl: 'x'
}

/** A bundled skill missing from the list above takes its category's icon. */
const CATEGORY_ICONS: Record<string, string> = {
  connectors: 'glyph:package',
  documents: 'glyph:file-text',
  hexbot: 'glyph:hexagon'
}

export function skillIcon(skill: { category?: string; name: string; source?: string }): string {
  if (skill.source !== 'bundled') {
    return DEFAULT_SKILL_ICON
  }

  return SKILL_ICONS[skill.name] ?? CATEGORY_ICONS[skill.category ?? ''] ?? DEFAULT_SKILL_ICON
}

/** Words a server's name, command or URL uses for a brand we have a glyph for. */
const SERVER_WORDS: [RegExp, string][] = [
  [/\bgoogle[-_ ]?drive\b|\bgdrive\b/, 'googledrive'],
  [/\bgoogle[-_ ]?calendar\b|\bgcal\b/, 'googlecalendar'],
  [/\bgoogle[-_ ]?maps\b/, 'googlemaps'],
  [/\bhome[-_ ]?assistant\b|\bhass\b/, 'homeassistant'],
  [/\bpostgres(ql)?\b/, 'postgresql']
]

/** Programs that run servers say nothing about what a server is for. */
const RUNTIMES = new Set(['docker', 'nodedotjs', 'python'])

function brandIn(text: string): null | string {
  for (const [pattern, icon] of SERVER_WORDS) {
    if (pattern.test(text)) {
      return icon
    }
  }

  // Whole words only, so `x` or `box` never match inside another word.
  const words = new Set(text.split(/[^a-z0-9]+/).filter(Boolean))

  return (
    Object.keys(BRAND_ICONS).find(
      slug => slug.length > 1 && !RUNTIMES.has(slug) && words.has(slug)
    ) ?? null
  )
}

/**
 * A brand glyph when the server's name, or else its URL or command, names
 * one, such as `github` or `npx -y @notionhq/notion-mcp-server`; otherwise
 * a server.
 */
export function serverIcon(name: string, server?: null | PluginServer): string {
  const rest = [server?.url, server?.command, ...(server?.args ?? [])].filter(Boolean).join(' ')

  return brandIn(name.toLowerCase()) ?? brandIn(rest.toLowerCase()) ?? DEFAULT_SERVER_ICON
}

/** A plugin card's icon: the daemon's for a connector, as Settings draws it otherwise. */
export function pluginFormIcon(form: PluginForm): string {
  if (form.icon) {
    return form.icon
  }

  const [kind, ...rest] = form.id.split(':')
  const id = rest.join(':')

  return kind === 'skill' ? skillIcon({ name: id }) : serverIcon(id.replace(/^mcp:/, ''))
}
