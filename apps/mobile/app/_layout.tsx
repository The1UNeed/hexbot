import { Stack } from 'expo-router'

import App from '../App'

/**
 * Android: one native stack. The chat list draws its own header and dock;
 * a chat, Settings and Bots & jobs open over it with the system's back.
 * iOS has its own layout, a split view (`_layout.ios.tsx`).
 */
export default function RootLayout() {
  return (
    <App>
      <Stack screenOptions={{ headerBackButtonDisplayMode: 'minimal' }}>
        <Stack.Screen name="index" options={{ headerShown: false, title: 'Chats' }} />
        <Stack.Screen name="settings" options={{ title: 'Settings' }} />
        <Stack.Screen name="bots" options={{ title: 'Bots & jobs' }} />
      </Stack>
    </App>
  )
}
