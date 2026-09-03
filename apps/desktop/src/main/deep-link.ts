export type DeepLink =
  | { kind: 'pair'; code: string; host: string; port: number }
  | { kind: 'connect'; session: string; state: string }

const DEFAULT_DAEMON_PORT = 9119

export function parseDeepLink(input: string, platform = process.platform): DeepLink | null {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return null
  }
  if (url.protocol !== 'hexbot:') return null

  const kind = url.hostname.toLowerCase()
  if (kind === 'pair') {
    const host = (url.searchParams.get('host') ?? '').trim()
    const fragment = new URLSearchParams(url.hash.slice(1))
    const code = (fragment.get('code') ?? url.searchParams.get('code') ?? '').trim()
    const requestedPort = Number.parseInt(url.searchParams.get('port') ?? '', 10)
    if (!host || !code) return null
    return {
      kind: 'pair',
      code,
      host,
      port:
        Number.isFinite(requestedPort) && requestedPort > 0 ? requestedPort : DEFAULT_DAEMON_PORT
    }
  }

  if (kind === 'connect') {
    const fragment = new URLSearchParams(url.hash.slice(1))
    // Some Linux desktop launchers invoke the protocol handler through a
    // shell and discard the fragment. Connect may use ?session= there only.
    const session = (
      fragment.get('session') ??
      (platform === 'linux' ? url.searchParams.get('session') : null) ??
      ''
    ).trim()
    const state = (url.searchParams.get('state') ?? '').trim()
    if (!session || !state) return null
    return { kind: 'connect', session, state }
  }

  return null
}
