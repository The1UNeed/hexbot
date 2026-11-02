import { Redirect, router, Stack, usePreventRemove } from 'expo-router'
import { useEffect, useRef } from 'react'
import { View } from 'react-native'

import { useAppScreens } from '../App'
import { type BarAction, chatActions, ChatTitle } from '../src/screens'
import { IconButton, type IconName, useTheme } from '../src/ui'

// Android's bar takes image icons, not SF Symbols, so the chat's buttons are
// drawn here with the app's own icons.
const ICONS: Record<BarAction['systemImage'], IconName> = {
  desktopcomputer: 'desktop-outline',
  'desktopcomputer.and.arrow.down': 'desktop',
  gearshape: 'settings-outline',
  magnifyingglass: 'search',
  'person.crop.circle': 'person-circle-outline'
}

/**
 * The open chat or room on Android. The system draws its bar: native back,
 * the chat's face and name, and its buttons. Leaving the route closes the
 * conversation; while a file uploads, back waits.
 */
export default function Chat() {
  const app = useAppScreens()
  const theme = useTheme()
  const closed = useRef(app.onChatClosed)
  closed.current = app.onChatClosed
  usePreventRemove(app.uploading, () => {})
  useEffect(() => () => closed.current(), [])
  // The chat closed from inside, as when its room is archived: back to the
  // list rather than a second list on top of it.
  const gone = !app.chat || !app.chatProps
  useEffect(() => {
    if (gone && router.canGoBack()) router.back()
  }, [gone])

  if (!app.chat || !app.chatProps) {
    return router.canGoBack() ? null : <Redirect href="/" />
  }

  const props = app.chatProps

  return (
    <>
      <Stack.Screen
        options={{
          headerBackButtonDisplayMode: 'minimal',
          headerTitle: () => <ChatTitle {...props} />,
          headerTransparent: false,
          headerRight: () => (
            <View style={{ flexDirection: 'row' }}>
              {chatActions(props).map(action => (
                <IconButton
                  accessibilityLabel={action.accessibilityLabel}
                  color={action.live ? theme.info : undefined}
                  icon={ICONS[action.systemImage]}
                  key={action.key}
                  onPress={action.onPress}
                  testID={`chat-${action.key}`}
                />
              ))}
            </View>
          )
        }}
      />
      {app.chat}
    </>
  )
}
