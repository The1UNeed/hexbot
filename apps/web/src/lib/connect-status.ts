/** Status may come from older daemons; never render internal error strings. */
export function connectStatusMessage(error: string, identity = false): string {
  if (error.startsWith('Hex Connect has a different key')) {
    return 'Hex Connect has a different key for this daemon. Disconnect and connect again.'
  }

  if (identity || /identity key|connect-identity\.key/.test(error)) {
    return 'connect-identity.key in the Hexbot home could not be read or saved. Check the file and restart the daemon.'
  }

  if (error.startsWith('tunnel repair')) {
    return 'The tunnel could not be repaired.'
  }

  if (error.startsWith('cloudflared')) {
    return 'The tunnel is not connected.'
  }

  return 'Hex Connect could not be reached.'
}
