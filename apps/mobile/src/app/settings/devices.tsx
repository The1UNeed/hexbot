import { Stack } from 'expo-router'
import { useCallback, useEffect, useState } from 'react'
import { Alert, RefreshControl, StyleSheet, Text, View } from 'react-native'

import { Icon } from '../../components/icon'
import { Group, ListScroll, Row } from '../../components/list'
import { Cell, Chip, errorText, PageState, PillButton, useOnReconnect } from '../../components/settings/kit'
import { rowTime } from '../../lib/format'
import { toMillis } from '../../lib/time'
import type { Device } from '../../lib/types'
import { useSettings } from '../../stores/settings'
import { useTheme } from '../../theme'

const PLATFORM: Record<string, { icon: string; label: string }> = {
  android: { icon: 'iphone', label: 'Android' },
  browser: { icon: 'globe', label: 'Browser' },
  darwin: { icon: 'desktopcomputer', label: 'Mac' },
  ios: { icon: 'iphone', label: 'iOS' },
  linux: { icon: 'desktopcomputer', label: 'Linux' },
  local: { icon: 'desktopcomputer', label: 'Local' },
  macos: { icon: 'desktopcomputer', label: 'Mac' },
  web: { icon: 'globe', label: 'Browser' },
  win32: { icon: 'desktopcomputer', label: 'Windows' },
  windows: { icon: 'desktopcomputer', label: 'Windows' }
}

const platformOf = (device: Device) => PLATFORM[device.platform.toLowerCase()] ?? { icon: 'desktopcomputer', label: device.platform }

function seen(device: Device, now = Date.now()): string {
  const at = toMillis(device.last_seen_at)

  if (!at) {
    return 'Never seen'
  }

  return now - at < 2 * 60_000 ? 'Active now' : `Last seen ${rowTime(at, now)}`
}

/** Every app and browser paired with this daemon. Revoking one signs it out at once. */
export default function Devices() {
  const { colors } = useTheme()
  const devices = useSettings(state => state.devices)
  const revoke = useSettings(state => state.revokeDevice)
  const [loaded, setLoaded] = useState(devices.length > 0)
  const [busy, setBusy] = useState<null | string>(null)
  const [error, setError] = useState<null | string>(null)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(
    () =>
      useSettings
        .getState()
        .refreshDevices()
        .then(() => setLoaded(true)),
    []
  )

  useEffect(() => {
    void load()
  }, [load])
  useOnReconnect(load)

  const sorted = [...devices].sort((a, b) => Number(b.current) - Number(a.current) || toMillis(b.last_seen_at) - toMillis(a.last_seen_at))
  const others = devices.filter(device => !device.current)

  const revokeIds = async (ids: string[]) => {
    setBusy(ids.length === 1 ? ids[0] : 'all')
    setError(null)

    try {
      for (const id of ids) {
        await revoke(id)
      }
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setBusy(null)
    }
  }

  const confirm = (device: Device) =>
    Alert.alert(`Revoke ${device.name}?`, 'It is signed out now and needs a new code to pair again.', [
      { style: 'cancel', text: 'Cancel' },
      { onPress: () => void revokeIds([device.id]), style: 'destructive', text: 'Revoke' }
    ])

  const confirmAll = () =>
    Alert.alert(
      others.length === 1 ? 'Revoke the other device?' : `Revoke ${others.length} other devices?`,
      'They are signed out now. This phone stays paired.',
      [
        { style: 'cancel', text: 'Cancel' },
        { onPress: () => void revokeIds(others.map(device => device.id)), style: 'destructive', text: 'Revoke' }
      ]
    )

  return (
    <>
      <Stack.Screen options={{ title: 'Paired devices' }} />
      <ListScroll
        refreshControl={
          <RefreshControl
            onRefresh={() => {
              setRefreshing(true)
              void load().finally(() => setRefreshing(false))
            }}
            refreshing={refreshing}
          />
        }
        testID="devices"
      >
        {!loaded ? (
          <PageState />
        ) : (
          <>
            <Group error={error} footer="To sign this phone out, use Connect to another daemon in Settings.">
              {sorted.map(device => {
                const platform = platformOf(device)

                return (
                  <Cell key={device.id} style={styles.row} testID={`device-${device.id}`}>
                    <View style={[styles.tile, { backgroundColor: colors.surface3 }]}>
                      <Icon color={colors.text} name={platform.icon} size={15} weight="semibold" />
                    </View>
                    <View style={styles.body}>
                      <Text numberOfLines={1} style={[styles.name, { color: colors.text }]}>
                        {device.name}
                      </Text>
                      <Text numberOfLines={1} style={[styles.meta, { color: colors.textMuted }]}>
                        {platform.label} · {device.current ? 'Active now' : seen(device)}
                      </Text>
                    </View>
                    {device.current ? (
                      <Chip>This phone</Chip>
                    ) : (
                      <PillButton
                        disabled={busy !== null}
                        loading={busy === device.id}
                        onPress={() => confirm(device)}
                        testID={`device-revoke-${device.id}`}
                      >
                        Revoke
                      </PillButton>
                    )}
                  </Cell>
                )
              })}
              {sorted.length === 0 ? <Row title="No paired devices" /> : null}
            </Group>
            {others.length > 1 ? (
              <Group>
                <Row destructive disabled={busy !== null} loading={busy === 'all'} onPress={confirmAll} testID="devices-revoke-others" title="Revoke all other devices" />
              </Group>
            ) : null}
          </>
        )}
      </ListScroll>
    </>
  )
}

const styles = StyleSheet.create({
  body: { flex: 1, gap: 2, minWidth: 0 },
  meta: { fontSize: 14 },
  name: { fontSize: 17, lineHeight: 22 },
  row: { paddingVertical: 10 },
  tile: { alignItems: 'center', borderCurve: 'continuous', borderRadius: 8, height: 28, justifyContent: 'center', width: 28 }
})
