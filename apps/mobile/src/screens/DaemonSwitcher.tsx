import { Ionicons } from '@expo/vector-icons'
import { useState } from 'react'
import { Alert, Platform, Pressable, StyleSheet, View } from 'react-native'

import { Button, formatListTime, Layer, mono, radius, Text, useTheme } from '../ui'
import type { DaemonEntry } from './types'

export interface DaemonSwitcherProps {
  visible: boolean
  onClose: () => void
  daemons: DaemonEntry[]
  /** Bots on the current daemon, for its subtitle. */
  botCount?: number
  /** The saved daemon being opened now. */
  switching?: string | null
  onSwitch: (id: string) => void
  onAdd: () => void
  onForget: (id: string) => void
}

function confirmForget(name: string, forget: () => void) {
  const body = 'Pair again to reconnect. The daemon keeps its bots and history.'
  if (Platform.OS === 'web') {
    // React Native Web has no Alert; the browser preview confirms inline.
    if (globalThis.confirm?.(`Forget ${name}? ${body}`) ?? true) forget()
    return
  }
  Alert.alert(`Forget ${name}`, body, [
    { style: 'cancel', text: 'Cancel' },
    { onPress: forget, style: 'destructive', text: 'Forget' }
  ])
}

/** Every daemon this phone has paired with; one tap switches. */
export function DaemonSwitcher({
  botCount,
  daemons,
  onAdd,
  onClose,
  onForget,
  onSwitch,
  switching,
  visible
}: DaemonSwitcherProps) {
  const theme = useTheme()
  const [editing, setEditing] = useState(false)
  const ordered = [...daemons].sort((a, b) => Number(!!b.current) - Number(!!a.current))

  return (
    <Layer
      action={
        daemons.length
          ? { label: editing ? 'Done' : 'Edit', onPress: () => setEditing(value => !value) }
          : undefined
      }
      onClose={() => {
        setEditing(false)
        onClose()
      }}
      testID="daemon-switcher"
      title="Daemons"
      visible={visible}
    >
      <View style={styles.list}>
        {ordered.map(daemon => {
          const opening = switching === daemon.id
          return (
            <View
              key={daemon.id}
              style={[
                styles.entry,
                {
                  backgroundColor: daemon.current ? theme.surface : 'transparent',
                  borderColor: daemon.current ? theme.hairline : 'transparent'
                }
              ]}
              testID={`daemon-entry-${daemon.id}`}
            >
              <Ionicons
                color={theme.text}
                name={daemon.via === 'connect' ? 'cloud-outline' : 'wifi'}
                size={22}
                style={styles.icon}
              />
              <View style={styles.text}>
                <Text numberOfLines={1} variant="headline">
                  {daemon.name}
                </Text>
                <Text numberOfLines={1} tone="muted" variant="footnote">
                  {daemon.via === 'connect' ? 'Hex Connect' : 'Local network'}
                  {daemon.current && botCount != null
                    ? `, ${botCount} ${botCount === 1 ? 'bot' : 'bots'}`
                    : daemon.lastUsedAt
                      ? `, ${formatListTime(daemon.lastUsedAt)}`
                      : ''}
                </Text>
                <Text numberOfLines={1} style={styles.address} tone="faint" variant="caption">
                  {daemon.address}
                </Text>
              </View>
              {editing ? (
                <Button
                  label="Forget"
                  onPress={() => confirmForget(daemon.name, () => onForget(daemon.id))}
                  style={styles.small}
                  testID={`daemon-forget-${daemon.id}`}
                  variant="destructive"
                />
              ) : daemon.current ? (
                <View
                  accessibilityLabel="Current daemon"
                  style={[styles.check, { backgroundColor: theme.ink }]}
                >
                  <Ionicons color={theme.onInk} name="checkmark" size={18} />
                </View>
              ) : (
                <Button
                  busy={opening}
                  busyLabel="Opening…"
                  disabled={!!switching && !opening}
                  label="Switch"
                  onPress={() => onSwitch(daemon.id)}
                  style={styles.small}
                  testID={`daemon-switch-${daemon.id}`}
                  variant="secondary"
                />
              )}
            </View>
          )
        })}
        {daemons.length === 0 ? (
          <Text align="center" tone="muted" variant="callout">
            No saved daemons. Add one with a pairing code or Hex Connect.
          </Text>
        ) : null}
      </View>
      <Pressable
        accessibilityRole="button"
        onPress={onAdd}
        style={({ pressed }) => [
          styles.add,
          { backgroundColor: theme.fill, opacity: pressed ? 0.7 : 1 }
        ]}
        testID="daemons-add"
      >
        <Ionicons color={theme.text} name="add" size={22} />
        <Text variant="headline">Add daemon</Text>
      </Pressable>
      <Text style={styles.footnote} tone="muted" variant="footnote">
        Each daemon keeps its own bots, threads and memory. Switching changes which one this phone
        talks to.
      </Text>
    </Layer>
  )
}

const styles = StyleSheet.create({
  add: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    borderRadius: 999,
    flexDirection: 'row',
    gap: 8,
    marginTop: 18,
    minHeight: 48,
    paddingHorizontal: 18
  },
  address: { fontFamily: mono },
  check: {
    alignItems: 'center',
    borderRadius: 16,
    height: 32,
    justifyContent: 'center',
    width: 32
  },
  entry: {
    alignItems: 'center',
    borderRadius: radius.card,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 14,
    minHeight: 76,
    paddingHorizontal: 16,
    paddingVertical: 12
  },
  footnote: { marginTop: 16, paddingHorizontal: 4 },
  icon: { width: 24 },
  list: { gap: 4 },
  small: { minHeight: 40, paddingHorizontal: 16 },
  text: { flex: 1, gap: 1 }
})
