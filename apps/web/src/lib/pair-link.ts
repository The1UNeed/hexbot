/**
 * `hexbot://pair?host=...&port=...#code=...` — the link behind the pairing QR
 * (docs/api.md, `hexbot.pairing.code`). The code travels in the fragment so it
 * never reaches a server if the link is opened in a browser.
 */

export interface PairLink {
  code: string
  host: string
  port: number
}

export interface AddressParts {
  host: string
  port: number
}

export const DEFAULT_DAEMON_PORT = 9119

/** Parse a pairing link; returns null when it is not one. */
export function parsePairLink(input: string): null | PairLink {
  const raw = input.trim()

  if (!raw.toLowerCase().startsWith('hexbot://')) {
    return null
  }

  // `new URL` treats an unknown scheme as opaque on some engines, so the
  // pieces are pulled apart by hand.
  const withoutScheme = raw.slice('hexbot://'.length)
  const [beforeFragment, ...fragmentParts] = withoutScheme.split('#')
  const fragment = fragmentParts.join('#')
  const [path, query = ''] = (beforeFragment ?? '').split('?')

  if ((path ?? '').replace(/\/+$/, '').toLowerCase() !== 'pair') {
    return null
  }

  const params = new URLSearchParams(query)
  const fragmentParams = new URLSearchParams(fragment)
  const host = (params.get('host') ?? '').trim()
  const code = (fragmentParams.get('code') ?? params.get('code') ?? '').trim()
  const port = Number.parseInt(params.get('port') ?? '', 10)

  if (!host || !code) {
    return null
  }

  return { code, host, port: Number.isFinite(port) && port > 0 ? port : DEFAULT_DAEMON_PORT }
}

/**
 * Accepts `host`, `host:port`, `http://host:port` or `ws://host:port` and
 * normalises it to `{host, port}`.
 */
export function parseAddress(input: string): AddressParts | null {
  const raw = input.trim().replace(/\/+$/, '')

  if (!raw) {
    return null
  }

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`

  try {
    const url = new URL(withScheme)

    if (!url.hostname) {
      return null
    }

    const port = url.port ? Number.parseInt(url.port, 10) : DEFAULT_DAEMON_PORT

    return {
      host: url.hostname,
      port: Number.isFinite(port) && port > 0 ? port : DEFAULT_DAEMON_PORT
    }
  } catch {
    return null
  }
}

export function formatAddress(parts: AddressParts): string {
  return `${parts.host}:${parts.port}`
}
