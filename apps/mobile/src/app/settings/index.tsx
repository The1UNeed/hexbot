import { router, Stack } from 'expo-router'
import { useEffect, useState } from 'react'
import { Alert, StyleSheet, Text, View } from 'react-native'

import { Icon } from '../../components/icon'
import { Group, ListScroll, Row } from '../../components/list'
import { appVersion, Cell, closeSheet, Initials, MONO } from '../../components/settings/kit'
import { connectStatus, type ConnectStatus } from '../../lib/api'
import { forgetDaemon } from '../../lib/connection'
import { useConnection } from '../../stores/connection'
import { useSettings } from '../../stores/settings'
import { useUi } from '../../stores/ui'
import { useUsers } from '../../stores/users'
import { useTheme } from '../../theme'

const MODE_LABEL = { manual: 'Manual', off: 'Bypass', smart: 'Auto' } as const
const THEME_LABEL = { dark: 'Dark', light: 'Light', system: 'System' } as const

const STATUS_WORD = {
  connected: 'Connected',
  connecting: 'Connecting',
  idle: 'Not connected',
  offline: 'Offline',
  reconnecting: 'Reconnecting',
  unauthorized: 'Signed out'
} as const

/**
 * Settings, from the avatar on the home list: you and the daemon you are
 * connected to, then the pages in four groups, then a way out to another
 * daemon. Values on the right are live, so a page rarely needs opening just
 * to check it.
 */
export default function Settings() {
  const { colors } = useTheme()
  const me = useUsers(state => state.current)
  const users = useUsers(state => state.users)
  const refreshUsers = useUsers(state => state.refresh)
  const daemon = useConnection(state => state.daemon)
  const target = useConnection(state => state.target)
  const status = useConnection(state => state.status)
  const settings = useSettings(state => state.settings)
  const providers = useSettings(state => state.providers)
  const network = useSettings(state => state.network)
  const devices = useSettings(state => state.devices)
  const theme = useUi(state => state.theme)
  const [connect, setConnect] = useState<ConnectStatus | null>(null)
  const admin = me?.role === 'admin'

  useEffect(() => {
    const store = useSettings.getState()

    void store.refresh()
    void store.refreshProviders().catch(() => undefined)
    void store.refreshNetwork().catch(() => undefined)
    void store.refreshDevices()
    void refreshUsers()
    void connectStatus()
      .then(setConnect)
      .catch(() => undefined)
  }, [refreshUsers])

  const connected = providers.filter(provider => provider.configured === true).length
  const dot = status === 'connected' ? colors.success : status === 'offline' || status === 'unauthorized' ? colors.danger : colors.warning
  const address = target ? `${target.host}:${target.port}` : ''
  const go = (page: string) => () => router.push(`/settings/${page}` as never)

  const leave = () =>
    Alert.alert(
      'Connect to another daemon?',
      `This phone signs out of ${daemon?.daemon_name ?? 'this daemon'} and forgets it. You can pair again later.`,
      [
        { style: 'cancel', text: 'Cancel' },
        { onPress: () => void forgetDaemon(), style: 'destructive', text: 'Disconnect' }
      ]
    )

  return (
    <>
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button accessibilityLabel="Close" icon="xmark" onPress={closeSheet} />
      </Stack.Toolbar>

      <ListScroll testID="settings-index">
        <Group>
          <Cell style={styles.me}>
            <Initials name={me?.display_name ?? 'You'} size={56} />
            <View style={styles.meBody}>
              <Text numberOfLines={1} style={[styles.meName, { color: colors.text }]}>
                {me?.display_name ?? 'You'}
              </Text>
              <Text style={[styles.meRole, { color: colors.textMuted }]}>{me ? (admin ? 'Admin' : 'Member') : ' '}</Text>
            </View>
          </Cell>
          <Cell style={styles.daemon} testID="settings-daemon">
            <View style={[styles.tile, { backgroundColor: colors.surface3 }]}>
              <Icon color={colors.text} name="server.rack" size={15} weight="semibold" />
            </View>
            <View style={styles.daemonBody}>
              <Text numberOfLines={1} style={[styles.daemonName, { color: colors.text }]}>
                {daemon?.daemon_name ?? 'Daemon'}
              </Text>
              <View style={styles.statusLine}>
                <View style={[styles.dot, { backgroundColor: dot }]} />
                <Text numberOfLines={1} style={[styles.statusText, { color: colors.textMuted }]}>
                  {STATUS_WORD[status]}
                  {daemon?.version ? ` · Hexbot ${daemon.version}` : ''}
                </Text>
              </View>
              {address ? (
                <Text numberOfLines={1} selectable style={[styles.mono, { color: colors.textMuted }]}>
                  {address}
                </Text>
              ) : null}
            </View>
          </Cell>
        </Group>

        <Group label="You">
          <Row chevron icon="person.text.rectangle" onPress={go('about-you')} testID="settings-row-about-you" title="About you" />
          <Row
            chevron
            icon="hand.raised"
            onPress={go('approvals')}
            testID="settings-row-approvals"
            title="Approvals"
            value={settings ? MODE_LABEL[settings.approval_mode] : null}
          />
          <Row
            chevron
            icon="circle.lefthalf.filled"
            onPress={go('appearance')}
            testID="settings-row-appearance"
            title="Appearance"
            value={THEME_LABEL[theme]}
          />
        </Group>

        <Group label="Models">
          <Row
            chevron
            icon="key"
            onPress={go('providers')}
            testID="settings-row-providers"
            title="Providers"
            value={providers.length ? `${connected} connected` : null}
          />
          <Row chevron icon="chart.bar" onPress={go('usage')} testID="settings-row-usage" title="Usage" />
        </Group>

        <Group label="Devices">
          <Row
            chevron
            icon="wifi"
            onPress={go('network')}
            testID="settings-row-network"
            title="Network and pairing"
            value={network ? (network.lan_enabled ? 'On' : 'Off') : null}
          />
          <Row
            chevron
            icon="iphone"
            onPress={go('devices')}
            testID="settings-row-devices"
            title="Paired devices"
            value={devices.length ? String(devices.length) : null}
          />
          <Row
            chevron
            icon="globe"
            onPress={go('connect')}
            testID="settings-row-connect"
            title="Hex Connect"
            value={connect ? (connect.registered ? 'On' : 'Off') : null}
          />
          {admin ? (
            <Row
              chevron
              icon="person.2"
              onPress={go('users')}
              testID="settings-row-users"
              title="Users"
              value={users.length ? String(users.length) : null}
            />
          ) : null}
        </Group>

        <Group label="App">
          <Row chevron icon="info.circle" onPress={go('about')} testID="settings-row-about" title="About" value={appVersion()} />
        </Group>

        <Group footer="This phone signs out of the daemon and returns to the connect screen.">
          <Row destructive onPress={leave} testID="settings-sign-out" title="Connect to another daemon" />
        </Group>
      </ListScroll>
    </>
  )
}

const styles = StyleSheet.create({
  daemon: { paddingVertical: 12 },
  daemonBody: { flex: 1, gap: 2, minWidth: 0 },
  daemonName: { fontSize: 17, lineHeight: 22 },
  dot: { borderRadius: 4, height: 8, width: 8 },
  me: { gap: 14, paddingVertical: 14 },
  meBody: { flex: 1, gap: 2, minWidth: 0 },
  meName: { fontSize: 22, fontWeight: '600', lineHeight: 28 },
  meRole: { fontSize: 15 },
  mono: { fontFamily: MONO, fontSize: 13, lineHeight: 18 },
  statusLine: { alignItems: 'center', flexDirection: 'row', gap: 6 },
  statusText: { fontSize: 14 },
  tile: { alignItems: 'center', borderCurve: 'continuous', borderRadius: 8, height: 28, justifyContent: 'center', width: 28 },
})
