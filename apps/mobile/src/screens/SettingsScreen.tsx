import { Ionicons } from '@expo/vector-icons'
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import {
  Banner,
  BotFace,
  Button,
  Group,
  IconButton,
  type IconName,
  radius,
  Row,
  Screen,
  STATUS_LABELS,
  Text,
  TopBar,
  useTheme,
  withAlpha
} from '../ui'
import type { BotSummary, ConnectionState, DaemonOverview } from './types'

/** One of the daemon's areas, opened on a front card. */
export interface DaemonArea {
  key:
    | 'about'
    | 'activity'
    | 'connect'
    | 'connectors'
    | 'devices'
    | 'network'
    | 'providers'
    | 'settings'
    | 'skills'
    | 'updates'
    | 'usage'
  label: string
  detail?: string | null
  icon: IconName
}

export interface SettingsScreenProps {
  daemon: DaemonOverview | null
  error?: string | null
  onDismissError?: () => void
  /** Signed-in person on this daemon. */
  user?: { name: string } | null
  onBack: () => void
  /** Opens the list of saved daemons to switch between. */
  onSwitchDaemon: () => void
  /** Bots that are working, stopped or waiting; each opens where it is. */
  busy: BotSummary[]
  onOpenPulse: (id: string) => void
  groups: { title?: string; areas: DaemonArea[] }[]
  onOpenArea: (key: DaemonArea['key']) => void
  onReconnect?: () => void
  onPairAgain?: () => void
  onDisconnect?: () => void
  refreshing?: boolean
  onRefresh?: () => void
}

const STATE: Record<ConnectionState, string> = {
  connected: 'Connected',
  connecting: 'Connecting',
  offline: 'Offline',
  reconnecting: 'Reconnecting',
  unauthorized: 'Signed out'
}

/** The daemon this phone talks to, what its bots are doing, and its settings. */
export function SettingsScreen({
  busy,
  daemon,
  error,
  groups,
  onBack,
  onDisconnect,
  onDismissError,
  onOpenArea,
  onOpenPulse,
  onPairAgain,
  onReconnect,
  onRefresh,
  onSwitchDaemon,
  refreshing,
  user
}: SettingsScreenProps) {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const via =
    daemon?.via === 'connect'
      ? 'through Hex Connect'
      : daemon?.via === 'demo'
        ? 'Sample bots on this phone'
        : 'on the local network'

  return (
    <Screen background="grouped" testID="settings-screen">
      <TopBar onBack={onBack} testID="settings-bar" title="Settings" />
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}
        refreshControl={
          onRefresh ? <RefreshControl onRefresh={onRefresh} refreshing={!!refreshing} /> : undefined
        }
        testID="settings-list"
      >
        <Pressable
          accessibilityHint="Switch to another daemon"
          accessibilityRole="button"
          onPress={onSwitchDaemon}
          style={({ pressed }) => [
            styles.daemon,
            { backgroundColor: pressed ? theme.pressed : theme.surface }
          ]}
          testID="daemon-current"
        >
          <View style={[styles.glyph, { backgroundColor: theme.fill }]}>
            <Ionicons
              color={theme.text}
              name={
                daemon?.via === 'connect'
                  ? 'cloud-outline'
                  : daemon?.via === 'demo'
                    ? 'flask-outline'
                    : 'desktop-outline'
              }
              size={26}
            />
            {daemon ? (
              <View
                style={[
                  styles.glyphDot,
                  {
                    backgroundColor:
                      daemon.state === 'connected'
                        ? theme.success
                        : daemon.state === 'offline' || daemon.state === 'unauthorized'
                          ? theme.danger
                          : theme.warning,
                    borderColor: theme.surface
                  }
                ]}
              />
            ) : null}
          </View>
          <View style={styles.daemonText}>
            <Text accessibilityRole="header" numberOfLines={1} variant="title">
              {daemon?.name ?? 'Not connected'}
            </Text>
            <Text numberOfLines={2} tone="muted" variant="footnote">
              {daemon
                ? daemon.via === 'demo'
                  ? via
                  : `${STATE[daemon.state]} ${via}`
                : 'Add a daemon to run your bots.'}
            </Text>
            {daemon?.version || daemon?.platform ? (
              <Text numberOfLines={1} tone="faint" variant="caption">
                {[daemon.version ? `Version ${daemon.version}` : null, daemon.platform]
                  .filter(Boolean)
                  .join(', ')}
              </Text>
            ) : null}
          </View>
          <IconButton
            accessibilityLabel="Switch daemon"
            icon="chevron-expand"
            iconSize={20}
            onPress={onSwitchDaemon}
            testID="daemon-switch"
            variant="tinted"
          />
        </Pressable>

        {error ? (
          <Banner
            actionLabel="Dismiss"
            message={error}
            onAction={onDismissError}
            testID="app-error"
          />
        ) : null}

        {daemon && (daemon.state === 'offline' || daemon.state === 'unauthorized') ? (
          <Banner
            actionLabel={daemon.state === 'unauthorized' ? 'Pair again' : 'Try again'}
            message={
              daemon.state === 'unauthorized'
                ? `${daemon.name} no longer accepts this phone.`
                : `Cannot reach ${daemon.name}. It may be asleep or off the network.`
            }
            onAction={daemon.state === 'unauthorized' ? onPairAgain : onReconnect}
            testID="daemon-reconnect"
          />
        ) : null}

        {daemon && daemon.via !== 'demo' ? (
          <Group testID="daemon-pulse" title="Right now">
            {busy.length ? (
              busy.slice(0, 5).map(bot => {
                const color =
                  bot.status === 'needs_you'
                    ? theme.accent
                    : bot.status === 'stopped'
                      ? theme.danger
                      : theme.info
                return (
                  <Row
                    key={bot.id}
                    leading={<BotFace {...bot} size={30} />}
                    onPress={() => onOpenPulse(bot.id)}
                    testID={`pulse-${bot.id}`}
                    title={`${bot.name}: ${bot.activity || STATUS_LABELS[bot.status!]}`}
                    trailing={
                      <View style={[styles.tag, { backgroundColor: withAlpha(color, 0.14) }]}>
                        <Text style={{ color }} variant="caption">
                          {bot.status === 'needs_you' ? 'Review' : 'Open'}
                        </Text>
                      </View>
                    }
                  />
                )
              })
            ) : (
              <Row
                leading={<Ionicons color={theme.success} name="checkmark-circle" size={22} />}
                testID="pulse-idle"
                title="Every bot is idle."
              />
            )}
          </Group>
        ) : null}

        {groups.map(group => (
          <Group key={group.title ?? group.areas[0]?.key} separatorInset={56} title={group.title}>
            {group.areas.map(area => (
              <Row
                chevron
                key={area.key}
                leading={<Ionicons color={theme.text} name={area.icon} size={22} />}
                meta={area.detail}
                onPress={() => onOpenArea(area.key)}
                testID={`daemon-${area.key}`}
                title={area.label}
              />
            ))}
          </Group>
        ))}

        {user || onDisconnect ? (
          <View style={styles.footer}>
            <Text numberOfLines={1} style={styles.fill} tone="muted" variant="footnote">
              {user ? `Signed in as ${user.name}` : ''}
            </Text>
            {onDisconnect ? (
              <Button
                label={daemon?.via === 'demo' ? 'Leave the demo' : 'Disconnect'}
                onPress={onDisconnect}
                style={styles.footerButton}
                testID="daemon-disconnect"
                variant="plain"
              />
            ) : null}
          </View>
        ) : null}
      </ScrollView>
    </Screen>
  )
}

const styles = StyleSheet.create({
  content: { gap: 24, paddingHorizontal: 16, paddingTop: 8 },
  daemon: {
    alignItems: 'center',
    borderRadius: radius.panel,
    flexDirection: 'row',
    gap: 14,
    padding: 16
  },
  daemonText: { flex: 1, gap: 1 },
  fill: { flex: 1 },
  footer: { alignItems: 'center', flexDirection: 'row', gap: 8, paddingHorizontal: 4 },
  footerButton: { marginRight: -8 },
  glyph: {
    alignItems: 'center',
    borderRadius: 18,
    height: 56,
    justifyContent: 'center',
    width: 56
  },
  glyphDot: {
    borderRadius: 7,
    borderWidth: 2,
    bottom: -2,
    height: 14,
    position: 'absolute',
    right: -2,
    width: 14
  },
  tag: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 }
})
