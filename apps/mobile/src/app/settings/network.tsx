import * as Clipboard from 'expo-clipboard'
import * as Haptics from 'expo-haptics'
import { Stack } from 'expo-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Share, StyleSheet, Text, View } from 'react-native'

import { Group, ListScroll, Row, SwitchRow } from '../../components/list'
import { Cell, errorText, MONO, Notice, PillButton, useOnReconnect } from '../../components/settings/kit'
import { QrCode } from '../../components/settings/qr'
import { pairingCode } from '../../lib/api'
import { toMillis } from '../../lib/time'
import type { PairingCode } from '../../lib/types'
import { useConnection } from '../../stores/connection'
import { useSettings } from '../../stores/settings'
import { useTheme } from '../../theme'

/**
 * Network and pairing: whether other devices on this network may reach the
 * daemon, its addresses, and a one-time code (with its link as a QR) for
 * pairing another device.
 */
export default function Network() {
  const { colors } = useTheme()
  const network = useSettings(state => state.network)
  const refreshNetwork = useSettings(state => state.refreshNetwork)
  const setLan = useSettings(state => state.setLanEnabled)
  const status = useConnection(state => state.status)
  const [error, setError] = useState<null | string>(null)
  const [reconnecting, setReconnecting] = useState(false)
  const [pending, setPending] = useState<boolean | null>(null)
  const [code, setCode] = useState<null | PairingCode>(null)
  const [creating, setCreating] = useState(false)
  const [copied, setCopied] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const sawDisconnect = useRef(false)

  useEffect(() => {
    void refreshNetwork().catch(caught => setError(errorText(caught)))
  }, [refreshNetwork])
  useOnReconnect(useCallback(() => void refreshNetwork().then(() => setError(null), () => undefined), [refreshNetwork]))

  // The daemon moves its listener and drops every connection; wait for this phone to come back.
  useEffect(() => {
    if (!reconnecting) {
      return
    }

    if (status !== 'connected') {
      sawDisconnect.current = true
    } else if (sawDisconnect.current) {
      sawDisconnect.current = false
      setReconnecting(false)
      setPending(null)
      void refreshNetwork().catch(caught => setError(errorText(caught)))
    }
  }, [reconnecting, refreshNetwork, status])

  useEffect(() => {
    if (!code) {
      return
    }

    const timer = setInterval(() => setNow(Date.now()), 1000)

    return () => clearInterval(timer)
  }, [code])

  const toggle = async (enabled: boolean) => {
    setError(null)
    setPending(enabled)
    setReconnecting(true)
    setCode(null)

    try {
      await setLan(enabled)
      // Some daemons answer and keep the socket; nothing to wait for then.
      setTimeout(() => {
        if (!sawDisconnect.current) {
          setReconnecting(false)
          setPending(null)
        }
      }, 2500)
    } catch (caught) {
      // The daemon may drop this socket before its reply arrives; the reconnect settles the switch.
      if (/websocket|not connected/i.test(caught instanceof Error ? caught.message : String(caught))) {
        sawDisconnect.current = true

        return
      }

      setReconnecting(false)
      setPending(null)
      setError(errorText(caught))
    }
  }

  const create = async () => {
    setCreating(true)
    setError(null)
    setCopied(false)

    try {
      setCode(await pairingCode())
      setNow(Date.now())
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setCreating(false)
    }
  }

  const lan = pending ?? network?.lan_enabled ?? false
  const seconds = code ? Math.max(0, Math.ceil((toMillis(code.expires_at) - now) / 1000)) : 0
  const expired = Boolean(code) && seconds === 0
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`

  return (
    <>
      <Stack.Screen options={{ title: 'Network and pairing' }} />
      <ListScroll testID="network">
        {reconnecting ? (
          <Notice tone="info">Reconnecting to the daemon at its new address. Running bot turns continue.</Notice>
        ) : null}
        {error ? <Notice tone="danger">{error}</Notice> : null}

        <Group
          footer={
            lan ? 'Devices on your network can reach this daemon and pair with a code.' : 'Only this computer and Hex Connect can reach the daemon.'
          }
        >
          <SwitchRow
            disabled={!network || reconnecting}
            onValueChange={value => void toggle(value)}
            testID="network-lan"
            title="Allow other devices on this network"
            value={lan}
          />
        </Group>

        {network?.lan_enabled && network.addresses.length ? (
          <Group label="Addresses">
            {network.addresses.map(address => (
              <Cell key={address}>
                <Text selectable style={[styles.address, { color: colors.text }]}>
                  {address}:{network.port}
                </Text>
              </Cell>
            ))}
          </Group>
        ) : null}

        {code && network?.lan_enabled && !reconnecting ? (
          <Group label="Pair another device" testID="pairing-card">
            <View style={styles.card}>
              <View style={[styles.qr, expired && { opacity: 0.15 }]}>
                <QrCode size={196} value={code.link} />
              </View>
              <Text accessibilityLabel={`Pairing code ${code.code.split('').join(' ')}`} selectable style={[styles.code, { color: expired ? colors.textFaint : colors.text }]} testID="pairing-code">
                {code.code}
              </Text>
              <Text accessibilityLiveRegion="polite" style={[styles.expiry, { color: expired ? colors.danger : colors.textMuted }]} testID="pairing-expiry">
                {expired ? 'This code has expired.' : `Scan with Hexbot on the other device, or enter the code. Expires in ${clock}.`}
              </Text>
              <View style={styles.actions}>
                {expired ? (
                  <PillButton loading={creating} onPress={() => void create()} testID="pairing-new" tone="primary">
                    New code
                  </PillButton>
                ) : (
                  <>
                    <PillButton
                      onPress={() => {
                        void Clipboard.setStringAsync(code.link).then(() => {
                          setCopied(true)
                          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined)
                        })
                      }}
                      testID="pairing-copy"
                    >
                      {copied ? 'Copied' : 'Copy link'}
                    </PillButton>
                    <PillButton onPress={() => void Share.share({ message: code.link }).catch(() => undefined)} testID="pairing-share">
                      Share
                    </PillButton>
                  </>
                )}
              </View>
            </View>
          </Group>
        ) : (
          <Group footer={network?.lan_enabled ? 'A code works once and expires after a few minutes.' : 'Turn on network access above to pair another device.'}>
            <Row
              disabled={!network?.lan_enabled || reconnecting || status !== 'connected'}
              icon="qrcode"
              loading={creating}
              onPress={() => void create()}
              testID="pairing-create"
              title="Pair another device"
            />
          </Group>
        )}
      </ListScroll>
    </>
  )
}

const styles = StyleSheet.create({
  actions: { flexDirection: 'row', gap: 10, marginTop: 4 },
  address: { fontFamily: MONO, fontSize: 16 },
  card: { alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingVertical: 24 },
  code: { fontFamily: MONO, fontSize: 32, fontWeight: '600', letterSpacing: 4, marginTop: 6 },
  expiry: { fontSize: 14, lineHeight: 19, textAlign: 'center' },
  qr: { borderRadius: 12, overflow: 'hidden' }
})
