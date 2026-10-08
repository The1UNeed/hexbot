import { Ionicons } from '@expo/vector-icons'
import { type ReactNode, useMemo, useState } from 'react'
import {
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View
} from 'react-native'

import {
  Banner,
  BotFace,
  Button,
  EmptyState,
  faceForName,
  formatListTime,
  Glass,
  HIT,
  IconButton,
  type IconName,
  radius,
  resolveFace,
  RoomFace,
  Screen,
  SearchField,
  STATUS_LABELS,
  TabBar,
  Text,
  useKeyboardVisible,
  useTabBarInset,
  useTheme,
  withAlpha
} from '../ui'
import type { BotSummary, ConnectionState, DaemonOverview, RoomSummary } from './types'

export type HomeTab = 'bots' | 'daemon' | 'groups'

/** One of the daemon's areas, opened on a front card. */
export interface DaemonArea {
  key: string
  label: string
  detail?: string | null
  icon: IconName
  /** Highlight it, such as an update that is ready. */
  prominent?: boolean
}

export interface HomeScreenProps {
  error?: string | null
  onDismissError?: () => void
  tab: HomeTab
  onTabChange: (tab: HomeTab) => void

  bots: BotSummary[]
  onOpenBot: (id: string) => void
  /** Opens where a busy bot is working or waiting, such as its thread or group. */
  onOpenPulse?: (id: string) => void
  /** Long press on a bot, such as opening its profile. */
  onBotLongPress?: (id: string) => void
  onNewBot?: () => void

  groups: RoomSummary[]
  /** The group shown in the Groups tab. */
  groupId?: string | null
  onSelectGroup: (id: string) => void
  onNewGroup?: () => void
  onOpenGroupSettings?: (id: string) => void
  /** Opens every group, archived ones included. */
  onOpenAllGroups?: () => void
  /** The open group's conversation, drawn by the parent. */
  groupChat?: ReactNode

  daemon: DaemonOverview | null
  /** Opens the list of saved daemons to switch between. */
  onSwitchDaemon: () => void
  areas: DaemonArea[]
  onOpenArea: (key: string) => void
  /** Signed-in person on this daemon. */
  user?: { name: string; role: string } | null
  onReconnect?: () => void
  onPairAgain?: () => void
  onDisconnect?: () => void

  refreshing?: boolean
  onRefresh?: () => void
  /** First load: lists are empty because nothing has arrived yet. */
  loading?: boolean
}

const STATE: Record<ConnectionState, string> = {
  connected: 'Connected',
  connecting: 'Connecting',
  offline: 'Offline',
  reconnecting: 'Reconnecting',
  unauthorized: 'Signed out'
}

const PINNED: Record<string, number> = { needs_you: 0, stopped: 1, working: 2 }

function matches(query: string, ...fields: (null | string | undefined)[]) {
  const needle = query.trim().toLowerCase()

  return !needle || fields.some(field => field?.toLowerCase().includes(needle))
}

/** Bots, Groups and Daemon under one glass tab bar. */
export function HomeScreen(props: HomeScreenProps) {
  const { bots, daemon, onTabChange, tab } = props
  const keyboard = useKeyboardVisible()
  const needYou = bots.filter(bot => bot.status === 'needs_you').length

  return (
    <Screen
      avoidKeyboard={tab === 'groups'}
      background={tab === 'daemon' ? 'grouped' : 'background'}
      testID="home-screen"
    >
      {daemon && daemon.state !== 'connected' && tab !== 'daemon' ? (
        <View style={styles.banner}>
          <Banner
            actionLabel={props.onReconnect && daemon.state === 'offline' ? 'Try again' : undefined}
            message={
              daemon.state === 'unauthorized'
                ? `${daemon.name} no longer accepts this device. Pair again to continue.`
                : daemon.state === 'offline'
                  ? `Cannot reach ${daemon.name}. Showing what was loaded last.`
                  : `Reconnecting to ${daemon.name}…`
            }
            onAction={props.onReconnect}
            testID="home-connection"
            tone={
              daemon.state === 'reconnecting' || daemon.state === 'connecting' ? 'info' : 'danger'
            }
          />
        </View>
      ) : null}
      {props.error && daemon?.state === 'connected' ? (
        <View style={styles.banner}>
          <Banner
            actionLabel="Dismiss"
            message={props.error}
            onAction={props.onDismissError}
            testID="app-error"
          />
        </View>
      ) : null}
      {tab === 'bots' ? <BotsTab {...props} /> : null}
      {tab === 'groups' ? <GroupsTab {...props} /> : null}
      {tab === 'daemon' ? <DaemonTab {...props} /> : null}
      {keyboard && tab === 'groups' ? null : (
        <TabBar
          items={[
            {
              badge: needYou,
              icon: 'happy-outline',
              iconSelected: 'happy',
              key: 'bots',
              label: 'Bots'
            },
            {
              icon: 'people-outline',
              iconSelected: 'people',
              key: 'groups',
              label: 'Groups'
            },
            { icon: 'desktop-outline', iconSelected: 'desktop', key: 'daemon', label: 'Daemon' }
          ]}
          onChange={onTabChange}
          selected={tab}
          testID="home-tabs"
        />
      )}
    </Screen>
  )
}

/** The daemon's name as a small glass pill; tap to switch daemons. */
function DaemonPill({ daemon, onPress }: { daemon: DaemonOverview | null; onPress: () => void }) {
  const theme = useTheme()
  const color =
    daemon?.state === 'connected'
      ? theme.success
      : daemon?.state === 'connecting' || daemon?.state === 'reconnecting'
        ? theme.warning
        : theme.danger

  return (
    <Pressable
      accessibilityHint="Switch to another daemon"
      accessibilityLabel={daemon ? `${daemon.name}, ${STATE[daemon.state]}` : 'Choose a daemon'}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.pillPress, { opacity: pressed ? 0.6 : 1 }]}
      testID="daemon-pill"
    >
      <Glass interactive radius={22} style={styles.pill}>
        <View
          style={[styles.dot, { backgroundColor: daemon?.via === 'demo' ? theme.warning : color }]}
        />
        <Text numberOfLines={1} style={styles.pillText} variant="subhead">
          {daemon?.name ?? 'No daemon'}
        </Text>
        <Ionicons color={theme.muted} name="chevron-expand" size={14} />
      </Glass>
    </Pressable>
  )
}

function BotsTab({
  bots,
  daemon,
  loading,
  onBotLongPress,
  onNewBot,
  onOpenBot,
  onRefresh,
  onSwitchDaemon,
  refreshing
}: HomeScreenProps) {
  const [query, setQuery] = useState('')
  const bottom = useTabBarInset()
  const visible = useMemo(
    () =>
      bots
        .filter(bot =>
          matches(query, bot.name, bot.title, bot.description, bot.preview, bot.latestThread)
        )
        .sort(
          (a, b) =>
            (PINNED[a.status ?? ''] ?? 9) - (PINNED[b.status ?? ''] ?? 9) ||
            (b.updatedAt ?? 0) - (a.updatedAt ?? 0)
        ),
    [bots, query]
  )

  return (
    <FlatList
      ListEmptyComponent={
        loading ? undefined : query ? (
          <EmptyState
            message="Try a name, a role or something a bot said."
            testID="bots-no-results"
            title={`No bots match "${query}"`}
          />
        ) : (
          <EmptyState
            action={
              onNewBot ? (
                <Button label="Create a bot" onPress={onNewBot} testID="bots-empty-create" />
              ) : null
            }
            face={{ name: 'Hexbot' }}
            message="A bot has its own face, model, skills and memory."
            testID="bots-empty"
            title="No bots yet"
          />
        )
      }
      ListHeaderComponent={
        <View style={styles.header}>
          <View style={styles.topRow}>
            <DaemonPill daemon={daemon} onPress={onSwitchDaemon} />
            {onNewBot ? (
              <IconButton
                accessibilityLabel="New bot"
                icon="add"
                onPress={onNewBot}
                testID="bots-new"
                variant="glass"
              />
            ) : null}
          </View>
          <Text accessibilityRole="header" style={styles.largeTitle} variant="largeTitle">
            Bots
          </Text>
          {bots.length > 3 ? (
            <View style={styles.search}>
              <SearchField
                onChangeText={setQuery}
                placeholder="Search bots and threads"
                testID="bots-search"
                value={query}
              />
            </View>
          ) : null}
        </View>
      }
      contentContainerStyle={{ paddingBottom: bottom }}
      data={visible}
      keyExtractor={bot => bot.id}
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
      refreshControl={
        onRefresh ? <RefreshControl onRefresh={onRefresh} refreshing={!!refreshing} /> : undefined
      }
      renderItem={({ item }) => (
        <BotPost bot={item} onLongPress={onBotLongPress} onPress={onOpenBot} />
      )}
      testID="bots-list"
    />
  )
}

/**
 * A bot as a post: face, name and role, what it is for, and a quote from
 * its latest thread. The whole post opens the bot's threads.
 */
function BotPost({
  bot,
  onLongPress,
  onPress
}: {
  bot: BotSummary
  onPress: (id: string) => void
  onLongPress?: (id: string) => void
}) {
  const theme = useTheme()
  const tint = resolveFace(bot.face ?? faceForName(bot.name)).color.value
  const status = bot.status && bot.status !== 'idle' && bot.status !== 'done' ? bot.status : null
  const statusColor =
    status === 'working' ? theme.info : status === 'needs_you' ? theme.accent : theme.danger
  const threads = bot.threadCount ?? 0

  return (
    <Pressable
      accessibilityHint="Opens this bot's threads"
      accessibilityLabel={[
        bot.name,
        bot.title,
        bot.description,
        status ? STATUS_LABELS[status] : null
      ]
        .filter(Boolean)
        .join(', ')}
      accessibilityRole="button"
      delayLongPress={350}
      onLongPress={onLongPress ? () => onLongPress(bot.id) : undefined}
      onPress={() => onPress(bot.id)}
      style={({ pressed }) => [
        styles.post,
        { backgroundColor: pressed ? theme.pressed : theme.background, borderColor: theme.hairline }
      ]}
      testID={`bot-row-${bot.id}`}
    >
      <BotFace {...bot} size={52} status={bot.status} />
      <View style={styles.postBody}>
        <View style={styles.postHead}>
          <Text numberOfLines={1} style={styles.postName} variant="headline">
            {bot.name}
          </Text>
          {bot.updatedAt ? (
            <Text tone="muted" variant="footnote">
              {formatListTime(bot.updatedAt)}
            </Text>
          ) : null}
        </View>
        {bot.title ? (
          <Text numberOfLines={1} tone="muted" variant="footnote">
            {bot.title}
          </Text>
        ) : null}
        <Text numberOfLines={3} style={styles.postText} variant="callout">
          {bot.description || 'No description yet. Add one in its profile.'}
        </Text>
        {bot.preview ? (
          <View
            style={[
              styles.quote,
              { backgroundColor: theme.fill, borderLeftColor: withAlpha(tint, 0.9) }
            ]}
          >
            {bot.latestThread ? (
              <Text numberOfLines={1} variant="footnote" style={styles.quoteTitle}>
                {bot.latestThread}
              </Text>
            ) : null}
            <Text numberOfLines={2} tone="muted" variant="footnote">
              {bot.preview}
            </Text>
          </View>
        ) : null}
        {status || threads > 0 ? (
          <View style={styles.postFoot}>
            {status ? (
              <View style={[styles.chip, { backgroundColor: withAlpha(statusColor, 0.12) }]}>
                <View style={[styles.dot, { backgroundColor: statusColor }]} />
                <Text
                  numberOfLines={1}
                  style={[styles.chipText, { color: statusColor }]}
                  variant="caption"
                >
                  {bot.activity && status === 'working' ? bot.activity : STATUS_LABELS[status]}
                </Text>
              </View>
            ) : null}
            <Text style={styles.threads} tone="muted" variant="caption">
              {threads === 1 ? '1 thread' : threads > 0 ? `${threads} threads` : ''}
            </Text>
          </View>
        ) : null}
      </View>
    </Pressable>
  )
}

function GroupsTab({
  groupChat,
  groupId,
  groups,
  loading,
  onNewGroup,
  onOpenAllGroups,
  onOpenGroupSettings,
  onSelectGroup
}: HomeScreenProps) {
  const theme = useTheme()
  const active = groups
    .filter(group => !group.archived || group.id === groupId)
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  const archived = groups.filter(group => group.archived).length
  const current = groups.find(group => group.id === groupId)

  return (
    <View style={styles.fill} testID="groups-view">
      <View style={styles.groupsHead}>
        <View style={styles.groupsTitle}>
          <Text accessibilityRole="header" style={styles.fill} variant="title">
            {current?.name ?? 'Groups'}
          </Text>
          {current && onOpenGroupSettings ? (
            <IconButton
              accessibilityLabel={`${current.name} members and settings`}
              icon="people-outline"
              iconSize={22}
              onPress={() => onOpenGroupSettings(current.id)}
              testID="group-settings"
              variant="glass"
            />
          ) : null}
          {onNewGroup ? (
            <IconButton
              accessibilityLabel="New group"
              icon="add"
              onPress={onNewGroup}
              testID="groups-new"
              variant="glass"
            />
          ) : null}
        </View>
        {current ? (
          <Text numberOfLines={1} tone="muted" variant="footnote">
            {[
              current.members.map(member => member.name).join(', ') || 'No bots yet',
              current.people && current.people > 1 ? `${current.people} people` : 'you'
            ].join(' and ')}
          </Text>
        ) : null}
        {active.length > 1 || archived > 0 ? (
          <ScrollView
            accessibilityRole="tablist"
            contentContainerStyle={styles.chips}
            horizontal
            showsHorizontalScrollIndicator={false}
            testID="group-chips"
          >
            {active.map(group => {
              const selected = group.id === groupId
              return (
                <Pressable
                  accessibilityLabel={group.name}
                  accessibilityRole="tab"
                  accessibilityState={{ selected }}
                  key={group.id}
                  onPress={() => onSelectGroup(group.id)}
                  style={({ pressed }) => [
                    styles.groupChip,
                    {
                      backgroundColor: selected ? theme.ink : theme.fill,
                      opacity: pressed ? 0.7 : 1
                    }
                  ]}
                  testID={`group-chip-${group.id}`}
                >
                  <RoomFace members={group.members} name={group.name} size={24} />
                  <Text
                    maxFontSizeMultiplier={1.3}
                    numberOfLines={1}
                    style={{ color: selected ? theme.onInk : theme.text }}
                    variant="subhead"
                  >
                    {group.name}
                  </Text>
                </Pressable>
              )
            })}
            {archived > 0 && onOpenAllGroups ? (
              <Pressable
                accessibilityRole="button"
                onPress={onOpenAllGroups}
                style={({ pressed }) => [
                  styles.groupChip,
                  { borderColor: theme.hairline, borderWidth: 1, opacity: pressed ? 0.7 : 1 }
                ]}
                testID="groups-archived"
              >
                <Ionicons color={theme.muted} name="archive-outline" size={16} />
                <Text tone="muted" variant="subhead">
                  Archived ({archived})
                </Text>
              </Pressable>
            ) : null}
          </ScrollView>
        ) : null}
      </View>
      <View style={[styles.rule, { backgroundColor: theme.hairline }]} />
      {current ? (
        groupChat
      ) : loading ? null : (
        <EmptyState
          action={
            onNewGroup ? (
              <Button label="Start a group" onPress={onNewGroup} testID="groups-empty-create" />
            ) : null
          }
          face={{ face: { color: 'teal', shape: 'cloud' }, name: 'Group' }}
          message="A group is one chat with you, other people and any number of bots."
          testID="groups-empty"
          title="No groups yet"
        />
      )}
    </View>
  )
}

function DaemonTab({
  areas,
  bots,
  daemon,
  onDisconnect,
  onOpenArea,
  onOpenBot,
  onOpenPulse,
  onPairAgain,
  onReconnect,
  onRefresh,
  onSwitchDaemon,
  refreshing,
  user
}: HomeScreenProps) {
  const theme = useTheme()
  const bottom = useTabBarInset()
  const { width } = useWindowDimensions()
  const tile = (Math.min(width, 520) - 32 - 20) / 3
  const busy = bots
    .filter(bot => bot.status && PINNED[bot.status] !== undefined)
    .sort((a, b) => PINNED[a.status!]! - PINNED[b.status!]!)
  const via =
    daemon?.via === 'connect'
      ? 'through Hex Connect'
      : daemon?.via === 'demo'
        ? 'Sample bots on this phone'
        : 'on the local network'

  return (
    <ScrollView
      contentContainerStyle={[styles.daemon, { paddingBottom: bottom }]}
      refreshControl={
        onRefresh ? <RefreshControl onRefresh={onRefresh} refreshing={!!refreshing} /> : undefined
      }
      testID="daemons-list"
    >
      <View style={[styles.island, { backgroundColor: theme.surface }]} testID="daemon-current">
        <View style={[styles.islandGlyph, { backgroundColor: theme.fill }]}>
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
                styles.islandDot,
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
        <View style={styles.islandText}>
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
      </View>

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
        <View style={styles.pulse} testID="daemon-pulse">
          <Text
            accessibilityRole="header"
            style={styles.groupTitle}
            tone="muted"
            variant="footnote"
          >
            Right now
          </Text>
          {busy.length ? (
            busy.slice(0, 5).map(bot => {
              const color =
                bot.status === 'needs_you'
                  ? theme.accent
                  : bot.status === 'stopped'
                    ? theme.danger
                    : theme.info
              return (
                <Pressable
                  accessibilityRole="button"
                  key={bot.id}
                  onPress={() => (onOpenPulse ?? onOpenBot)(bot.id)}
                  style={({ pressed }) => [
                    styles.pulseRow,
                    {
                      backgroundColor: pressed ? theme.pressed : theme.surface,
                      borderColor:
                        bot.status === 'needs_you' ? withAlpha(color, 0.5) : 'transparent'
                    }
                  ]}
                  testID={`pulse-${bot.id}`}
                >
                  <BotFace {...bot} size={30} />
                  <Text numberOfLines={2} style={styles.fill} variant="callout">
                    {bot.name}: {bot.activity || STATUS_LABELS[bot.status!]}
                  </Text>
                  <View style={[styles.pulseTag, { backgroundColor: withAlpha(color, 0.14) }]}>
                    <Text style={{ color }} variant="caption">
                      {bot.status === 'needs_you' ? 'Review' : 'Open'}
                    </Text>
                  </View>
                </Pressable>
              )
            })
          ) : (
            <View style={[styles.pulseRow, { backgroundColor: theme.surface }]}>
              <Ionicons color={theme.success} name="checkmark-circle" size={20} />
              <Text tone="muted" variant="callout">
                Every bot is idle.
              </Text>
            </View>
          )}
        </View>
      ) : null}

      {areas.length ? (
        <View style={styles.tiles} testID="daemon-areas">
          {areas.map(area => (
            <Pressable
              accessibilityLabel={area.detail ? `${area.label}, ${area.detail}` : area.label}
              accessibilityRole="button"
              key={area.key}
              onPress={() => onOpenArea(area.key)}
              style={({ pressed }) => [
                styles.tile,
                {
                  backgroundColor: area.prominent ? theme.accent : theme.surface,
                  minHeight: Math.max(tile * 0.92, 96),
                  opacity: pressed ? 0.7 : 1,
                  width: tile
                }
              ]}
              testID={`daemon-${area.key}`}
            >
              <Ionicons
                color={area.prominent ? theme.onAccent : theme.text}
                name={area.icon}
                size={22}
              />
              <View>
                <Text
                  maxFontSizeMultiplier={1.3}
                  numberOfLines={2}
                  style={area.prominent ? { color: theme.onAccent } : null}
                  variant="subhead"
                >
                  {area.label}
                </Text>
                {area.detail ? (
                  <Text
                    maxFontSizeMultiplier={1.3}
                    numberOfLines={1}
                    style={area.prominent ? { color: theme.onAccent } : null}
                    tone="muted"
                    variant="caption"
                  >
                    {area.detail}
                  </Text>
                ) : null}
              </View>
            </Pressable>
          ))}
        </View>
      ) : null}

      {user || onDisconnect ? (
        <View style={styles.footer}>
          <Text numberOfLines={1} style={styles.fill} tone="muted" variant="footnote">
            {user ? `Signed in as ${user.name}, ${user.role}` : ''}
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
  )
}

const styles = StyleSheet.create({
  banner: { paddingBottom: 4, paddingHorizontal: 16, paddingTop: 8 },
  chip: {
    alignItems: 'center',
    borderRadius: 999,
    flexDirection: 'row',
    flexShrink: 1,
    gap: 6,
    paddingHorizontal: 9,
    paddingVertical: 3
  },
  chipText: { flexShrink: 1 },
  chips: { gap: 8, paddingRight: 16 },
  daemon: { gap: 18, paddingHorizontal: 16, paddingTop: 12 },
  dot: { borderRadius: 4, height: 8, width: 8 },
  fill: { flex: 1 },
  footer: { alignItems: 'center', flexDirection: 'row', gap: 8, paddingHorizontal: 4 },
  footerButton: { marginRight: -8 },
  groupChip: {
    alignItems: 'center',
    borderRadius: 999,
    flexDirection: 'row',
    gap: 8,
    maxWidth: 220,
    minHeight: HIT,
    paddingLeft: 8,
    paddingRight: 14
  },
  groupTitle: { paddingHorizontal: 4 },
  groupsHead: { gap: 8, paddingBottom: 10, paddingHorizontal: 16, paddingTop: 4 },
  groupsTitle: { alignItems: 'center', flexDirection: 'row', gap: 8, minHeight: HIT + 4 },
  header: { gap: 8, paddingBottom: 6 },
  island: {
    alignItems: 'center',
    borderRadius: radius.panel + 4,
    flexDirection: 'row',
    gap: 14,
    padding: 16
  },
  islandDot: {
    borderRadius: 7,
    borderWidth: 2,
    bottom: -2,
    height: 14,
    position: 'absolute',
    right: -2,
    width: 14
  },
  islandGlyph: {
    alignItems: 'center',
    borderRadius: 18,
    height: 56,
    justifyContent: 'center',
    width: 56
  },
  islandText: { flex: 1, gap: 1 },
  largeTitle: { paddingHorizontal: 20 },
  pill: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    minHeight: HIT,
    paddingHorizontal: 14
  },
  pillPress: { flexShrink: 1, maxWidth: '75%' },
  pillText: { flexShrink: 1 },
  post: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14
  },
  postBody: { flex: 1, gap: 3, minWidth: 0 },
  postFoot: { alignItems: 'center', flexDirection: 'row', gap: 8, marginTop: 6 },
  postHead: { alignItems: 'baseline', flexDirection: 'row', gap: 8 },
  postName: { flex: 1 },
  postText: { marginTop: 2 },
  pulse: { gap: 8 },
  pulseRow: {
    alignItems: 'center',
    borderRadius: radius.card,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 12,
    minHeight: 56,
    paddingHorizontal: 14,
    paddingVertical: 10
  },
  pulseTag: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  quote: {
    borderBottomRightRadius: 12,
    borderLeftWidth: 3,
    borderTopRightRadius: 12,
    gap: 1,
    marginTop: 8,
    paddingHorizontal: 10,
    paddingVertical: 7
  },
  quoteTitle: { fontWeight: '600' },
  rule: { height: StyleSheet.hairlineWidth },
  search: { paddingBottom: 4, paddingHorizontal: 16 },
  threads: { marginLeft: 'auto' },
  tile: {
    borderRadius: 20,
    justifyContent: 'space-between',
    padding: 12
  },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  topRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 4
  }
})
