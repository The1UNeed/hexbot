import { Redirect, Stack, usePreventRemove } from 'expo-router'
import { useEffect, useRef } from 'react'

import { useAppScreens } from '../App'
import { chatActions, ChatTitle } from '../src/screens'
import { useTheme } from '../src/ui'

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

  if (!app.chat || !app.chatProps) {
    return <Redirect href="/" />
  }

  const props = app.chatProps

  return (
    <>
      <Stack.Screen
        options={{
          headerBackButtonDisplayMode: 'minimal',
          headerTitle: () => <ChatTitle {...props} />,
          headerTransparent: false
        }}
      />
      <Stack.Toolbar placement="right">
        {chatActions(props).map(action => (
          <Stack.Toolbar.Button
            accessibilityLabel={action.accessibilityLabel}
            icon={action.systemImage}
            key={action.key}
            onPress={action.onPress}
            tintColor={action.live ? theme.info : undefined}
          >
            {action.label}
          </Stack.Toolbar.Button>
        ))}
      </Stack.Toolbar>
      {app.chat}
    </>
  )
}
