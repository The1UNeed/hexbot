import { Image, Platform, Pressable, StyleSheet } from 'react-native'
import { SvgXml } from 'react-native-svg'

import { GOOGLE_SIGN_IN } from './brandLogos'
import { MICROSOFT_SIGN_IN_XML } from './brandMarkup'
import { useTheme } from './theme'

/**
 * Sign in with Google, or with Microsoft: the owner's own button, as its
 * sign-in branding guidelines ask of an app, drawn from the file it
 * publishes so its logo, words, colours and shape stay as they are. Both
 * publish a light and a dark version; the one for the theme shows. The same
 * button signs in again.
 */
export function BrandSignInButton({
  busy,
  disabled,
  onPress,
  provider,
  testID
}: {
  busy?: boolean
  disabled?: boolean
  onPress: () => void
  provider: 'google' | 'microsoft'
  testID: string
}) {
  const scheme = useTheme().scheme
  const google = GOOGLE_SIGN_IN[Platform.OS === 'ios' ? 'ios' : 'android']

  return (
    <Pressable
      accessibilityLabel={`Sign in with ${provider === 'google' ? 'Google' : 'Microsoft'}`}
      accessibilityRole="button"
      accessibilityState={{ busy: !!busy, disabled: !!disabled }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [styles.button, (disabled || busy || pressed) && styles.dim]}
      testID={testID}
    >
      {provider === 'google' ? (
        <Image
          resizeMode="contain"
          source={google[scheme]}
          style={{ height: google.height, width: google.width }}
        />
      ) : (
        <SvgXml height={41} width={215} xml={MICROSOFT_SIGN_IN_XML[scheme]} />
      )}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  button: { alignSelf: 'flex-start' },
  dim: { opacity: 0.6 }
})
