/**
 * Liquid glass for floating chrome only: round header buttons, the name pill,
 * the composer, the waiting pill. iOS 26 draws the real material through
 * expo-glass-effect; elsewhere a translucent fill with a hairline stands in.
 */

import { GlassView, isGlassEffectAPIAvailable, isLiquidGlassAvailable } from 'expo-glass-effect'
import type { ReactNode } from 'react'
import { Pressable, type StyleProp, StyleSheet, View, type ViewStyle } from 'react-native'

import { useTheme } from '../theme'

import { Icon } from './icon'

const NATIVE_GLASS = (() => {
  try {
    return isLiquidGlassAvailable() && isGlassEffectAPIAvailable()
  } catch {
    return false
  }
})()

export function hasNativeGlass(): boolean {
  return NATIVE_GLASS
}

export interface GlassProps {
  children?: ReactNode
  interactive?: boolean
  style?: StyleProp<ViewStyle>
  /** A faint colour in the glass, such as the status of the bot. */
  tint?: string
}

export function Glass({ children, interactive, style, tint }: GlassProps) {
  const { colors, dark } = useTheme()

  if (NATIVE_GLASS) {
    return (
      <GlassView glassEffectStyle="regular" isInteractive={interactive} style={style} tintColor={tint}>
        {children}
      </GlassView>
    )
  }

  return (
    <View
      style={[
        {
          backgroundColor: tint ?? (dark ? 'rgba(38,38,38,0.92)' : 'rgba(255,255,255,0.94)'),
          borderColor: colors.hairline,
          borderWidth: StyleSheet.hairlineWidth,
          shadowColor: '#000',
          shadowOffset: { height: 4, width: 0 },
          shadowOpacity: dark ? 0.4 : 0.08,
          shadowRadius: 16
        },
        style
      ]}
    >
      {children}
    </View>
  )
}

export interface GlassButtonProps {
  accessibilityLabel: string
  disabled?: boolean
  icon: string
  iconColor?: string
  onPress?: () => void
  size?: number
  tint?: string
}

/** A round glass button with one symbol. */
export function GlassButton({ accessibilityLabel, disabled, icon, iconColor, onPress, size = 44, tint }: GlassButtonProps) {
  const { colors } = useTheme()

  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      disabled={disabled}
      hitSlop={6}
      onPress={onPress}
      style={({ pressed }) => ({ opacity: disabled ? 0.4 : pressed && !NATIVE_GLASS ? 0.7 : 1 })}
    >
      <Glass interactive style={[styles.round, { borderRadius: size / 2, height: size, width: size }]} tint={tint}>
        <Icon color={iconColor ?? colors.text} name={icon} size={size * 0.42} weight="medium" />
      </Glass>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  round: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }
})
