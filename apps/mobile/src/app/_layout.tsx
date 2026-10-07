import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router'
import * as SplashScreen from 'expo-splash-screen'
import { StatusBar } from 'expo-status-bar'
import { useEffect } from 'react'
import { AppState } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { KeyboardProvider } from 'react-native-keyboard-controller'

import { Banner } from '../components/banner'
import { useNativeAppearance } from '../components/settings/native-appearance'
import { getSupervisor } from '../lib/connection'
import { loadStoredTarget, useConnection } from '../stores/connection'
import { useTheme } from '../theme'

/** A deep link straight to a sheet still has the home list under it. */
export const unstable_settings = { initialRouteName: 'index' }

void SplashScreen.preventAutoHideAsync().catch(() => undefined)

export default function RootLayout() {
  const { colors, dark } = useTheme()
  const loaded = useConnection(state => state.loaded)
  const paired = useConnection(state => Boolean(state.target))

  // Native chrome (glass, headers, menus, keyboard) follows Settings, Appearance.
  useNativeAppearance()

  useEffect(() => {
    void loadStoredTarget().then(target => {
      if (target) {
        void getSupervisor().start(target)
      }

      void SplashScreen.hideAsync().catch(() => undefined)
    })

    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') {
        getSupervisor().resume()
      }
    })

    return () => subscription.remove()
  }, [])

  if (!loaded) {
    return null
  }

  const base = dark ? DarkTheme : DefaultTheme
  const navigationTheme = {
    ...base,
    colors: { ...base.colors, background: colors.bg, border: colors.border, card: colors.bg, primary: colors.text, text: colors.text }
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <KeyboardProvider>
        <ThemeProvider value={navigationTheme}>
          <StatusBar style={dark ? 'light' : 'dark'} />
          <Stack screenOptions={{ contentStyle: { backgroundColor: colors.bg }, headerBackButtonDisplayMode: 'minimal' }}>
            <Stack.Protected guard={paired}>
              <Stack.Screen name="index" options={{ title: '' }} />
              <Stack.Screen name="chat/[section]" />
              <Stack.Screen name="room/[id]/index" />
              <Stack.Screen name="room/[id]/settings" options={{ headerShown: false, presentation: 'modal' }} />
              <Stack.Screen name="room/new" options={{ headerShown: false, presentation: 'formSheet', sheetAllowedDetents: [0.92], sheetGrabberVisible: true }} />
              <Stack.Screen name="bot/new" options={{ headerShown: false, presentation: 'formSheet', sheetAllowedDetents: [0.92], sheetGrabberVisible: true }} />
              <Stack.Screen name="bot/[name]" options={{ headerShown: false, presentation: 'modal' }} />
              <Stack.Screen name="settings" options={{ headerShown: false, presentation: 'modal' }} />
              <Stack.Screen name="search" options={{ headerShown: false, presentation: 'modal' }} />
            </Stack.Protected>
            <Stack.Protected guard={!paired}>
              <Stack.Screen name="connect" options={{ headerShown: false }} />
              <Stack.Screen name="scan" options={{ headerShown: false, presentation: 'fullScreenModal' }} />
            </Stack.Protected>
            <Stack.Screen name="pair" options={{ headerShown: false }} />
          </Stack>
          <Banner />
        </ThemeProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  )
}
