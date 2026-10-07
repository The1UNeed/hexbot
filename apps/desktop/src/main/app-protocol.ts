// Serve the built web bundle over a custom scheme so that the bundle can use
// an absolute asset base ("/") and nested routes work exactly as they do when
// the daemon serves the same files to a LAN browser. file:// cannot do that.
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'
import { net, protocol } from 'electron'

export const APP_SCHEME = 'hexbot-app'
export const APP_ORIGIN = `${APP_SCHEME}://app`

const MIME: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
}

/** Map a request path onto a file inside the bundle root, with SPA fallback. */
export function resolveAppRequest(
  pathname: string,
  rootDir: string,
  exists: (file: string) => boolean
): { file: string; mime: string } {
  const decoded = decodeURIComponent(pathname.split('?')[0] ?? '/')
  const relative = normalize(decoded).replace(/^(\.\.(\/|\\|$))+/, '')
  const candidate = join(rootDir, relative)
  const inside = candidate === rootDir || candidate.startsWith(rootDir + sep)
  const isAsset = extname(relative) !== ''
  if (inside && isAsset && exists(candidate)) {
    return {
      file: candidate,
      mime: MIME[extname(candidate).toLowerCase()] ?? 'application/octet-stream'
    }
  }
  return { file: join(rootDir, 'index.html'), mime: MIME['.html']! }
}

/** The page bot visuals run in (apps/web/public); it carries its own CSP. */
export const VISUAL_FRAME_PATH = '/visual-frame.html'

const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: http: https:",
  "font-src 'self' data:",
  "connect-src 'self' http: https: ws: wss:",
  "media-src 'self' blob:"
].join('; ')

/**
 * Headers for a bundle file. HTML gets the app's CSP, except the visual frame:
 * its page needs inline scripts the app's policy forbids, so it sets a
 * stricter one of its own and runs sandboxed in an opaque origin.
 */
export function appResponseHeaders(
  file: string,
  mime: string,
  rootDir: string
): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': mime, 'cache-control': 'no-cache' }
  if (mime.startsWith('text/html') && file !== join(rootDir, VISUAL_FRAME_PATH)) {
    headers['content-security-policy'] = APP_CSP
  }
  return headers
}

/**
 * A frame inside the app may only load the visual frame page from the app's
 * own origin. A visual's script that tries to navigate its frame elsewhere,
 * to carry data out in the URL, is stopped.
 */
export function frameNavigationAllowed(url: string, pageUrl: string): boolean {
  try {
    const target = new URL(url)
    const page = new URL(pageUrl)
    // Compared part by part: URL.origin is "null" for the app's own scheme.
    return (
      target.protocol === page.protocol &&
      target.host === page.host &&
      target.pathname === VISUAL_FRAME_PATH
    )
  } catch {
    return false
  }
}

/** Must run before app.whenReady(). */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true
      }
    }
  ])
}

/** Install the handler; call after app.whenReady(). */
export function installAppProtocol(rootDir: string, exists: (file: string) => boolean): void {
  protocol.handle(APP_SCHEME, async request => {
    const url = new URL(request.url)
    if (url.host !== 'app') return new Response('Not found', { status: 404 })
    const { file, mime } = resolveAppRequest(url.pathname, rootDir, exists)
    try {
      const body = await readFile(file)
      return new Response(body, { headers: appResponseHeaders(file, mime, rootDir) })
    } catch {
      return net
        .fetch('data:text/plain,Not found', { method: 'GET' })
        .then(() => new Response('Not found', { status: 404 }))
    }
  })
}
