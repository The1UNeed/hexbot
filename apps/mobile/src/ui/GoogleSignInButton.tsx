import { ActivityIndicator, Platform, Pressable, StyleSheet, Text } from 'react-native'
import Svg, { Path } from 'react-native-svg'

import { BRAND_ICONS } from '../../../web/src/lib/connector-icons'

import { useTheme } from './theme'

/** Google's colours for its button, per scheme; not the theme's. */
const LOOK = {
  dark: { fill: '#131314', stroke: '#8e918f', text: '#e3e3e3' },
  light: { fill: '#ffffff', stroke: '#747775', text: '#1f1f1f' }
}

/**
 * Sign in with Google as Google's branding guidelines draw it, as on the
 * desktop: its words, its colours, Roboto Medium where the phone has it,
 * and the "G" in its own colours.
 */
export function GoogleSignInButton({
  busy,
  disabled,
  onPress,
  testID
}: {
  busy?: boolean
  disabled?: boolean
  onPress: () => void
  testID: string
}) {
  const theme = useTheme()
  const look = LOOK[theme.scheme]
  const google = BRAND_ICONS.google!

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ busy: !!busy, disabled: !!disabled }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: look.fill, borderColor: look.stroke },
        (disabled || pressed) && styles.dim
      ]}
      testID={testID}
    >
      {busy ? (
        <ActivityIndicator color={look.text} size="small" />
      ) : (
        <Svg height={20} viewBox={google.marksViewBox} width={20}>
          {google.marks!.map(mark => (
            <Path d={mark.d} fill={mark.fill} key={mark.d} />
          ))}
        </Svg>
      )}
      <Text style={[styles.label, { color: look.text }]}>Sign in with Google</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  button: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    borderRadius: 20,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 10,
    height: 40,
    paddingHorizontal: 12
  },
  dim: { opacity: 0.6 },
  // Google's Roboto where the system has it; the system face elsewhere.
  label: {
    fontFamily: Platform.select({ android: 'Roboto', web: 'Roboto, Arial, sans-serif' }),
    fontSize: 14,
    fontWeight: '500',
    lineHeight: 20
  }
})
