/**
 * Icons for plugin rows the daemon sends without one: skills and MCP
 * servers. A value is a key of `BRAND_ICONS` or `glyph:<name>`, as
 * `ConnectorIcon` draws it. Pure, so the mobile app can share it.
 */

import { BRAND_ICONS } from './connector-icons'
import type { PluginServer } from './types'

/** The icon for a skill you or a bot wrote. */
export const DEFAULT_SKILL_ICON = 'glyph:sparkles'
/** The icon for a server no brand matches. */
export const DEFAULT_SERVER_ICON = 'glyph:server'

/** Skills that come with Hexbot, by name. */
const SKILL_ICONS: Record<string, string> = {
  airtable: 'airtable',
  'apple-notes': 'apple',
  'apple-reminders': 'apple',
  'architecture-diagram': 'glyph:network',
  arxiv: 'arxiv',
  'ascii-video': 'glyph:clapperboard',
  'baoyu-infographic': 'glyph:chart-pie',
  'blocked-page-recovery': 'glyph:shield-alert',
  box: 'box',
  'claude-code': 'claude',
  'claude-design': 'claude',
  'codebase-inspection': 'glyph:folder-search',
  codex: 'openai',
  'competitor-news-monitor': 'glyph:newspaper',
  'computer-use': 'glyph:monitor',
  'design-md': 'glyph:palette',
  'document-to-action-items': 'glyph:list-checks',
  docx: 'glyph:file-text',
  dogfood: 'glyph:bug',
  'email-inbox-triage': 'glyph:inbox',
  findmy: 'apple',
  'gif-search': 'glyph:image',
  github: 'github',
  'google-workspace': 'google',
  'grounded-citations': 'glyph:quote',
  'hermes-agent': 'glyph:bot',
  'hermes-agent-skill-authoring': 'glyph:pen-line',
  himalaya: 'glyph:mail',
  humanizer: 'glyph:pen-line',
  imessage: 'imessage',
  'inspecting-hermes-desktop-dom': 'glyph:scan-search',
  'llm-wiki': 'glyph:book-open',
  'manim-video': 'glyph:clapperboard',
  maps: 'googlemaps',
  mcp: 'glyph:server',
  'meeting-action-items': 'glyph:list-checks',
  'node-inspect-debugger': 'nodedotjs',
  notion: 'notion',
  obsidian: 'obsidian',
  opencode: 'glyph:square-terminal',
  p5js: 'p5dotjs',
  pdf: 'glyph:file-type',
  'popular-web-designs': 'glyph:layout-template',
  powerpoint: 'glyph:presentation',
  'product-price-monitor': 'glyph:tag',
  'python-debugpy': 'python',
  'requesting-code-review': 'glyph:git-pull-request',
  'sdlc-review': 'glyph:clipboard-check',
  'simplify-code': 'glyph:scissors',
  'skill-create': 'glyph:wand',
  songsee: 'glyph:music',
  'songwriting-and-ai-music': 'glyph:music',
  spike: 'glyph:flask',
  'systematic-debugging': 'glyph:bug',
  'teams-meeting-pipeline': 'glyph:users',
  'test-driven-development': 'glyph:flask',
  'weekly-review-planning': 'glyph:calendar-check',
  xlsx: 'glyph:file-spreadsheet',
  xurl: 'x',
  'youtube-content': 'youtube'
}

/** A bundled skill missing from the list above takes its category's icon. */
const CATEGORY_ICONS: Record<string, string> = {
  apple: 'apple',
  'autonomous-ai-agents': 'glyph:bot',
  creative: 'glyph:palette',
  devops: 'glyph:server-cog',
  email: 'glyph:mail',
  hexbot: 'glyph:hexagon',
  media: 'glyph:clapperboard',
  'note-taking': 'glyph:notebook',
  productivity: 'glyph:list-checks',
  research: 'glyph:book-open',
  'social-media': 'glyph:at-sign',
  'software-development': 'glyph:code',
  web: 'glyph:globe'
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
