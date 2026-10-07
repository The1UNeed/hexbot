/**
 * `hexbot://pair?host=...&port=...#code=...` — the link behind the pairing QR
 * (docs/api.md, `hexbot.pairing.code`). The code travels in the fragment so it
 * never reaches a server if the link is opened in a browser.
 */

export interface PairLink {
  code: string
  host: string
  port: number
  tls: boolean
}

export interface AddressParts {
  host: string
  port: number
  tls: boolean
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
  const port = Number(params.get('port'))

  if (!host || !code) {
    return null
  }

  const tlsParam = params.get('tls')
  const tls = tlsParam == null ? port === 443 : tlsParam === 'true' || tlsParam === '1'
  return {
    code,
    host,
    port:
      Number.isInteger(port) && port > 0 && port <= 65535 ? port : tls ? 443 : DEFAULT_DAEMON_PORT,
    tls
  }
}

/**
 * Accepts `host`, `host:port`, `http://host:port` or `ws://host:port` and
 * normalises it to `{host, port, tls}`.
 */
export function parseAddress(input: string): AddressParts | null {
  const raw = input.trim().replace(/\/+$/, '')

  if (!raw) {
    return null
  }

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`

  try {
    const url = new URL(withScheme)

    if (!url.hostname || !['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) {
      return null
    }

    const explicitScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
    // URL strips an explicit default port, so read it from the authority too.
    const authority = withScheme.split('://')[1]?.split(/[/?#]/)[0] ?? ''
    const explicitPort = /:(\d+)$/.exec(authority)?.[1]
    const tls =
      url.protocol === 'https:' ||
      url.protocol === 'wss:' ||
      (!explicitScheme && explicitPort === '443')
    const port = explicitPort
      ? Number(explicitPort)
      : explicitScheme
        ? tls
          ? 443
          : 80
        : DEFAULT_DAEMON_PORT

    return {
      host: url.hostname,
      port,
      tls
    }
  } catch {
    return null
  }
}

export function formatAddress(parts: AddressParts): string {
  const host =
    parts.host.includes(':') && !parts.host.startsWith('[') ? `[${parts.host}]` : parts.host
  return `${parts.tls ? 'https://' : 'http://'}${host}:${parts.port}`
}
