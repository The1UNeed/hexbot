import { BlurView } from 'expo-blur'
import { GlassView, isGlassEffectAPIAvailable, isLiquidGlassAvailable } from 'expo-glass-effect'
import type { ReactNode } from 'react'
import { Platform, type StyleProp, StyleSheet, View, type ViewStyle } from 'react-native'

import { useTheme } from './theme'

/** Which material this device can draw, checked once. */
export const glassMaterial: 'blur' | 'liquid' | 'solid' = (() => {
  if (Platform.OS !== 'ios') {
    return 'solid'
  }

  try {
    return isLiquidGlassAvailable() && isGlassEffectAPIAvailable() ? 'liquid' : 'blur'
  } catch {
    return 'blur'
  }
})()

export interface GlassProps {
  children?: ReactNode
  style?: StyleProp<ViewStyle>
  /** Corner radius; glass shapes are capsules or rounded panels. */
  radius?: number
  /** Liquid Glass reacts to touch; set on surfaces that are themselves buttons. */
  interactive?: boolean
  testID?: string
}

/**
 * The floating material for controls that sit over content: Liquid Glass on
 * iOS 26, a system blur on older iOS, and a near-opaque fill on Android, on
 * the web, and whenever Reduce Transparency is on. Content itself never sits
 * on glass, so text stays readable in every case.
 */
export function Glass({ children, interactive, radius = 999, style, testID }: GlassProps) {
  const theme = useTheme()
  const material = theme.reduceTransparency ? 'solid' : glassMaterial
  const shape: ViewStyle = { borderRadius: radius, overflow: 'hidden' }

  if (material === 'liquid') {
    return (
      <GlassView
        colorScheme={theme.scheme}
        glassEffectStyle="regular"
        isInteractive={interactive}
        style={[shape, style]}
        testID={testID}
      >
        {children}
      </GlassView>
    )
  }

  const edge: ViewStyle = {
    borderColor: theme.chromeBorder,
    borderWidth: StyleSheet.hairlineWidth
  }

  if (material === 'blur') {
    return (
      <BlurView
        intensity={80}
        style={[shape, edge, style]}
        testID={testID}
        tint={theme.scheme === 'dark' ? 'systemChromeMaterialDark' : 'systemChromeMaterialLight'}
      >
        {children}
      </BlurView>
    )
  }

  return (
    <View style={[shape, edge, { backgroundColor: theme.chrome }, style]} testID={testID}>
      {children}
    </View>
  )
}
