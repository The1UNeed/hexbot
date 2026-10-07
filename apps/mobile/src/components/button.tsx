import type { ReactNode } from 'react'
import { ActivityIndicator, Pressable, type StyleProp, StyleSheet, Text, type ViewStyle } from 'react-native'

import { useTheme } from '../theme'

export interface ButtonProps {
  children: ReactNode
  disabled?: boolean
  loading?: boolean
  onPress?: () => void
  style?: StyleProp<ViewStyle>
  variant?: 'danger' | 'plain' | 'primary' | 'secondary'
}

/**
 * The one button. Primary is foreground on background (black on light,
 * white on dark); secondary is a grey fill; plain is text only.
 */
export function Button({ children, disabled, loading, onPress, style, variant = 'primary' }: ButtonProps) {
  const { colors } = useTheme()
  const fill =
    variant === 'primary' ? colors.primary : variant === 'secondary' ? colors.surface2 : variant === 'danger' ? colors.danger : 'transparent'
  const ink = variant === 'primary' ? colors.primaryText : variant === 'danger' ? '#FFFFFF' : colors.text

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ busy: loading, disabled }}
      disabled={disabled || loading}
      onPress={onPress}
      style={({ pressed }) => [
        styles.base,
        { backgroundColor: fill, opacity: disabled ? 0.4 : pressed ? 0.75 : 1 },
        variant === 'plain' && styles.plain,
        style
      ]}
    >
      {loading ? <ActivityIndicator color={ink} /> : <Text style={[styles.label, { color: ink }]}>{children}</Text>}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  base: { alignItems: 'center', borderRadius: 999, height: 52, justifyContent: 'center', paddingHorizontal: 22 },
  label: { fontSize: 17, fontWeight: '600' },
  plain: { height: 44 }
})
