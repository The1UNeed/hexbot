// The policy matches the daemon-served client's isolated visual frame.
export const visualPolicy =
  "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob: https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com https://esm.sh; style-src 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com https://esm.sh https://fonts.googleapis.com; font-src data: https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com https://fonts.gstatic.com; img-src data: blob:; media-src data: blob:; connect-src data: blob:; worker-src blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
/**
 * Page defaults, before the page's own CSS, as the desktop app sets them: the
 * theme's background, text and 14px type, and scrollbars that stay visible. On
 * the desktop the frame sits inside a padded bubble; here the page fills the
 * card, so the body carries that padding. iOS does not enlarge the text on its own.
 */
const BASE_CSS =
  'html{background:var(--background);color:var(--foreground);font:14px/1.5 var(--font-sans);-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%;text-size-adjust:100%}' +
  'body{margin:0;padding:16px}' +
  ':not(:root)::-webkit-scrollbar{width:8px;height:8px}:not(:root)::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--foreground) 30%,transparent);border-radius:4px}:not(:root)::-webkit-scrollbar-track,:not(:root)::-webkit-scrollbar-corner{background:transparent}'

/**
 * The document the WebView loads: the policy, the theme and the defaults ahead
 * of the bot's page, so the page's own styles and scripts come after and win.
 * The page is not wrapped in a body of ours: a whole document the bot wrote
 * keeps its own head and body, and a fragment works too, since the parser
 * opens html, head and body around it.
 */
export function visualDocument(html: string, variables: Record<string, string>) {
  const css = Object.entries(variables)
    .filter(([k, v]) => /^--[\w-]+$/.test(k) && !/[<>{};]/.test(v))
    .map(([k, v]) => `${k}:${v}`)
    .join(';')
  const page = html.replace(/^\s*<!doctype[^>]*>/i, '')
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${visualPolicy}"><style>:root{${css}}</style><style>${BASE_CSS}</style>${page}`
}
