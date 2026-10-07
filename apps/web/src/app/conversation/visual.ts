import type { Message } from '../../lib/types'

/** The tool a bot calls to show a visual; its arguments carry the page. */
export const SHOW_HTML_TOOL = 'hexbot_show_html'

/** The static page every visual runs in; it carries the frame's own CSP. */
export const VISUAL_FRAME_SRC = '/visual-frame.html'

/** The frame follows the page's height up to this; taller pages scroll inside it. */
export const VISUAL_MAX_HEIGHT = 2000

export interface Visual {
  html: string
  title: string
  toolId: string
}

export interface VisualTheme {
  appearance: 'dark' | 'light'
  variables: Record<string, string>
}

/**
 * The visuals a bot showed in a message, in the order it showed them. Only
 * calls that finished without an error count; live calls carry their
 * arguments as an object, restored ones as the JSON the model wrote.
 */
export function visualsOf(message: Pick<Message, 'toolCalls'>): Visual[] {
  return message.toolCalls.flatMap(call => {
    if (call.name !== SHOW_HTML_TOOL || call.status !== 'ok') {
      return []
    }

    const args = typeof call.args === 'string' ? parseArgs(call.args) : call.args

    if (!args || typeof args !== 'object') {
      return []
    }

    const { html, title } = args as { html?: unknown; title?: unknown }

    if (typeof html !== 'string' || !html.trim()) {
      return []
    }

    return [{ html, title: typeof title === 'string' ? title : 'Visual', toolId: call.toolId }]
  })
}

function parseArgs(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** The names a visual sees on :root, each read from the app's own token. */
const THEME_TOKENS: [name: string, token: string][] = [
  ['--background', '--hex-background'],
  ['--foreground', '--hex-text'],
  ['--muted', '--hex-muted-text'],
  ['--surface', '--hex-surface'],
  ['--surface-2', '--hex-surface-2'],
  ['--border', '--hex-border'],
  ['--accent', '--hex-accent'],
  ['--accent-foreground', '--hex-accent-fg'],
  ['--success', '--hex-success'],
  ['--warning', '--hex-warning'],
  ['--danger', '--hex-danger'],
  ['--info', '--hex-info'],
  ['--chart-1', '--hex-chart-1'],
  ['--chart-2', '--hex-chart-2'],
  ['--chart-3', '--hex-chart-3'],
  ['--chart-4', '--hex-chart-4'],
  ['--chart-5', '--hex-chart-5'],
  ['--chart-6', '--hex-chart-6'],
  ['--radius', '--hex-radius-control'],
  ['--font-sans', '--hex-font-sans'],
  ['--font-mono', '--hex-font-mono']
]

/** The app's theme as a visual sees it, resolved for the current light or dark mode. */
export function readVisualTheme(root: HTMLElement = document.documentElement): VisualTheme {
  const style = getComputedStyle(root)
  const chosen = root.dataset.theme

  const appearance =
    chosen === 'dark' || chosen === 'light'
      ? chosen
      : window.matchMedia?.('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'

  const variables: Record<string, string> = {}

  for (const [name, token] of THEME_TOKENS) {
    const value = style.getPropertyValue(token).trim()

    if (value) {
      variables[name] = value
    }
  }

  return { appearance, variables }
}

/** Page defaults, before the page's own CSS: theme background, text and font, no body margin. */
const BASE_CSS =
  'html{background:var(--background);color:var(--foreground);font:14px/1.5 var(--font-sans);-webkit-font-smoothing:antialiased}body{margin:0}'

/**
 * Runs first inside the frame. It applies the theme before the page paints and
 * again on every `ui/notifications/host-context-changed`, reports the page's
 * height with `ui/notifications/size-changed`, and hands http(s) links to the
 * app with `ui/open-link`, since the sandbox allows no popups. The messages
 * follow the MCP Apps shapes.
 */
const BOOTSTRAP = `(function (theme) {
  var style = document.getElementById('hexbot-theme')
  var apply = function (next) {
    var rules = ['color-scheme:' + next.theme]
    for (var name in next.styles.variables) rules.push(name + ':' + next.styles.variables[name])
    style.textContent = ':root{' + rules.join(';') + '}'
  }
  var post = function (message) {
    message.jsonrpc = '2.0'
    parent.postMessage(message, '*')
  }
  apply(theme)
  var height = -1
  var measure = function () {
    var next = Math.ceil(document.documentElement.getBoundingClientRect().height)
    if (next === height) return
    height = next
    post({ method: 'ui/notifications/size-changed', params: { height: next } })
  }
  new ResizeObserver(measure).observe(document.documentElement)
  addEventListener('load', measure)
  addEventListener('message', function (event) {
    var data = event.data
    if (event.source !== parent || !data || data.method !== 'ui/notifications/host-context-changed') return
    apply(data.params)
  })
  var links = 0
  document.addEventListener('click', function (event) {
    var link = event.target instanceof Element ? event.target.closest('a[href]') : null
    if (!link || event.defaultPrevented || !event.isTrusted) return
    var url = new URL(link.href, location.href)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return
    if (url.href.split('#')[0] === location.href.split('#')[0]) return
    event.preventDefault()
    post({ id: 'link-' + ++links, method: 'ui/open-link', params: { url: url.href } })
  })
})`

/** The host context a visual receives: MCP Apps' `{ theme, styles: { variables } }`. */
export function hostContext(theme: VisualTheme) {
  return { styles: { variables: theme.variables }, theme: theme.appearance }
}

/**
 * The document the frame writes: the bot's page with the theme and bootstrap
 * ahead of it, so the page's own styles and scripts come after and win. A
 * fragment works too; the parser opens html, head and body around it.
 */
export function visualDocument(html: string, theme: VisualTheme): string {
  const page = html.replace(/^\s*<!doctype[^>]*>/i, '')
  const context = JSON.stringify(hostContext(theme)).replace(/</g, '\\u003c')

  return `<!doctype html><style id="hexbot-theme"></style><style>${BASE_CSS}</style><script>${BOOTSTRAP}(${context})</script>${page}`
}
