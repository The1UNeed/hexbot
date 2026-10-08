import { Ionicons } from '@expo/vector-icons'
import { type ReactNode, useMemo, useState } from 'react'
import { FlatList, Pressable, RefreshControl, StyleSheet, View } from 'react-native'

import {
  Banner,
  BotFace,
  Button,
  formatListTime,
  IconButton,
  Layer,
  radius,
  Screen,
  STATUS_LABELS,
  Text,
  TopBar,
  useTheme
} from '../ui'
import type { BotSummary, SectionSummary } from './types'

export interface ThreadsScreenProps {
  bot: BotSummary
  threads: SectionSummary[]
  onBack: () => void
  onOpenThread: (id: string) => void
  onNewThread?: () => void
  /** Rename, archive, restore or delete one thread. */
  onThreadActions?: (id: string) => void
  onUnarchive?: (id: string) => void
  onOpenProfile?: () => void
  /** The bot's model pill; changes apply to new threads. */
  model?: ReactNode
  creating?: boolean
  refreshing?: boolean
  onRefresh?: () => void
  error?: string | null
  onDismissError?: () => void
}

/**
 * A bot's own page: who it is, a button for a new thread, and every thread
 * you have with it, newest first. Archived threads sit on their own shelf.
 */
export function ThreadsScreen(props: ThreadsScreenProps) {
  const { bot, creating, onBack, onNewThread, onOpenProfile, threads } = props
  const theme = useTheme()
  const [shelf, setShelf] = useState<'active' | 'archived'>('active')
  const archived = threads.filter(t => t.archived).length
  const list = useMemo(
    () =>
      threads
        .filter(t => (shelf === 'archived' ? t.archived : !t.archived))
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)),
    [shelf, threads]
  )

  return (
    <Screen background="grouped" testID="threads-screen">
      <TopBar
        center={
          <Text numberOfLines={1} variant="headline">
            {bot.name}
          </Text>
        }
        onBack={onBack}
        testID="threads-bar"
        trailing={
          onOpenProfile ? (
            <IconButton
              accessibilityLabel={`Edit ${bot.name}`}
              icon="ellipsis-horizontal"
              iconSize={21}
              onPress={onOpenProfile}
              testID="threads-profile"
              variant="glass"
            />
          ) : null
        }
      />
      <FlatList
        ItemSeparatorComponent={() => (
          <View style={[styles.separator, { backgroundColor: theme.hairline }]} />
        )}
        ListEmptyComponent={
          <View style={styles.empty} testID={`threads-empty-${shelf}`}>
            <Text align="center" variant="headline">
              {shelf === 'archived' ? 'Nothing archived' : 'No threads yet'}
            </Text>
            <Text align="center" tone="muted" variant="callout">
              {shelf === 'archived'
                ? 'Archived threads keep their history. Restore one to continue it.'
                : `Each thread is a separate conversation with ${bot.name}. Start one above.`}
            </Text>
          </View>
        }
        ListHeaderComponent={
          <View style={styles.head}>
            {props.error ? (
              <Banner
                actionLabel={props.onDismissError ? 'Dismiss' : undefined}
                message={props.error}
                onAction={props.onDismissError}
                testID="threads-error"
              />
            ) : null}
            <View style={styles.hero}>
              <BotFace {...bot} size={84} />
              <View style={styles.heroText}>
                <Text accessibilityRole="header" align="center" variant="title">
                  {bot.name}
                </Text>
                {bot.title ? (
                  <Text align="center" tone="muted" variant="callout">
                    {bot.title}
                  </Text>
                ) : null}
              </View>
              {bot.description ? (
                <Text align="center" style={styles.description} variant="callout">
                  {bot.description}
                </Text>
              ) : null}
              {bot.status && bot.status !== 'idle' ? (
                <View style={styles.statusLine}>
                  <View style={[styles.dot, { backgroundColor: statusColor(theme, bot.status) }]} />
                  <Text tone="muted" variant="footnote">
                    {bot.activity || STATUS_LABELS[bot.status]}
                  </Text>
                </View>
              ) : null}
            </View>
            <View style={styles.actions}>
              {onNewThread ? (
                <Button
                  busy={creating}
                  busyLabel="Starting…"
                  icon="create-outline"
                  label="New conversation"
                  onPress={onNewThread}
                  testID="threads-new"
                  wide
                />
              ) : null}
              {props.model ? (
                <View style={styles.modelLine}>
                  <Text tone="muted" variant="footnote">
                    New threads use
                  </Text>
                  {props.model}
                </View>
              ) : null}
            </View>
            <View style={styles.shelfBar}>
              <Text accessibilityRole="header" variant="headline">
                {shelf === 'archived' ? 'Archived' : 'Threads'}
              </Text>
              {archived > 0 || shelf === 'archived' ? (
                <Button
                  label={shelf === 'archived' ? 'Show threads' : `Archived (${archived})`}
                  onPress={() => setShelf(shelf === 'archived' ? 'active' : 'archived')}
                  testID="threads-shelf"
                  variant="plain"
                />
              ) : null}
            </View>
          </View>
        }
        contentContainerStyle={styles.content}
        data={list}
        keyExtractor={item => item.id}
        refreshControl={
          props.onRefresh ? (
            <RefreshControl onRefresh={props.onRefresh} refreshing={!!props.refreshing} />
          ) : undefined
        }
        renderItem={({ index, item }) => (
          <ThreadRow
            first={index === 0}
            last={index === list.length - 1}
            onActions={props.onThreadActions}
            onOpen={props.onOpenThread}
            onUnarchive={props.onUnarchive}
            thread={item}
          />
        )}
        testID="threads-list"
      />
    </Screen>
  )
}

function statusColor(theme: ReturnType<typeof useTheme>, status: BotSummary['status']) {
  return status === 'working'
    ? theme.info
    : status === 'needs_you'
      ? theme.accent
      : status === 'stopped'
        ? theme.danger
        : theme.success
}

function ThreadRow({
  first,
  last,
  onActions,
  onOpen,
  onUnarchive,
  thread
}: {
  thread: SectionSummary
  first: boolean
  last: boolean
  onOpen: (id: string) => void
  onActions?: (id: string) => void
  onUnarchive?: (id: string) => void
}) {
  const theme = useTheme()
  const title = thread.title || 'New conversation'
  const count = thread.messageCount ?? 0

  return (
    <View
      style={[
        styles.rowWrap,
        { backgroundColor: theme.surface },
        first && styles.firstRow,
        last && styles.lastRow
      ]}
    >
      <Pressable
        accessibilityHint="Opens this thread"
        accessibilityLabel={[title, thread.preview, formatListTime(thread.updatedAt)]
          .filter(Boolean)
          .join(', ')}
        accessibilityRole="button"
        delayLongPress={350}
        onLongPress={onActions ? () => onActions(thread.id) : undefined}
        onPress={() => onOpen(thread.id)}
        style={({ pressed }) => [
          styles.row,
          { backgroundColor: pressed ? theme.pressed : 'transparent' }
        ]}
        testID={`thread-row-${thread.id}`}
      >
        <View style={styles.rowBody}>
          <View style={styles.rowTitle}>
            {thread.unread || thread.working ? (
              <View
                accessibilityLabel={thread.working ? 'Working' : 'New reply'}
                style={[
                  styles.dot,
                  { backgroundColor: thread.working ? theme.info : theme.accent }
                ]}
              />
            ) : null}
            <Text numberOfLines={1} style={styles.flex} variant="headline">
              {title}
            </Text>
            <Text tone="muted" variant="footnote">
              {formatListTime(thread.updatedAt)}
            </Text>
          </View>
          <Text numberOfLines={2} tone="muted" variant="callout">
            {thread.preview || 'No messages yet'}
          </Text>
          {thread.working || count > 0 ? (
            <Text tone="faint" variant="caption">
              {thread.working ? 'Working now' : count === 1 ? '1 message' : `${count} messages`}
            </Text>
          ) : null}
        </View>
      </Pressable>
      {thread.archived && onUnarchive ? (
        <IconButton
          accessibilityLabel={`Restore ${title}`}
          color={theme.accent}
          icon="arrow-undo-outline"
          iconSize={20}
          onPress={() => onUnarchive(thread.id)}
          testID={`thread-restore-${thread.id}`}
        />
      ) : null}
      {onActions ? (
        <IconButton
          accessibilityLabel={`Options for ${title}`}
          color={theme.muted}
          icon="ellipsis-horizontal"
          iconSize={20}
          onPress={() => onActions(thread.id)}
          testID={`thread-actions-${thread.id}`}
        />
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  actions: { alignItems: 'center', gap: 12 },
  content: { paddingBottom: 48, paddingHorizontal: 16 },
  description: { maxWidth: 340 },
  dot: { borderRadius: 4, height: 8, width: 8 },
  empty: { alignItems: 'center', gap: 6, paddingHorizontal: 24, paddingVertical: 36 },
  firstRow: { borderTopLeftRadius: radius.card, borderTopRightRadius: radius.card },
  flex: { flex: 1 },
  head: { gap: 20, paddingBottom: 10, paddingTop: 4 },
  hero: { alignItems: 'center', gap: 10, paddingHorizontal: 8 },
  heroText: { alignItems: 'center', gap: 2 },
  lastRow: { borderBottomLeftRadius: radius.card, borderBottomRightRadius: radius.card },
  modelLine: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    justifyContent: 'center'
  },
  row: { flex: 1, minHeight: 76, paddingLeft: 16, paddingRight: 4, paddingVertical: 12 },
  rowBody: { gap: 3 },
  rowTitle: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  rowWrap: { alignItems: 'center', flexDirection: 'row', overflow: 'hidden', paddingRight: 4 },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 16 },
  shelfBar: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 4,
    minHeight: 44,
    paddingLeft: 4
  },
  statusLine: { alignItems: 'center', flexDirection: 'row', gap: 6 },
  switchList: { borderRadius: radius.card, overflow: 'hidden' },
  switchNew: {
    alignItems: 'center',
    alignSelf: 'stretch',
    borderRadius: 999,
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'center',
    minHeight: 50
  },
  switchRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
    minHeight: 64,
    paddingHorizontal: 16,
    paddingVertical: 10
  },
  switcher: { gap: 16 }
})

export interface ThreadSwitcherProps {
  visible: boolean
  onClose: () => void
  botName: string
  threads: SectionSummary[]
  currentId?: string | null
  onSelect: (id: string) => void
  onNew?: () => void
  /** Back to the bot's page with every thread and the archive. */
  onShowAll?: () => void
}

/** Jump between a bot's open threads without leaving the chat. */
export function ThreadSwitcher({
  botName,
  currentId,
  onClose,
  onNew,
  onSelect,
  onShowAll,
  threads,
  visible
}: ThreadSwitcherProps) {
  const theme = useTheme()
  const list = threads
    .filter(t => !t.archived || t.id === currentId)
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))

  return (
    <Layer onClose={onClose} testID="sections" title={`Threads with ${botName}`} visible={visible}>
      <View style={styles.switcher}>
        {onNew ? (
          <Pressable
            accessibilityRole="button"
            onPress={onNew}
            style={({ pressed }) => [
              styles.switchNew,
              { backgroundColor: theme.ink, opacity: pressed ? 0.7 : 1 }
            ]}
            testID="sections-new"
          >
            <Ionicons color={theme.onInk} name="create-outline" size={20} />
            <Text style={{ color: theme.onInk }} variant="headline">
              New conversation
            </Text>
          </Pressable>
        ) : null}
        <View style={[styles.switchList, { backgroundColor: theme.surface }]}>
          {list.map((thread, index) => {
            const current = thread.id === currentId
            return (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected: current }}
                key={thread.id}
                onPress={() => onSelect(thread.id)}
                style={({ pressed }) => [
                  styles.switchRow,
                  index > 0 && {
                    borderTopColor: theme.hairline,
                    borderTopWidth: StyleSheet.hairlineWidth
                  },
                  { backgroundColor: pressed ? theme.pressed : 'transparent' }
                ]}
                testID={`sections-row-${thread.id}`}
              >
                <View style={styles.flex}>
                  <View style={styles.rowTitle}>
                    {thread.unread || thread.working ? (
                      <View
                        style={[
                          styles.dot,
                          { backgroundColor: thread.working ? theme.info : theme.accent }
                        ]}
                      />
                    ) : null}
                    <Text numberOfLines={1} style={styles.flex} variant="headline">
                      {thread.title || 'New conversation'}
                    </Text>
                    <Text tone="muted" variant="footnote">
                      {formatListTime(thread.updatedAt)}
                    </Text>
                  </View>
                  <Text numberOfLines={1} tone="muted" variant="callout">
                    {thread.preview || 'No messages yet'}
                  </Text>
                </View>
                {current ? <Ionicons color={theme.accent} name="checkmark" size={20} /> : null}
              </Pressable>
            )
          })}
        </View>
        {onShowAll ? (
          <Button
            label="All threads and archive"
            onPress={onShowAll}
            testID="sections-all"
            variant="plain"
          />
        ) : null}
      </View>
    </Layer>
  )
}
