import { connectStatusMessage } from './connect-status'

it.each([
  ['cloudflared exited: exit status: 1', 'The tunnel is not connected.'],
  ['cloudflared connection lost', 'The tunnel is not connected.'],
  ['tunnel repair failed: internal error', 'The tunnel could not be repaired.'],
  ['Hex Connect service unreachable', 'Hex Connect could not be reached.'],
  ['error sending request for url (https://internal.example)', 'Hex Connect could not be reached.'],
  ['Hex Connect has a different key for this daemon. Disconnect and connect again.', 'Hex Connect has a different key for this daemon. Disconnect and connect again.'],
  ['The daemon identity key could not be read or saved.', 'connect-identity.key in the Hexbot home could not be read or saved. Check the file and restart the daemon.']
])('maps %s to glossary copy', (raw, message) => {
  expect(connectStatusMessage(raw)).toBe(message)
})

it('does not show an unknown identity error verbatim', () => {
  expect(connectStatusMessage('internal file path', true)).toBe(
    'connect-identity.key in the Hexbot home could not be read or saved. Check the file and restart the daemon.'
  )
})
