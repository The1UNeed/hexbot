import { StyleSheet, View } from 'react-native'

import { Text } from './Text'
import { useTheme } from './theme'

export type BadgeTone = 'accent' | 'danger' | 'info' | 'neutral' | 'success' | 'warning'

/** A short word on a tinted capsule: "Demo", "This device", "Archived". */
export function Badge({
  label,
  testID,
  tone = 'neutral'
}: {
  label: string
  testID?: string
  tone?: BadgeTone
}) {
  const theme = useTheme()
  const color = tone === 'neutral' ? theme.muted : theme[tone]

  return (
    <View
      style={[
        styles.badge,
        { backgroundColor: tone === 'neutral' ? theme.fill : withAlpha(color, 0.14) }
      ]}
      testID={testID}
    >
      <Text maxFontSizeMultiplier={1.3} style={{ color }} variant="caption">
        {label}
      </Text>
    </View>
  )
}

/** An unread count on the accent colour. Hidden at zero. */
export function CountBadge({
  count,
  label,
  testID
}: {
  count: number
  label?: string
  testID?: string
}) {
  const theme = useTheme()

  if (count <= 0) {
    return null
  }

  return (
    <View
      accessibilityLabel={label ?? `${count} unread`}
      accessible
      style={[styles.count, { backgroundColor: theme.accent }]}
      testID={testID}
    >
      <Text maxFontSizeMultiplier={1.3} style={{ color: theme.onAccent }} variant="caption">
        {count > 99 ? '99+' : String(count)}
      </Text>
    </View>
  )
}

/** `#rrggbb` plus an alpha, for tints. Other colour formats pass through unchanged. */
export function withAlpha(hex: string, alpha: number) {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) {
    return hex
  }

  return `${hex}${Math.round(alpha * 255)
    .toString(16)
    .padStart(2, '0')}`
}

const styles = StyleSheet.create({
  badge: { alignSelf: 'flex-start', borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  count: {
    alignItems: 'center',
    borderRadius: 999,
    justifyContent: 'center',
    minWidth: 20,
    paddingHorizontal: 6,
    paddingVertical: 1
  }
})
