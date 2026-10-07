import { Stack } from 'expo-router'
import { useEffect, useState } from 'react'
import { Linking, StyleSheet, Text } from 'react-native'

import { Group, ListScroll, Row } from '../../components/list'
import { Cell, Lead, MONO, PageState } from '../../components/settings/kit'
import { connectStatus, type ConnectStatus } from '../../lib/api'
import { rowTime } from '../../lib/format'
import { useTheme } from '../../theme'

/** The daemon's `last_error` after the owner removed it on the Connect dashboard (services.rs). */
const REVOKED_REASON = 'Removed in Hex Connect'

/**
 * Hex Connect, status only: whether this daemon has an address outside the
 * network and whether its tunnel runs. Setup happens on the computer.
 */
export default function Connect() {
  const { colors } = useTheme()
  const [status, setStatus] = useState<ConnectStatus | null>(null)
  const [error, setError] = useState<null | string>(null)

  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const poll = async () => {
      try {
        const next = await connectStatus()

        if (!stopped) {
          setStatus(next)
          setError(null)
        }
      } catch {
        if (!stopped) {
          setError('The daemon could not be reached.')
        }
      } finally {
        if (!stopped) {
          timer = setTimeout(() => void poll(), 5000)
        }
      }
    }

    void poll()

    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [])

  const problem = status?.registered ? (status.identity_error ?? status.last_error) : status?.last_error === REVOKED_REASON ? REVOKED_REASON : null

  return (
    <>
      <Stack.Screen options={{ title: 'Hex Connect' }} />
      <ListScroll testID="connect">
        <Lead>Reach this daemon from outside your network. Chat traffic never passes through Hex Connect.</Lead>
        {!status ? (
          <PageState error={error} />
        ) : (
          <>
            <Group error={problem ?? error}>
              <Row title="Status" value={status.registered ? 'Connected' : 'Not set up'} />
              {status.registered ? (
                <Cell onPress={status.tunnel_hostname ? () => void Linking.openURL(`https://${status.tunnel_hostname}`) : undefined}>
                  <Text style={[styles.title, { color: colors.text }]}>Address</Text>
                  <Text numberOfLines={1} selectable style={[styles.host, { color: colors.accent }]}>
                    {status.tunnel_hostname ?? '—'}
                  </Text>
                </Cell>
              ) : null}
              {status.registered ? <Row title="Tunnel" value={status.tunnel_running ? 'Running' : 'Stopped'} /> : null}
              {status.registered && status.last_heartbeat_at ? <Row title="Last heartbeat" value={rowTime(status.last_heartbeat_at)} /> : null}
            </Group>
            <Lead>
              {status.registered
                ? 'Manage Hex Connect on the computer running Hexbot, in Settings, Hex Connect.'
                : 'Set up Hex Connect on the computer running Hexbot, in Settings, Hex Connect. This phone can then reach the daemon from anywhere.'}
            </Lead>
          </>
        )}
      </ListScroll>
    </>
  )
}

const styles = StyleSheet.create({
  host: { flex: 1, fontFamily: MONO, fontSize: 15, textAlign: 'right' },
  title: { fontSize: 17, lineHeight: 22 }
})
