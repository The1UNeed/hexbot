/**
 * Long-press actions for a bubble. iOS draws the system context menu around
 * the bubble itself (the native view expo-router's Link.Menu is built on);
 * elsewhere a dialog offers the same actions.
 */

import * as Haptics from 'expo-haptics'
import type { ReactElement } from 'react'
import { Alert, Platform, Pressable, View } from 'react-native'

export interface BubbleAction {
  destructive?: boolean
  icon: string
  label: string
  onPress: () => void
}

type NativeMenu = typeof import('expo-router/build/link/preview/native')

let native: NativeMenu | null = null

if (Platform.OS === 'ios') {
  try {
    native = require('expo-router/build/link/preview/native') as NativeMenu
  } catch {
    native = null
  }
}

export function BubbleMenu({ actions, children }: { actions: BubbleAction[]; children: ReactElement }) {
  if (!actions.length) {
    return children
  }

  if (native) {
    const { NativeLinkPreview, NativeLinkPreviewAction } = native

    return (
      <NativeLinkPreview disableForceFlatten nextScreenId={undefined} style={{ display: 'contents' }} tabPath={undefined}>
        <View collapsable={false}>{children}</View>
        {actions.map(action => (
          <NativeLinkPreviewAction
            destructive={action.destructive}
            icon={action.icon}
            identifier={action.label}
            key={action.label}
            onSelected={action.onPress}
            title={action.label}
          />
        ))}
      </NativeLinkPreview>
    )
  }

  return (
    <Pressable
      delayLongPress={350}
      onLongPress={() => {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined)
        Alert.alert('', undefined, [
          ...actions.map(action => ({
            onPress: action.onPress,
            style: action.destructive ? ('destructive' as const) : ('default' as const),
            text: action.label
          })),
          { style: 'cancel' as const, text: 'Cancel' }
        ])
      }}
    >
      {children}
    </Pressable>
  )
}
