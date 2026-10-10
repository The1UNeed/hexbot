import { Ionicons } from '@expo/vector-icons'
import type { ComponentProps } from 'react'
import { Pressable, type StyleProp, StyleSheet, View, type ViewStyle } from 'react-native'

import { Glass } from './Glass'
import { Text } from './Text'
import { HIT, useTheme } from './theme'

export type IconName = ComponentProps<typeof Ionicons>['name']

export type ButtonVariant = 'destructive' | 'plain' | 'primary' | 'secondary'

export interface ButtonProps {
  label: string
  onPress?: () => void
  testID: string
  variant?: ButtonVariant
  icon?: IconName
  /** Shown in place of the label while the action runs; the button is disabled meanwhile. */
  busyLabel?: string
  busy?: boolean
  disabled?: boolean
  /** Fill the row instead of hugging the label. */
  wide?: boolean
  accessibilityLabel?: string
  accessibilityHint?: string
  style?: StyleProp<ViewStyle>
}

/**
 * A capsule button. Primary is ink on white (white on black in dark mode),
 * the strongest thing on a screen; use one per view.
 */
export function Button({
  accessibilityHint,
  accessibilityLabel,
  busy,
  busyLabel,
  disabled,
  icon,
  label,
  onPress,
  style,
  testID,
  variant = 'primary',
  wide
}: ButtonProps) {
  const theme = useTheme()
  const off = disabled || busy
  const colors = {
    destructive: { bg: theme.fill, fg: theme.danger },
    plain: { bg: 'transparent', fg: theme.accent },
    primary: { bg: theme.ink, fg: theme.onInk },
    secondary: { bg: theme.fill, fg: theme.text }
  }[variant]

  return (
    <Pressable
      accessibilityHint={accessibilityHint}
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityRole="button"
      accessibilityState={{ busy: !!busy, disabled: !!off }}
      disabled={off}
      hitSlop={4}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: colors.bg, opacity: off ? 0.45 : pressed ? 0.7 : 1 },
        variant === 'plain' && styles.plain,
        wide && styles.wide,
        style
      ]}
      testID={testID}
    >
      {icon ? <Ionicons color={colors.fg} name={icon} size={19} /> : null}
      <Text style={{ color: colors.fg }} variant="headline">
        {busy && busyLabel ? busyLabel : label}
      </Text>
    </Pressable>
  )
}

export interface IconButtonProps {
  icon: IconName
  /** Required: icon buttons have no visible text. */
  accessibilityLabel: string
  testID: string
  onPress?: () => void
  /** `glass` floats over content, `filled` is ink, `tinted` sits on a fill, `plain` is bare. */
  variant?: 'filled' | 'glass' | 'plain' | 'tinted'
  size?: number
  iconSize?: number
  color?: string
  disabled?: boolean
  selected?: boolean
  accessibilityHint?: string
  style?: StyleProp<ViewStyle>
}

/** A round 44pt icon button. */
export function IconButton({
  accessibilityHint,
  accessibilityLabel,
  color,
  disabled,
  icon,
  iconSize,
  onPress,
  selected,
  size = HIT,
  style,
  testID,
  variant = 'plain'
}: IconButtonProps) {
  const theme = useTheme()
  const tint = color ?? (variant === 'filled' ? theme.onInk : theme.text)
  const glyph = <Ionicons color={tint} name={icon} size={iconSize ?? Math.round(size * 0.48)} />
  const round = { borderRadius: size / 2, height: size, width: size }

  return (
    <Pressable
      accessibilityHint={accessibilityHint}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled, selected }}
      disabled={disabled}
      hitSlop={size < HIT ? (HIT - size) / 2 : 0}
      onPress={onPress}
      style={({ pressed }) => [{ opacity: disabled ? 0.4 : pressed ? 0.6 : 1 }, style]}
      testID={testID}
    >
      {variant === 'glass' ? (
        <Glass interactive radius={size / 2} style={[round, styles.center]}>
          {glyph}
        </Glass>
      ) : (
        <View
          style={[
            round,
            styles.center,
            variant === 'filled' && { backgroundColor: theme.ink },
            variant === 'tinted' && { backgroundColor: theme.fill }
          ]}
        >
          {glyph}
        </View>
      )}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  button: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    borderRadius: 999,
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'center',
    minHeight: 50,
    paddingHorizontal: 22
  },
  center: { alignItems: 'center', justifyContent: 'center' },
  plain: { minHeight: HIT, paddingHorizontal: 12 },
  wide: { alignSelf: 'stretch' }
})
