import { Stack } from 'expo-router'

import { useTheme } from '../../../theme'

/** A link straight to a page still lands with the sheet under it, so back works. */
export const unstable_settings = { initialRouteName: 'index' }

/**
 * The bot sheet's own stack: the sheet itself, then one page per setting
 * pushed inside the modal with the native back button.
 */
export default function Layout() {
  const { colors } = useTheme()

  return (
    <Stack
      screenOptions={{
        contentStyle: { backgroundColor: colors.bg },
        headerBackButtonDisplayMode: 'minimal',
        headerShadowVisible: false,
        headerTintColor: colors.text,
        headerTransparent: true
      }}
    >
      <Stack.Screen name="index" />
      <Stack.Screen
        name="setup"
        options={{ headerShown: false, presentation: 'formSheet', sheetAllowedDetents: [0.8, 1], sheetGrabberVisible: true }}
      />
    </Stack>
  )
}
