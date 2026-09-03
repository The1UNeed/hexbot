export interface PairLocation {
  hash: string
  search: string
}

export interface PairDetails {
  code: string
  host: string
  port: string
  deepLink: string
}

export function parsePairLocation(location: PairLocation): PairDetails | null {
  const query = new URLSearchParams(location.search)
  const fragment = new URLSearchParams(location.hash.replace(/^#/, ''))
  const host = query.get('host')?.trim() ?? ''
  const port = query.get('port')?.trim() ?? ''
  const code = fragment.get('code')?.trim() ?? ''
  const portNumber = Number(port)

  if (!host || !code || !/^\d+$/.test(port) || portNumber < 1 || portNumber > 65535) return null

  const deepQuery = new URLSearchParams({ host, port })
  const deepFragment = new URLSearchParams({ code })
  return { code, host, port, deepLink: `hexbot://pair?${deepQuery}#${deepFragment}` }
}
