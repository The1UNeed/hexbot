import { Modal, Pressable, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { REACTIONS } from '../core/reactions'
import { radius, Text, useCover, useTheme, withAlpha } from '../ui'

export interface MessageMenuProps {
  /** Null while the menu is closed. */
  message: null | {
    /** The emoji you already left on it, marked in the row. */
    mine?: string
  }
  onClose: () => void
  onCopy: () => void
  onReact: (emoji: string) => void
  onSelect: () => void
}

/**
 * What a long press on a bot's message offers when it can take a reaction: a
 * row of emoji over Copy and Select text, like a messaging app. Picking the
 * emoji you already left takes it back. A message that takes no reaction
 * keeps the system's own menu.
 */
export function MessageMenu({ message, onClose, onCopy, onReact, onSelect }: MessageMenuProps) {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const visible = message !== null
  useCover(visible)

  const pick = (action: () => void) => () => {
    onClose()
    action()
  }

  return (
    <Modal
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
      transparent
      visible={visible}
    >
      <Pressable
        accessibilityLabel="Close"
        onPress={onClose}
        style={[styles.backdrop, { backgroundColor: withAlpha('#000000', 0.32) }]}
        testID="message-menu-backdrop"
      />
      <View
        pointerEvents="box-none"
        style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 12) }]}
        testID="message-menu"
      >
        <View
          accessibilityRole="menu"
          style={[styles.reactions, { backgroundColor: theme.surface }]}
        >
          {REACTIONS.map(emoji => (
            <Pressable
              accessibilityLabel={message?.mine === emoji ? `Remove ${emoji}` : `React with ${emoji}`}
              accessibilityRole="menuitem"
              hitSlop={4}
              key={emoji}
              onPress={pick(() => onReact(emoji))}
              style={({ pressed }) => [
                styles.reaction,
                (pressed || message?.mine === emoji) && { backgroundColor: theme.fill }
              ]}
              testID={`message-react-${emoji}`}
            >
              <Text style={styles.emoji}>{emoji}</Text>
            </Pressable>
          ))}
        </View>
        <View style={[styles.actions, { backgroundColor: theme.surface }]}>
          {(
            [
              ['Copy', onCopy],
              ['Select text', onSelect]
            ] as const
          ).map(([label, action], index) => (
            <Pressable
              accessibilityRole="menuitem"
              key={label}
              onPress={pick(action)}
              style={({ pressed }) => [
                styles.action,
                index > 0 && {
                  borderTopColor: theme.hairline,
                  borderTopWidth: StyleSheet.hairlineWidth
                },
                pressed && { backgroundColor: theme.pressed }
              ]}
              testID={`message-menu-${label.toLowerCase().replace(' ', '-')}`}
            >
              <Text variant="body">{label}</Text>
            </Pressable>
          ))}
        </View>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  action: { minHeight: 50, justifyContent: 'center', paddingHorizontal: 18 },
  actions: { borderRadius: radius.bubble, overflow: 'hidden' },
  backdrop: { bottom: 0, left: 0, position: 'absolute', right: 0, top: 0 },
  emoji: { fontSize: 26, lineHeight: 32 },
  reaction: { alignItems: 'center', borderRadius: 999, height: 46, justifyContent: 'center', width: 46 },
  reactions: {
    alignSelf: 'center',
    borderRadius: 999,
    flexDirection: 'row',
    gap: 2,
    padding: 5
  },
  sheet: { bottom: 0, gap: 10, left: 0, paddingHorizontal: 12, position: 'absolute', right: 0 }
})
