import { Ionicons } from '@expo/vector-icons'
import { StyleSheet, View } from 'react-native'

import { withAlpha } from './Badge'
import { Button } from './Button'
import { Text } from './Text'
import { radius, useTheme } from './theme'

export interface BannerProps {
  message: string
  testID: string
  tone?: 'danger' | 'info' | 'warning'
  title?: string
  actionLabel?: string
  onAction?: () => void
}

/** An inline notice: what happened and what to do about it. */
export function Banner({
  actionLabel,
  message,
  onAction,
  testID,
  title,
  tone = 'danger'
}: BannerProps) {
  const theme = useTheme()
  const color = theme[tone]
  const icon =
    tone === 'danger' ? 'alert-circle' : tone === 'warning' ? 'warning' : 'information-circle'

  return (
    <View
      accessibilityLiveRegion="polite"
      accessibilityRole={tone === 'danger' ? 'alert' : undefined}
      style={[
        styles.banner,
        { backgroundColor: withAlpha(color, theme.scheme === 'dark' ? 0.18 : 0.09) }
      ]}
      testID={testID}
    >
      <Ionicons color={color} name={icon} size={20} style={styles.icon} />
      <View style={styles.body}>
        {title ? <Text variant="subhead">{title}</Text> : null}
        <Text variant="callout">{message}</Text>
        {actionLabel && onAction ? (
          <Button
            label={actionLabel}
            onPress={onAction}
            style={styles.action}
            testID={`${testID}-action`}
            variant="plain"
          />
        ) : null}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  action: { marginLeft: -12, marginTop: -4 },
  banner: { borderRadius: radius.card, flexDirection: 'row', gap: 10, padding: 14 },
  body: { flex: 1, gap: 2 },
  icon: { marginTop: 1 }
})
