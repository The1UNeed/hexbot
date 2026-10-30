import { useMemo, useState } from 'react'
import {
  FlatList,
  Modal,
  Pressable,
  RefreshControl,
  StyleSheet,
  TextInput,
  View
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import {
  Banner,
  BotFace,
  Button,
  EmptyState,
  formatListTime,
  Glass,
  HIT,
  IconButton,
  PersonFace,
  RoomFace,
  Screen,
  Text,
  useKeyboardVisible,
  useTheme
} from '../ui'
import type { BotSummary, ConnectionState, ConversationSummary, DaemonOverview } from './types'

export interface HomeScreenProps {
  error?: string | null
  onDismissError?: () => void

  /** Bot chats, rooms and Check-ins, in any order; the list sorts them. */
  conversations: ConversationSummary[]
  onOpen: (conversation: ConversationSummary) => void
  /** Long press, such as opening the bot's profile or the room's settings. */
  onLongPress?: (conversation: ConversationSummary) => void
  /** Bots waiting on you in a conversation between bots, which has no row of its own. */
  waiting?: BotSummary[]
  onOpenPulse?: (id: string) => void

  onNewBot?: () => void
  onNewRoom?: () => void
  /**
   * Set while a daemon upgraded from before the primary bot has none. Add
   * creates HexBot; without it, the user promotes a bot from its profile.
   */
  primaryChoice?: { onAdd?: () => void } | null

  daemon: DaemonOverview | null
  /** Signed-in person on this daemon; their initials open Settings. */
  user?: { name: string } | null
  onOpenSettings: () => void
  /** Every bot and scheduled job, behind the grid button. */
  onOpenLibrary?: () => void
  /** Set when there is another daemon to switch to; the header names this one. */
  onSwitchDaemon?: () => void
  onReconnect?: () => void

  refreshing?: boolean
  onRefresh?: () => void
  /** First load: the list is empty because nothing has arrived yet. */
  loading?: boolean
}

const STATE: Record<ConnectionState, string> = {
  connected: 'Connected',
  connecting: 'Connecting',
  offline: 'Offline',
  reconnecting: 'Reconnecting',
  unauthorized: 'Signed out'
}

const matches = (query: string, c: ConversationSummary) => {
  const needle = query.trim().toLowerCase()

  return (
    !needle ||
    [c.name, c.preview, ...(c.members ?? []).map(m => m.name)].some(field =>
      field?.toLowerCase().includes(needle)
    )
  )
}

/**
 * Your conversations, like a messaging app: every bot's chat, every room and
 * Check-ins in one list, newest first. Settings sit behind your initials, new
 * bots and rooms behind +, and every bot and job behind the grid button.
 */
export function HomeScreen(props: HomeScreenProps) {
  const { conversations, daemon, onRefresh, refreshing } = props
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const keyboard = useKeyboardVisible()
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const shown = useMemo(
    () =>
      conversations
        .filter(c => matches(query, c))
        .sort(
          (a, b) =>
            Number(!!b.primary) - Number(!!a.primary) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0)
        ),
    [conversations, query]
  )
  const canCreate = !!(props.onNewBot || props.onNewRoom)

  return (
    <Screen avoidKeyboard testID="home-screen">
      <View style={styles.header}>
        <AccountButton daemon={daemon} onPress={props.onOpenSettings} user={props.user} />
        <View style={styles.headerCenter}>
          {props.onSwitchDaemon && daemon ? (
            <Pressable
              accessibilityHint="Switch to another daemon"
              accessibilityLabel={`${daemon.name}, ${STATE[daemon.state]}`}
              accessibilityRole="button"
              hitSlop={8}
              onPress={props.onSwitchDaemon}
              style={({ pressed }) => [styles.daemonName, { opacity: pressed ? 0.6 : 1 }]}
              testID="daemon-pill"
            >
              <Text numberOfLines={1} style={styles.shrink} tone="muted" variant="subhead">
                {daemon.name}
              </Text>
              <Ionicons color={theme.muted} name="chevron-expand" size={14} />
            </Pressable>
          ) : null}
        </View>
        {canCreate ? (
          <IconButton
            accessibilityLabel="New bot or room"
            icon="add"
            iconSize={26}
            onPress={() => setCreating(true)}
            testID="home-new"
            variant="glass"
          />
        ) : (
          <View style={styles.headerSpacer} />
        )}
      </View>

      {daemon && daemon.state !== 'connected' ? (
        <View style={styles.banner}>
          <Banner
            actionLabel={props.onReconnect && daemon.state === 'offline' ? 'Try again' : undefined}
            message={
              daemon.state === 'unauthorized'
                ? `${daemon.name} no longer accepts this device. Pair again in Settings.`
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

      <FlatList
        ListEmptyComponent={<Empty {...props} query={query} />}
        ListHeaderComponent={
          <>
            {props.primaryChoice && conversations.length ? (
              <View style={styles.banner}>
                <Banner
                  actionLabel={props.primaryChoice.onAdd ? 'Add HexBot' : undefined}
                  message={`It sets up and looks after your other bots, rooms, scheduled jobs and settings. ${
                    props.primaryChoice.onAdd ? 'Add HexBot, or open' : 'Open'
                  } a bot's profile and choose Make primary.`}
                  onAction={props.primaryChoice.onAdd}
                  testID="home-primary-choice"
                  title="Choose a primary bot"
                  tone="info"
                />
              </View>
            ) : null}
            {query ? null : <WaitingStrip bots={props.waiting ?? []} onOpen={props.onOpenPulse} />}
          </>
        }
        contentContainerStyle={styles.list}
        data={shown}
        keyExtractor={c => `${c.kind}-${c.id}`}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        refreshControl={
          onRefresh ? <RefreshControl onRefresh={onRefresh} refreshing={!!refreshing} /> : undefined
        }
        renderItem={({ item }) => (
          <ConversationRow
            conversation={item}
            onLongPress={props.onLongPress}
            onPress={props.onOpen}
          />
        )}
        style={styles.fill}
        testID="home-list"
      />

      <View style={[styles.dock, { paddingBottom: keyboard ? 8 : Math.max(insets.bottom, 10) }]}>
        {props.onOpenLibrary ? (
          <IconButton
            accessibilityLabel="Bots and jobs"
            icon="grid-outline"
            iconSize={22}
            onPress={props.onOpenLibrary}
            size={52}
            testID="home-library"
            variant="glass"
          />
        ) : null}
        <Glass radius={26} style={styles.search}>
          <Ionicons color={theme.muted} name="search" size={20} />
          <TextInput
            accessibilityLabel="Search"
            autoCapitalize="none"
            autoCorrect={false}
            maxFontSizeMultiplier={1.4}
            onChangeText={setQuery}
            placeholder="Search"
            placeholderTextColor={theme.muted}
            returnKeyType="search"
            selectionColor={theme.accent}
            style={[styles.searchInput, { color: theme.text }]}
            testID="home-search"
            value={query}
          />
          {query ? (
            <IconButton
              accessibilityLabel="Clear search"
              color={theme.muted}
              icon="close-circle"
              iconSize={18}
              onPress={() => setQuery('')}
              size={32}
              testID="home-search-clear"
            />
          ) : null}
        </Glass>
      </View>

      <NewMenu
        onClose={() => setCreating(false)}
        onNewBot={props.onNewBot}
        onNewRoom={props.onNewRoom}
        visible={creating}
      />
    </Screen>
  )
}

/** What + makes, as a small menu under the button. */
function NewMenu({
  onClose,
  onNewBot,
  onNewRoom,
  visible
}: {
  visible: boolean
  onClose: () => void
  onNewBot?: () => void
  onNewRoom?: () => void
}) {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const items = [
    onNewBot ? { icon: 'happy-outline', key: 'bot', label: 'New bot', run: onNewBot } : null,
    onNewRoom ? { icon: 'people-outline', key: 'room', label: 'New room', run: onNewRoom } : null
  ].filter(item => item !== null)

  return (
    <Modal
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
      transparent
      visible={visible}
    >
      <Pressable
        accessibilityLabel="Close menu"
        onPress={onClose}
        style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.08)' }]}
        testID="home-new-backdrop"
      />
      <View
        style={[
          styles.menu,
          {
            backgroundColor: theme.surface,
            borderColor: theme.chromeBorder,
            top: insets.top + HIT + 14
          }
        ]}
        testID="home-new-menu"
      >
        {items.map((item, index) => (
          <Pressable
            accessibilityRole="menuitem"
            key={item.key}
            onPress={() => {
              onClose()
              item.run()
            }}
            style={({ pressed }) => [
              styles.menuItem,
              index > 0 && {
                borderTopColor: theme.hairline,
                borderTopWidth: StyleSheet.hairlineWidth
              },
              { backgroundColor: pressed ? theme.pressed : 'transparent' }
            ]}
            testID={`home-new-${item.key}`}
          >
            <Text style={styles.fill} variant="body">
              {item.label}
            </Text>
            <Ionicons color={theme.text} name={item.icon as 'happy-outline'} size={20} />
          </Pressable>
        ))}
      </View>
    </Modal>
  )
}

/** Your initials, with a dot for the connection; opens Settings. */
function AccountButton({
  daemon,
  onPress,
  user
}: {
  daemon: DaemonOverview | null
  user?: { name: string } | null
  onPress: () => void
}) {
  const theme = useTheme()
  const dot =
    daemon?.via === 'demo'
      ? theme.warning
      : daemon?.state === 'connected'
        ? theme.success
        : daemon?.state === 'connecting' || daemon?.state === 'reconnecting'
          ? theme.warning
          : theme.danger

  return (
    <Pressable
      accessibilityLabel={`Settings${daemon ? `, ${daemon.name} ${STATE[daemon.state].toLowerCase()}` : ''}`}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
      testID="home-settings"
    >
      <Glass interactive radius={HIT / 2} style={styles.account}>
        {user?.name ? (
          <PersonFace name={user.name} size={HIT - 6} />
        ) : (
          <Ionicons color={theme.text} name="person" size={20} />
        )}
      </Glass>
      <View style={[styles.accountDot, { backgroundColor: dot, borderColor: theme.background }]} />
    </Pressable>
  )
}

/** One conversation: face, name, time, and the last thing said or what is happening. */
function ConversationRow({
  conversation: c,
  onLongPress,
  onPress
}: {
  conversation: ConversationSummary
  onPress: (c: ConversationSummary) => void
  onLongPress?: (c: ConversationSummary) => void
}) {
  const theme = useTheme()
  const live =
    c.status === 'working'
      ? { color: theme.info, text: c.activity || 'Working…' }
      : c.status === 'needs_you'
        ? { color: theme.accent, text: 'Waiting for you' }
        : c.status === 'stopped'
          ? { color: theme.danger, text: 'Stopped' }
          : null
  const line = live?.text ?? c.preview ?? (c.kind === 'room' ? roomLine(c) : null)
  const time = formatListTime(c.updatedAt)

  return (
    <Pressable
      accessibilityHint={c.kind === 'room' ? 'Opens the room' : 'Opens the conversation'}
      accessibilityLabel={[c.name, line, time].filter(Boolean).join(', ')}
      accessibilityRole="button"
      delayLongPress={350}
      onLongPress={onLongPress ? () => onLongPress(c) : undefined}
      onPress={() => onPress(c)}
      style={({ pressed }) => [
        styles.row,
        { backgroundColor: pressed ? theme.pressed : 'transparent' }
      ]}
      testID={`${c.kind === 'bot' ? 'bot' : c.kind}-row-${c.id}`}
    >
      {c.kind === 'room' ? (
        <RoomFace members={c.members ?? []} name={c.name} size={54} status={c.status} />
      ) : (
        <BotFace {...(c.face ?? { name: c.name })} size={54} status={c.status} />
      )}
      <View style={styles.rowBody}>
        <View style={styles.rowHead}>
          <Text numberOfLines={1} style={styles.rowName} variant="body">
            {c.name}
          </Text>
          {time ? (
            <Text style={{ color: theme.faint }} variant="footnote">
              {time}
            </Text>
          ) : null}
        </View>
        {line ? (
          <Text
            numberOfLines={1}
            style={live ? { color: live.color } : null}
            tone="muted"
            variant="callout"
          >
            {line.replace(/\s+/g, ' ')}
          </Text>
        ) : null}
      </View>
    </Pressable>
  )
}

const roomLine = (c: ConversationSummary) => {
  const names = (c.members ?? []).map(m => m.name)

  return names.length ? `${names.join(', ')} and you` : 'No bots yet'
}

/** Bots waiting on you in a conversation between bots; each opens where it waits. */
function WaitingStrip({ bots, onOpen }: { bots: BotSummary[]; onOpen?: (id: string) => void }) {
  const theme = useTheme()

  if (!bots.length || !onOpen) {
    return null
  }

  return (
    <View style={styles.waiting} testID="home-waiting">
      {bots.map(bot => (
        <Pressable
          accessibilityRole="button"
          key={bot.id}
          onPress={() => onOpen(bot.id)}
          style={({ pressed }) => [
            styles.waitingRow,
            { backgroundColor: pressed ? theme.pressed : theme.fill }
          ]}
          testID={`pulse-${bot.id}`}
        >
          <BotFace {...bot} size={26} />
          <Text numberOfLines={1} style={styles.fill} variant="callout">
            {`${bot.name} is waiting for you`}
          </Text>
          <Text style={{ color: theme.accent }} variant="subhead">
            Review
          </Text>
        </Pressable>
      ))}
    </View>
  )
}

function Empty({
  conversations,
  loading,
  onNewBot,
  primaryChoice,
  query
}: HomeScreenProps & { query: string }) {
  if (loading) {
    return null
  }

  if (query) {
    return (
      <EmptyState
        message="Try a name or something that was said."
        testID="home-no-results"
        title={`Nothing matches "${query}"`}
      />
    )
  }

  if (conversations.length) {
    return null
  }

  return (
    <EmptyState
      action={
        primaryChoice?.onAdd ? (
          <Button label="Add HexBot" onPress={primaryChoice.onAdd} testID="home-empty-primary" />
        ) : onNewBot ? (
          <Button label="Create a bot" onPress={onNewBot} testID="home-empty-create" />
        ) : null
      }
      face={{ name: 'Hexbot' }}
      message={
        primaryChoice?.onAdd
          ? 'HexBot is your primary bot. It sets up and looks after the rest.'
          : 'A bot has its own face, model, skills and memory.'
      }
      testID="home-empty"
      title="No bots yet"
    />
  )
}

const styles = StyleSheet.create({
  account: { alignItems: 'center', height: HIT, justifyContent: 'center', width: HIT },
  accountDot: {
    borderRadius: 6,
    borderWidth: 2,
    bottom: 0,
    height: 12,
    position: 'absolute',
    right: 0,
    width: 12
  },
  banner: { paddingBottom: 4, paddingHorizontal: 16, paddingTop: 4 },
  daemonName: { alignItems: 'center', flexDirection: 'row', gap: 4, maxWidth: '100%' },
  dock: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 8
  },
  fill: { flex: 1 },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    minHeight: HIT + 16,
    paddingHorizontal: 16
  },
  headerCenter: { alignItems: 'center', flex: 1, minWidth: 0 },
  headerSpacer: { width: HIT },
  list: { flexGrow: 1, paddingBottom: 12, paddingTop: 6 },
  menu: {
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    elevation: 16,
    minWidth: 220,
    overflow: 'hidden',
    position: 'absolute',
    right: 16,
    shadowColor: '#000',
    shadowOffset: { height: 10, width: 0 },
    shadowOpacity: 0.18,
    shadowRadius: 28
  },
  menuItem: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 16,
    minHeight: HIT + 4,
    paddingHorizontal: 16
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 14,
    minHeight: 76,
    paddingHorizontal: 16,
    paddingVertical: 10
  },
  rowBody: { flex: 1, gap: 3, minWidth: 0 },
  rowHead: { alignItems: 'baseline', flexDirection: 'row', gap: 8 },
  rowName: { flex: 1, fontWeight: '500' },
  search: {
    alignItems: 'center',
    flex: 1,
    flexDirection: 'row',
    gap: 8,
    height: 52,
    paddingLeft: 18,
    paddingRight: 8
  },
  searchInput: { flex: 1, fontSize: 17, height: 52 },
  shrink: { flexShrink: 1 },
  waiting: { gap: 8, paddingBottom: 6, paddingHorizontal: 16 },
  waitingRow: {
    alignItems: 'center',
    borderRadius: 16,
    flexDirection: 'row',
    gap: 10,
    minHeight: HIT,
    paddingHorizontal: 12
  }
})
