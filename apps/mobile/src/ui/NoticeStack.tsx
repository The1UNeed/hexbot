import { Ionicons } from '@expo/vector-icons'
import { useState } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'

import { withAlpha } from './Badge'
import { Button, IconButton } from './Button'
import { Text } from './Text'
import { radius, useTheme } from './theme'

/**
 * Something the chat wants you to know that is not a message, such as a turn
 * that stopped. As the web's `NoticeDock`: notices float above the composer,
 * never in the chat.
 */
export interface Notice {
  id: string
  tone: 'danger' | 'info' | 'warning'
  title: string
  detail?: string
  /** When it happened, in milliseconds. */
  time?: number
  actions?: { label: string; onPress: () => void; primary?: boolean }[]
  onDismiss?: () => void
  testID: string
}

const RANK = { danger: 0, info: 2, warning: 1 } as const

/** Failures first, then what you can act on, then the newest. */
export function sortNotices(notices: Notice[]): Notice[] {
  return [...notices].sort(
    (a, b) =>
      RANK[a.tone] - RANK[b.tone] ||
      (a.actions?.length ? 0 : 1) - (b.actions?.length ? 0 : 1) ||
      (b.time ?? 0) - (a.time ?? 0)
  )
}

const ICONS = { danger: 'alert-circle', info: 'notifications', warning: 'warning' } as const

function clock(time: number | undefined) {
  return time
    ? new Date(time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : null
}

function NoticeCard({
  notice,
  more,
  onMore
}: {
  notice: Notice
  more?: number
  onMore?: () => void
}) {
  const theme = useTheme()
  const color = theme[notice.tone]
  const time = clock(notice.time)

  return (
    <View
      accessibilityLiveRegion="polite"
      accessibilityRole={notice.tone === 'danger' ? 'alert' : undefined}
      style={[
        styles.card,
        {
          backgroundColor: theme.surface,
          borderColor: theme.hairline
        }
      ]}
      testID={notice.testID}
    >
      <View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          { backgroundColor: withAlpha(color, theme.scheme === 'dark' ? 0.16 : 0.06) }
        ]}
      />
      <View style={styles.header}>
        <Ionicons
          color={notice.tone === 'info' ? theme.text : color}
          name={ICONS[notice.tone]}
          size={17}
        />
        <Text numberOfLines={1} style={styles.title} variant="subhead">
          {notice.title}
        </Text>
        {more ? (
          <Pressable
            accessibilityRole="button"
            hitSlop={8}
            onPress={onMore}
            style={[styles.more, { backgroundColor: theme.fill }]}
            testID="notices-more"
          >
            <Text tone="muted" variant="caption">
              {more} more
            </Text>
          </Pressable>
        ) : null}
        {time ? (
          <Text tone="muted" variant="caption">
            {time}
          </Text>
        ) : null}
        {notice.onDismiss ? (
          <IconButton
            accessibilityLabel="Dismiss"
            color={theme.muted}
            icon="close"
            iconSize={17}
            onPress={notice.onDismiss}
            size={28}
            style={styles.dismiss}
            testID={`${notice.testID}-dismiss`}
          />
        ) : null}
      </View>
      {notice.detail ? (
        <Text style={styles.inset} tone="muted" variant="footnote">
          {notice.detail}
        </Text>
      ) : null}
      {notice.actions?.length ? (
        <View style={[styles.inset, styles.actions]}>
          {notice.actions.map(action => (
            <Button
              key={action.label}
              label={action.label}
              onPress={action.onPress}
              size="small"
              testID={`${notice.testID}-action`}
              variant={action.primary ? 'primary' : 'secondary'}
            />
          ))}
        </View>
      ) : null}
    </View>
  )
}

/**
 * The chat's notices above its composer: the most urgent card in front, the
 * others peeking out behind it, all of them on "N more".
 */
export function NoticeStack({ notices }: { notices: Notice[] }) {
  const theme = useTheme()
  const [open, setOpen] = useState(false)
  const [front, ...rest] = sortNotices(notices)

  if (!front) return null

  if (open && rest.length) {
    return (
      <View style={styles.list} testID="notices">
        <Pressable
          accessibilityRole="button"
          hitSlop={8}
          onPress={() => setOpen(false)}
          style={[styles.less, { backgroundColor: theme.fill }]}
          testID="notices-less"
        >
          <Text tone="muted" variant="caption">
            Show less
          </Text>
        </Pressable>
        {[front, ...rest].map(notice => (
          <NoticeCard key={notice.id} notice={notice} />
        ))}
      </View>
    )
  }

  const layers = Math.min(rest.length, 2)

  return (
    <View style={{ paddingTop: layers * 6 }} testID="notices">
      {Array.from({ length: layers }, (_, layer) => (
        <View
          key={layer}
          pointerEvents="none"
          style={[
            styles.layer,
            {
              backgroundColor: theme.surface,
              borderColor: theme.hairline,
              bottom: (layer + 1) * 6,
              left: (layer + 1) * 12,
              right: (layer + 1) * 12,
              top: (layers - layer - 1) * 6
            }
          ]}
        />
      ))}
      <NoticeCard
        key={front.id}
        more={rest.length}
        notice={front}
        onMore={() => setOpen(true)}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingTop: 4 },
  card: {
    borderRadius: radius.card,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 4,
    overflow: 'hidden',
    paddingBottom: 12,
    paddingLeft: 14,
    paddingRight: 8,
    paddingTop: 10
  },
  dismiss: { marginVertical: -4 },
  header: { alignItems: 'center', flexDirection: 'row', gap: 8, minHeight: 24 },
  inset: { paddingLeft: 25, paddingRight: 6 },
  layer: {
    borderRadius: radius.card,
    borderWidth: StyleSheet.hairlineWidth,
    position: 'absolute'
  },
  less: { alignSelf: 'flex-end', borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 4 },
  list: { gap: 6 },
  more: { borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 2 },
  title: { flex: 1 }
})
