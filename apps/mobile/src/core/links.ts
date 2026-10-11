export const CONNECT_ORIGIN = 'https://connect.hexbot.app'
export function normalizeOrigin(input: string): string {
  const raw = input.trim()
  if (!raw) throw new Error('Enter the daemon address.')
  const explicit = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
  const url = new URL(explicit ? raw : `http://${raw}`)
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password)
    throw new Error('Use an http:// or https:// daemon address without a username or password.')
  if (url.pathname !== '/' || url.search || url.hash)
    throw new Error('Enter only the daemon address, or paste its pairing link.')
  if (!explicit && !url.port) url.port = '9119'
  return url.origin
}
export function parsePairing(input: string): { origin: string; code: string } | null {
  try {
    const url = new URL(input.trim())
    const fragment = new URLSearchParams(url.hash.slice(1))
    if (url.protocol === 'hexbot:' && url.hostname === 'pair') {
      const host = url.searchParams.get('host') ?? ''
      const port = url.searchParams.get('port') ?? '9119'
      if (!host || !/^\d+$/.test(port) || +port < 1 || +port > 65535)
        throw new Error('Invalid pairing address.')
      const code = fragment.get('code') ?? url.searchParams.get('code')
      if (!code) throw new Error('This pairing link is missing its code.')
      const origin = normalizeOrigin(`http://${host}:${port}`)
      if (new URL(origin).host !== `${host}:${port}` && +port !== 80)
        throw new Error('Invalid pairing address.')
      return { origin, code }
    }
    if ((url.protocol === 'http:' || url.protocol === 'https:') && url.pathname === '/login') {
      const code = url.searchParams.get('code')
      if (code) return { origin: url.origin, code }
    }
  } catch (error) {
    if (input.trim().startsWith('hexbot://')) throw error
  }
  return null
}
export function parseConnectCallback(input: string, expected: string): string {
  const url = new URL(input)
  if (
    url.protocol !== 'hexbot:' ||
    url.hostname !== 'connect' ||
    url.pathname ||
    url.searchParams.get('state') !== expected
  )
    throw new Error('Hex Connect sign-in did not match this app. Start sign-in again.')
  const token = new URLSearchParams(url.hash.slice(1)).get('session')
  if (!token || token.length > 4096) throw new Error('Hex Connect did not return a session.')
  return token
}
export function daemonAddress(daemon: { address?: string; tunnel_hostname: string }): string {
  return normalizeOrigin(daemon.address || `https://${daemon.tunnel_hostname}`)
}
