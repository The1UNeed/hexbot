import type { ReactNode } from 'react'
import { KeyboardAvoidingView, StyleSheet, View } from 'react-native'
import { type Edge, SafeAreaView } from 'react-native-safe-area-context'

import { IconButton } from './Button'
import { Text } from './Text'
import { HIT, useTheme } from './theme'

export interface ScreenProps {
  children: ReactNode
  testID: string
  /** Safe-area edges to pad. Screens with a floating bottom bar leave out `bottom`. */
  edges?: Edge[]
  /** `grouped` for settings-style screens. */
  background?: 'background' | 'grouped'
  /** Lift the content above the keyboard. */
  avoidKeyboard?: boolean
}

/**
 * A full screen: safe areas, background, and optional keyboard avoidance.
 * The app draws no status bar of its own; the system one shows through.
 */
export function Screen({
  avoidKeyboard,
  background = 'background',
  children,
  edges = ['top', 'left', 'right'],
  testID
}: ScreenProps) {
  const theme = useTheme()
  const body = avoidKeyboard ? (
    // Expo apps draw edge to edge on Android too, so padding works on both platforms.
    <KeyboardAvoidingView behavior="padding" style={styles.fill}>
      {children}
    </KeyboardAvoidingView>
  ) : (
    children
  )

  return (
    <SafeAreaView
      edges={edges}
      style={[styles.fill, { backgroundColor: theme[background] }]}
      testID={testID}
    >
      {body}
    </SafeAreaView>
  )
}

export interface TopBarProps {
  /** Plain title; ignored when `center` is given. */
  title?: string
  center?: ReactNode
  onBack?: () => void
  backLabel?: string
  trailing?: ReactNode
  testID: string
}

/**
 * The bar at the top of a pushed screen: a glass back button, a centred
 * title, and up to two glass actions. It sits on the screen colour, so the
 * title never fights with content scrolling under it.
 */
export function TopBar({
  backLabel = 'Back',
  center,
  onBack,
  testID,
  title,
  trailing
}: TopBarProps) {
  return (
    <View style={styles.bar} testID={testID}>
      <View style={styles.side}>
        {onBack ? (
          <IconButton
            accessibilityLabel={backLabel}
            icon="chevron-back"
            iconSize={24}
            onPress={onBack}
            testID={`${testID}-back`}
            variant="glass"
          />
        ) : null}
      </View>
      <View style={styles.center}>
        {center ??
          (title ? (
            <Text accessibilityRole="header" numberOfLines={1} variant="headline">
              {title}
            </Text>
          ) : null)}
      </View>
      <View style={[styles.side, styles.trailing]}>{trailing}</View>
    </View>
  )
}

/** A large left-aligned title with actions on the right, for top-level screens. */
export function LargeHeader({
  actions,
  testID,
  title
}: {
  title: string
  actions?: ReactNode
  testID: string
}) {
  return (
    <View style={styles.large} testID={testID}>
      <Text
        accessibilityRole="header"
        numberOfLines={1}
        style={styles.largeTitle}
        variant="largeTitle"
      >
        {title}
      </Text>
      <View style={styles.actions}>{actions}</View>
    </View>
  )
}

const styles = StyleSheet.create({
  actions: { flexDirection: 'row', gap: 8 },
  bar: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    minHeight: HIT + 12,
    paddingHorizontal: 12
  },
  center: { alignItems: 'center', flex: 1, justifyContent: 'center', minWidth: 0 },
  fill: { flex: 1 },
  large: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    minHeight: HIT + 12,
    paddingHorizontal: 20,
    paddingTop: 4
  },
  largeTitle: { flex: 1 },
  side: { flexDirection: 'row', gap: 8, minWidth: HIT },
  trailing: { justifyContent: 'flex-end' }
})
