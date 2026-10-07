import { Stack } from 'expo-router'

import { useTheme } from '../../theme'

/** A deep link to a page still has the index under it, so back goes to Settings. */
export const unstable_settings = { initialRouteName: 'index' }

/** Settings: a sheet with its own stack. The index has a large title; pages push inside the sheet. */
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
      <Stack.Screen name="index" options={{ headerLargeTitle: true, headerLargeTitleShadowVisible: false, title: 'Settings' }} />
    </Stack>
  )
}
