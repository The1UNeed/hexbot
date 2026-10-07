/**
 * The floating chrome around a transcript: the title pill in the header,
 * the pills pinned under it ("Waiting on you", "Archived"), the time
 * separators, and the empty-section view with its suggested prompts.
 */

import type { ReactNode } from 'react'
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native'
import Animated, { ZoomIn, ZoomOut } from 'react-native-reanimated'
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg'

import type { Bot } from '../../lib/types'
import { radii, useTheme } from '../../theme'
import { BotFace, type DotStatus } from '../face'
import { Glass } from '../glass'
import { Icon } from '../icon'

import { dayLabel } from './timeline'

/**
 * The header's centre: a glass pill with a face (status dot on it, bobbing
 * while it works), a name and a muted subtitle. Tap opens the bot or room.
 */
export function TitlePill({
  face,
  name,
  onPress,
  subtitle,
  testID
}: {
  face: ReactNode
  name: string
  onPress?: () => void
  subtitle?: null | string
  testID?: string
}) {
  const { colors } = useTheme()
  const { width } = useWindowDimensions()

  return (
    <Pressable
      accessibilityLabel={subtitle ? `${name}, ${subtitle}` : name}
      accessibilityRole="button"
      hitSlop={4}
      onPress={onPress}
      style={({ pressed }) => ({ opacity: pressed ? 0.75 : 1 })}
      testID={testID}
    >
      <Glass interactive style={[styles.pill, { maxWidth: width - 176 }]}>
        {face}
        <Text numberOfLines={1} style={[styles.name, { color: colors.text }]}>
          {name}
        </Text>
        {subtitle ? (
          <Text numberOfLines={1} style={[styles.subtitle, { color: colors.textMuted }]}>
            {subtitle}
          </Text>
        ) : null}
      </Glass>
    </Pressable>
  )
}

/** The bot's face for the title pill. */
export function PillFace({ bot, name, status }: { bot?: Bot; name: string; status?: DotStatus }) {
  return <BotFace bot={bot} name={name} size={28} status={status === 'idle' ? undefined : status} />
}

/** A small glass pill pinned under the header: waiting on you, archived. */
export function PinnedPill({
  action,
  icon,
  label,
  onPress,
  testID,
  tone
}: {
  action?: string
  icon: string
  label: string
  onPress?: () => void
  testID?: string
  tone?: string
}) {
  const { colors, dark } = useTheme()
  const ink = tone ?? colors.textMuted

  return (
    <Animated.View entering={ZoomIn.duration(180)} exiting={ZoomOut.duration(140)} style={styles.pinnedWrap}>
      <Pressable accessibilityRole={onPress ? 'button' : 'text'} disabled={!onPress} onPress={onPress} testID={testID}>
        <Glass interactive={Boolean(onPress)} style={styles.pinned} tint={dark ? 'rgba(14,14,14,0.55)' : 'rgba(255,255,255,0.7)'}>
          <Icon color={ink} name={icon} size={14} weight="semibold" />
          <Text numberOfLines={1} style={[styles.pinnedText, { color: ink }]}>
            {label}
          </Text>
          {action ? <Text style={[styles.pinnedAction, { color: colors.text }]}>{action}</Text> : null}
        </Glass>
      </Pressable>
    </Animated.View>
  )
}

export function DaySeparator({ time }: { time: number }) {
  const { colors } = useTheme()

  return <Text style={[styles.separator, { color: colors.textMuted }]}>{dayLabel(time)}</Text>
}

/** Three prompts derived from the bot's description, as plain grey pills. */
export function suggestedPrompts(description: string, name = 'this bot'): string[] {
  const first = description.trim() ? `What can you help me with, ${name}? Give me two examples.` : `What can you help me with, ${name}?`

  return [first, 'Tell me what you remember about me so far.', 'Suggest three things we could do together right now.']
}

export function EmptySection({ bot, name, onPrompt }: { bot?: Bot; name: string; onPrompt: (prompt: string) => void }) {
  const { colors } = useTheme()
  const label = bot?.title || bot?.description

  return (
    <View style={styles.empty} testID="empty-section">
      <BotFace bot={bot} name={name} size={88} />
      <View style={styles.emptyText}>
        <Text style={[styles.emptyName, { color: colors.text }]}>{name}</Text>
        {label ? (
          <Text numberOfLines={2} style={[styles.emptyLabel, { color: colors.textMuted }]}>
            {label}
          </Text>
        ) : null}
      </View>
      <View style={styles.prompts}>
        {suggestedPrompts(bot?.description ?? '', name).map((prompt, index) => (
          <Pressable
            accessibilityRole="button"
            key={prompt}
            onPress={() => onPrompt(prompt)}
            style={({ pressed }) => [styles.prompt, { backgroundColor: pressed ? colors.surface2 : colors.bubbleBot }]}
            testID={`suggestion-${index}`}
          >
            <Text style={[styles.promptText, { color: colors.text }]}>{prompt}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  fade: { left: 0, position: 'absolute', right: 0 },
  empty: { alignItems: 'center', flex: 1, gap: 20, justifyContent: 'center', paddingHorizontal: 28 },
  emptyLabel: { fontSize: 16, lineHeight: 21, marginTop: 4, textAlign: 'center' },
  emptyName: { fontSize: 24, fontWeight: '700', letterSpacing: -0.3, textAlign: 'center' },
  emptyText: { alignItems: 'center' },
  name: { flexShrink: 0, fontSize: 16, fontWeight: '600' },
  pill: { alignItems: 'center', borderRadius: radii.pill, flexDirection: 'row', gap: 8, height: 40, overflow: 'hidden', paddingLeft: 6, paddingRight: 16 },
  pinned: { alignItems: 'center', borderRadius: radii.pill, flexDirection: 'row', gap: 7, overflow: 'hidden', paddingHorizontal: 14, paddingVertical: 8 },
  pinnedAction: { fontSize: 14, fontWeight: '600', marginLeft: 4 },
  pinnedText: { flexShrink: 1, fontSize: 14, fontWeight: '600' },
  pinnedWrap: { alignItems: 'center' },
  prompt: { alignItems: 'center', borderRadius: radii.pill, paddingHorizontal: 16, paddingVertical: 10 },
  promptText: { fontSize: 15, lineHeight: 20, textAlign: 'center' },
  prompts: { alignItems: 'center', gap: 8, marginTop: 4 },
  separator: { fontSize: 13, fontWeight: '500', paddingBottom: 6, paddingTop: 18, textAlign: 'center' },
  subtitle: { flexShrink: 1, fontSize: 15 }
})

/**
 * A soft fade from the page colour to clear, so the transcript dissolves as
 * it passes under the status bar and the header's glass instead of showing
 * sharply behind them. `edge` picks top (under the header) or bottom
 * (behind the composer).
 */
export function EdgeFade({ edge, height, solid: solidPart = 0.7 }: { edge: 'bottom' | 'top'; height: number; /** Share of the height drawn fully opaque. */ solid?: number }) {
  const { colors } = useTheme()
  const id = `fade-${edge}`
  const solid = edge === 'top' ? 0 : 1

  return (
    <View pointerEvents="none" style={[styles.fade, edge === 'top' ? { top: 0 } : { bottom: 0 }, { height }]}>
      <Svg height="100%" width="100%">
        <Defs>
          <LinearGradient id={id} x1="0" x2="0" y1="0" y2="1">
            <Stop offset={solid} stopColor={colors.bg} stopOpacity={1} />
            <Stop offset={edge === 'top' ? solidPart : 1 - solidPart} stopColor={colors.bg} stopOpacity={1} />
            <Stop offset={1 - solid} stopColor={colors.bg} stopOpacity={0} />
          </LinearGradient>
        </Defs>
        <Rect fill={`url(#${id})`} height="100%" width="100%" />
      </Svg>
    </View>
  )
}
