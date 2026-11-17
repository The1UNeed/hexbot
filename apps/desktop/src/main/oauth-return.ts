import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * Where Google sends the browser after a sign-in, on the app's own computer.
 * Google lets a desktop client return only to 127.0.0.1, which is the
 * daemon only when the browser runs beside it. Through Hex Connect, LAN or
 * Tailscale the daemon is elsewhere, so the app listens here for the one
 * return and hands its address to the daemon (`hexbot.accounts.sign_in_finish`).
 * The daemon checks the state and holds the PKCE key; a stray request here
 * can't finish anything.
 */

const PATH = '/oauth/google'
/** As long as the daemon waits for a sign-in. */
const LIFETIME_MS = 15 * 60_000

const PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Hexbot</title><style>body{font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#f7f7f5;color:#1d1d1b}@media(prefers-color-scheme:dark){body{background:#161615;color:#ededeb}}main{max-width:28rem;padding:24px}</style><main><p>Back to Hexbot to finish signing in. You can close this tab.</p></main>`

interface Pending {
  server: Server
  /** The address the browser came back to, once it has. */
  returned?: string
  waiters: Array<(url: null | string) => void>
  timer: NodeJS.Timeout
}

export class OAuthReturns {
  private readonly pending = new Map<number, Pending>()

  constructor(private readonly onReturn: () => void = () => undefined) {}

  /** Listens for one return and gives the port to send Google back to. */
  async open(): Promise<number> {
    const server = createServer((request, response) => {
      const url = URL.parse(request.url ?? '/', 'http://127.0.0.1')
      const entry = this.pending.get(port)

      if (request.method !== 'GET' || url?.pathname !== PATH || !url.searchParams.has('state')) {
        response.writeHead(404).end()
        return
      }

      response
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        .end(PAGE)

      if (entry && entry.returned === undefined) {
        entry.returned = `http://127.0.0.1:${port}${PATH}${url.search}`
        for (const resolve of entry.waiters.splice(0)) resolve(entry.returned)
        this.onReturn()
      }
    })

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })

    const port = (server.address() as AddressInfo).port
    const timer = setTimeout(() => this.close(port), LIFETIME_MS)
    timer.unref()
    this.pending.set(port, { server, waiters: [], timer })
    return port
  }

  /** The address the browser came back to on `port`, or null once it closed. */
  wait(port: number): Promise<null | string> {
    const entry = this.pending.get(port)

    if (!entry) return Promise.resolve(null)
    if (entry.returned !== undefined) return Promise.resolve(entry.returned)
    return new Promise(resolve => entry.waiters.push(resolve))
  }

  close(port: number): void {
    const entry = this.pending.get(port)

    if (!entry) return
    this.pending.delete(port)
    clearTimeout(entry.timer)
    entry.server.close()
    entry.server.closeAllConnections()
    for (const resolve of entry.waiters.splice(0)) resolve(null)
  }

  closeAll(): void {
    for (const port of [...this.pending.keys()]) this.close(port)
  }
}
