/**
 * Tags: the things a message names that you can click. A web page opens in
 * the browser, a bot opens its conversation, a file opens beside the chat,
 * and a room, a bot's scheduled jobs, a Settings page, a plugin or a skill
 * opens where it lives.
 *
 * A tag is an ordinary Markdown link, so a message reads the same on a client
 * that does not know tags. Its target says what it is:
 *
 * - `https://…` a web page
 * - `@handle`, or `hexbot:bot/<handle>`, a bot
 * - an absolute path, `file://…` or `hexbot:file/<path>`, a file
 * - `hexbot:room/<name or id>` a room
 * - `hexbot:jobs` or `hexbot:jobs/<handle>` a bot's scheduled jobs
 * - `hexbot:settings/<page>` a Settings page
 * - `hexbot:plugin/<name>` a connector or MCP server; `hexbot:skill/<name>` a skill
 *
 * The daemon teaches bots the same list (`HEXBOT_GUIDANCE` in runtime.rs).
 * Pure, so the mobile app parses tags with the same rules.
 */

import { baseName } from './media'

export type Tag =
  | { handle: string; kind: 'bot' }
  | { kind: 'file'; name: string; path: string }
  /** `bot` is null for the bot that is speaking. */
  | { bot: null | string; kind: 'jobs' }
  | { host: string; kind: 'link'; site: null | string; url: string }
  | { kind: 'plugin'; name: string }
  | { kind: 'room'; room: string }
  | { kind: 'settings'; page: string }
  | { kind: 'skill'; name: string }

export type TagKind = Tag['kind']

/** The scheme of a tag that is not a web page or a path. */
export const TAG_SCHEME = 'hexbot:'

/** The Settings pages a tag can open, by the id both apps route on. */
export const SETTINGS_PAGES = [
  'about',
  'appearance',
  'approvals',
  'computer',
  'connect',
  'diagnostics',
  'memory',
  'network',
  'notifications',
  'passwords',
  'plugins',
  'privacy',
  'providers',
  'updates',
  'usage'
] as const

export type SettingsPage = (typeof SETTINGS_PAGES)[number]

const HANDLE = /^[a-z0-9][a-z0-9_-]{0,63}$/

const decode = (value: string) => {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

const fileTag = (path: string): null | Tag =>
  path.trim() ? { kind: 'file', name: baseName(path), path } : null

/** `/Users/me/a.pdf`, `~/a.pdf`, `C:\a.pdf`; never `//host/…`, which is a web address. */
const ABSOLUTE_PATH = /^(?:\/(?!\/)|~\/|[a-z]:[\\/])/i

/** Brand spellings a capital letter alone gets wrong. */
const SITES: Record<string, string> = {
  arxiv: 'arXiv',
  bbc: 'BBC',
  chatgpt: 'ChatGPT',
  cnn: 'CNN',
  ebay: 'eBay',
  github: 'GitHub',
  gitlab: 'GitLab',
  hubspot: 'HubSpot',
  ibm: 'IBM',
  imdb: 'IMDb',
  linkedin: 'LinkedIn',
  mit: 'MIT',
  nasa: 'NASA',
  npmjs: 'npm',
  openai: 'OpenAI',
  paypal: 'PayPal',
  stackoverflow: 'Stack Overflow',
  wechat: 'WeChat',
  youtube: 'YouTube'
}

/** Second-level labels that are part of the suffix: `example.co.uk`, `example.com.cn`. */
const SUFFIX_LABELS = new Set(['ac', 'co', 'com', 'edu', 'gov', 'net', 'org'])

function parseUrl(value: string): null | URL {
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`)
  } catch {
    return null
  }
}

/** A host a favicon may be asked of: a public name, never an address on your network. */
function publicHost(name: string): boolean {
  // `localhost.` is `localhost`: a trailing dot only says the name is complete.
  const host = name.replace(/\.$/, '')

  return (
    host.includes('.') &&
    !/^[\d.]+$/.test(host) &&
    !host.includes(':') &&
    !/\.(?:local|localhost|internal|lan|home|arpa|test|invalid)$/.test(host)
  )
}

/**
 * A site by its name: "Taobao" for `https://www.taobao.com/…`, "GitHub" for
 * `github.com`. Null for an address with no name to it, such as an IP.
 */
export function siteName(url: string): null | string {
  const host = parseUrl(url)?.hostname.toLowerCase().replace(/^www\./, '') ?? ''

  if (!publicHost(host)) {
    return null
  }

  const labels = host.split('.')
  const suffix = labels.length > 2 && labels.at(-1)!.length === 2 && SUFFIX_LABELS.has(labels.at(-2)!) ? 2 : 1
  const label = labels.at(-1 - suffix) ?? labels[0]!

  return SITES[label] ?? label.charAt(0).toUpperCase() + label.slice(1)
}

/**
 * The site's own icon, asked of the site itself and of no one else. Null for
 * an address on your network, which a message must not make the app call.
 */
export function faviconOf(url: string): null | string {
  const parsed = parseUrl(url)

  return parsed && parsed.protocol === 'https:' && publicHost(parsed.hostname.toLowerCase())
    ? `${parsed.origin}/favicon.ico`
    : null
}

/** What a link's target is, or null when it is no tag (`mailto:`, a relative link). */
export function tagOf(href: string | null | undefined): null | Tag {
  const target = (href ?? '').trim()

  if (!target) {
    return null
  }

  if (/^https?:\/\//i.test(target)) {
    const parsed = parseUrl(target)

    return parsed
      ? { host: parsed.hostname.replace(/^www\./, ''), kind: 'link', site: siteName(target), url: parsed.href }
      : null
  }

  if (/^file:\/\//i.test(target)) {
    // `file:///C:/a.pdf` names `C:/a.pdf`; `file:///Users/a.pdf` names `/Users/a.pdf`.
    const path = decode(target.replace(/^file:\/\/(?:localhost)?/i, ''))

    return fileTag(/^\/[a-z]:[\\/]/i.test(path) ? path.slice(1) : path)
  }

  if (ABSOLUTE_PATH.test(target)) {
    return fileTag(decode(target))
  }

  if (target.startsWith('@')) {
    const handle = target.slice(1).toLowerCase()

    return HANDLE.test(handle) ? { handle, kind: 'bot' } : null
  }

  if (!target.toLowerCase().startsWith(TAG_SCHEME)) {
    return null
  }

  const [kind = '', ...rest] = target.slice(TAG_SCHEME.length).replace(/^\/\//, '').split('/')
  const value = decode(rest.join('/')).trim()

  switch (kind.toLowerCase()) {
    case 'bot': {
      const handle = value.replace(/^@/, '').toLowerCase()

      return HANDLE.test(handle) ? { handle, kind: 'bot' } : null
    }

    case 'file':
      return fileTag(value)

    case 'job':
    case 'jobs': {
      const bot = value.replace(/^@/, '').toLowerCase()

      return { bot: HANDLE.test(bot) ? bot : null, kind: 'jobs' }
    }

    case 'plugin':
      return value ? { kind: 'plugin', name: value } : null

    case 'room':
      return value ? { kind: 'room', room: value } : null
    case 'settings': {
      const page = value.toLowerCase()

      return (SETTINGS_PAGES as readonly string[]).includes(page) ? { kind: 'settings', page } : null
    }

    case 'skill':
      return value ? { kind: 'skill', name: value } : null

    default:
      return null
  }
}

/** The link target that names `handle`, as `@handle` is read. */
export const botHref = (handle: string) => `${TAG_SCHEME}bot/${handle}`

/**
 * `@handle` in running text: at the start or after a space or bracket, never
 * inside an address (`me@example.com`) or a path.
 */
const MENTION = /(^|[^\w@./\\-])@([a-z0-9][a-z0-9_-]{0,63})(?![\w-]*@)/gi

/** Text cut at its `@handle`s, in order; whether a handle is a bot is the roster's to say. */
export function splitMentions(text: string): (string | { handle: string })[] {
  const parts: (string | { handle: string })[] = []
  let from = 0

  for (const match of text.matchAll(MENTION)) {
    const at = match.index + match[1]!.length

    if (at > from) {
      parts.push(text.slice(from, at))
    }

    parts.push({ handle: match[2]!.toLowerCase() })
    from = match.index + match[0].length
  }

  if (from < text.length) {
    parts.push(text.slice(from))
  }

  return parts
}

const LABEL_MAX = 48

/**
 * The words on a web page's tag. A link written as its own address shows the
 * site and the page without the scheme; a named link keeps its name.
 */
export function linkLabel(label: string, url: string): string {
  const words = label.trim()
  const bare = (value: string) => value.replace(/^https?:\/\//i, '').replace(/\/$/, '')

  if (words && bare(words) !== bare(url)) {
    return words
  }

  const parsed = parseUrl(url)

  if (!parsed) {
    return words || url
  }

  const shown = `${parsed.hostname.replace(/^www\./, '')}${parsed.pathname === '/' ? '' : parsed.pathname}`

  return shown.length > LABEL_MAX ? `${shown.slice(0, LABEL_MAX - 1)}…` : shown
}

/** What a tag does when clicked, for a tooltip and a screen reader. */
export function tagHint(tag: Tag): string {
  switch (tag.kind) {
    case 'bot':
      return 'Open the conversation'

    case 'file':
      return `Open ${tag.name}`

    case 'jobs':
      return 'Open scheduled jobs'

    case 'link':
      return `Open ${tag.host}`

    case 'plugin':
      return 'Open in Settings, Plugins'

    case 'room':
      return 'Open the room'

    case 'settings':
      return 'Open in Settings'

    case 'skill':
      return 'Open in Settings, Plugins'
  }
}
