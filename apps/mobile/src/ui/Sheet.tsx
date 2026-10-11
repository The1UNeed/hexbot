import type { ReactNode } from 'react'
import { KeyboardAvoidingView, Modal, Platform, ScrollView, StyleSheet, View } from 'react-native'
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context'

import { Button, IconButton } from './Button'
import { Text } from './Text'
import { HIT, useTheme } from './theme'

export interface SheetAction {
  label: string
  onPress: () => void
  disabled?: boolean
  busy?: boolean
  busyLabel?: string
}

export interface ModalSheetProps {
  visible: boolean
  onClose: () => void
  title: string
  testID: string
  children: ReactNode
  /** The confirming action at the top right, such as Save. */
  action?: SheetAction
  closeLabel?: string
  /** Something above the scrolling body that stays put, such as a segmented control. */
  header?: ReactNode
  /** Turn off for bodies that scroll themselves. */
  scroll?: boolean
}

/**
 * A sheet that slides up over the current screen. iOS draws it as a native
 * page sheet, which picks up Liquid Glass and swipe-to-dismiss from the
 * system; Android gets a full-screen panel with the same header.
 */
export function ModalSheet({ visible, ...props }: ModalSheetProps) {
  return (
    <Modal
      animationType="slide"
      onRequestClose={props.onClose}
      presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : undefined}
      statusBarTranslucent
      visible={visible}
    >
      <SafeAreaProvider>
        <SheetBody {...props} />
      </SafeAreaProvider>
    </Modal>
  )
}

function SheetBody({
  action,
  children,
  closeLabel = 'Close',
  header,
  onClose,
  scroll = true,
  testID,
  title
}: Omit<ModalSheetProps, 'visible'>) {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  // A page sheet starts below the status bar already; Android's panel does not.
  const top = Platform.OS === 'ios' ? 8 : insets.top + 4

  return (
    <View style={[styles.fill, { backgroundColor: theme.grouped }]} testID={testID}>
      <View style={[styles.header, { paddingTop: top }]}>
        <View style={styles.side}>
          <IconButton
            accessibilityLabel={closeLabel}
            icon="close"
            iconSize={22}
            onPress={onClose}
            testID={`${testID}-close`}
            variant="glass"
          />
        </View>
        <Text
          accessibilityRole="header"
          align="center"
          numberOfLines={1}
          style={styles.title}
          variant="headline"
        >
          {title}
        </Text>
        <View style={[styles.side, styles.end]}>
          {action ? (
            <Button
              busy={action.busy}
              busyLabel={action.busyLabel}
              disabled={action.disabled}
              label={action.label}
              onPress={action.onPress}
              style={styles.action}
              testID={`${testID}-action`}
            />
          ) : null}
        </View>
      </View>
      {header ? <View style={styles.pinned}>{header}</View> : null}
      <KeyboardAvoidingView behavior="padding" style={styles.fill}>
        {scroll ? (
          <ScrollView
            automaticallyAdjustKeyboardInsets={false}
            contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
          >
            {children}
          </ScrollView>
        ) : (
          <View style={[styles.fill, { paddingBottom: insets.bottom }]}>{children}</View>
        )}
      </KeyboardAvoidingView>
    </View>
  )
}

/** A stack of form groups with even spacing, for sheet bodies. */
export function Form({ children }: { children: ReactNode }) {
  return <View style={styles.form}>{children}</View>
}

const styles = StyleSheet.create({
  action: { minHeight: HIT, paddingHorizontal: 18 },
  content: { paddingHorizontal: 16, paddingTop: 8 },
  end: { justifyContent: 'flex-end' },
  fill: { flex: 1 },
  form: { gap: 28 },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    paddingBottom: 8,
    paddingHorizontal: 12
  },
  pinned: { paddingBottom: 12, paddingHorizontal: 16 },
  side: { flexDirection: 'row', minWidth: 96 },
  title: { flex: 1 }
})
