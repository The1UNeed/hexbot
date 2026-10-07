import * as Linking from 'expo-linking'
import { Redirect, useLocalSearchParams } from 'expo-router'

import { parsePairLink } from '../lib/pair-link'
import { useConnection } from '../stores/connection'

/**
 * `hexbot://pair?host=...&port=...#code=...` opened from the camera or a
 * message: fill the connect screen. A paired phone stays where it is; it
 * connects to another daemon from Settings.
 */
export default function Pair() {
  const params = useLocalSearchParams<{ code?: string; host?: string; port?: string }>()
  const url = Linking.useLinkingURL()
  const paired = useConnection(state => Boolean(state.target))
  const link = (url ? parsePairLink(url) : null) ?? (params.host ? { code: params.code ?? '', host: params.host, port: Number(params.port) || 9119 } : null)

  if (paired || !link) {
    return <Redirect href="/" />
  }

  return <Redirect href={{ params: { code: link.code, host: link.host, port: String(link.port) }, pathname: '/connect' }} />
}
