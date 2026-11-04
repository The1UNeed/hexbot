// The policy matches the daemon-served client's isolated visual frame.
export const visualPolicy =
  "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob: https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com https://esm.sh; style-src 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com https://esm.sh https://fonts.googleapis.com; font-src data: https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com https://fonts.gstatic.com; img-src data: blob:; media-src data: blob:; connect-src data: blob:; worker-src blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
// Scroll areas inside a page keep a visible scrollbar where the WebView allows
// it, as in the desktop app, so content past a capped box is not hidden.
const SCROLLBARS =
  ':not(:root)::-webkit-scrollbar{width:8px;height:8px}:not(:root)::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--foreground) 30%,transparent);border-radius:4px}:not(:root)::-webkit-scrollbar-track,:not(:root)::-webkit-scrollbar-corner{background:transparent}'
export function visualDocument(html: string, variables: Record<string, string>) {
  const css = Object.entries(variables)
    .filter(([k, v]) => /^--[\w-]+$/.test(k) && !/[<>{};]/.test(v))
    .map(([k, v]) => `${k}:${v}`)
    .join(';')
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${visualPolicy}"><style>:root{${css}}body{margin:0;background:var(--background);color:var(--foreground);font-family:system-ui}*{box-sizing:border-box}${SCROLLBARS}</style></head><body>${html.replace(/^\s*<!doctype[^>]*>/i, '')}</body></html>`
}
