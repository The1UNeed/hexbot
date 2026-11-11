import { Ionicons } from '@expo/vector-icons'
import { useRef, useState } from 'react'
import { Modal, Platform, Pressable, StyleSheet, useWindowDimensions, View } from 'react-native'

import type { AttachSource } from '../core/pickFile'
import { Glass, glassMaterial, HIT, type IconName, Text, useTheme } from '../ui'

const choices = (): { source: AttachSource; label: string; icon: IconName }[] => [
  { source: 'library', label: 'Photos and videos', icon: 'images-outline' },
  // Android's camera does one or the other, so it gets a row for each.
  ...(Platform.OS === 'android'
    ? [
        { source: 'camera' as const, label: 'Take photo', icon: 'camera-outline' as const },
        { source: 'video' as const, label: 'Record video', icon: 'videocam-outline' as const }
      ]
    : [{ source: 'camera' as const, label: 'Camera', icon: 'camera-outline' as const }]),
  { source: 'files', label: 'Files', icon: 'document-outline' }
]

/** What the composer's + offers, in a small card above it. */
export function AttachMenu({
  anchor,
  onChoose,
  onClose
}: {
  anchor: { x: number; y: number; w: number; h: number } | null
  onChoose: (source: AttachSource) => void
  onClose: () => void
}) {
  const theme = useTheme()
  const window = useWindowDimensions()
  const material = theme.reduceTransparency ? 'solid' : glassMaterial
  // iOS shows a picker only once this menu has gone, so the choice waits for it.
  const chosen = useRef<AttachSource | null>(null)
  const [last, setLast] = useState(anchor)
  if (anchor && anchor !== last) setLast(anchor)
  const place = anchor ?? last
  if (!place) return null

  const choose = (source: AttachSource) => {
    if (Platform.OS === 'ios') chosen.current = source
    onClose()
    if (Platform.OS !== 'ios') onChoose(source)
  }
  const dismissed = () => {
    const source = chosen.current
    chosen.current = null
    if (source) onChoose(source)
  }

  const width = Math.min(260, window.width - 24)
  const left = Math.min(Math.max(12, place.x), window.width - width - 12)

  return (
    <Modal
      animationType="fade"
      onDismiss={dismissed}
      onRequestClose={onClose}
      statusBarTranslucent
      transparent
      visible={!!anchor}
    >
      <Pressable
        accessibilityLabel="Close menu"
        onPress={onClose}
        style={StyleSheet.absoluteFill}
        testID="chat-attach-menu-backdrop"
      />
      <View
        accessibilityRole="menu"
        style={[
          styles.menu,
          // Liquid Glass casts its own depth; the other materials need a shadow,
          // and the plain fill a solid base so the chat does not show through.
          material !== 'liquid' && styles.lifted,
          material === 'solid' && { backgroundColor: theme.surface },
          { bottom: window.height - place.y + 8, left, width }
        ]}
        testID="chat-attach-menu"
      >
        <Glass radius={RADIUS} style={styles.card}>
          {choices().map(choice => (
            <Pressable
              accessibilityLabel={choice.label}
              accessibilityRole="menuitem"
              key={choice.source}
              onPress={() => choose(choice.source)}
              style={({ pressed }) => [styles.row, pressed && { backgroundColor: theme.fill }]}
              testID={`chat-attach-${choice.source}`}
            >
              <Ionicons color={theme.text} name={choice.icon} size={21} />
              <Text variant="body">{choice.label}</Text>
            </Pressable>
          ))}
        </Glass>
      </View>
    </Modal>
  )
}

const RADIUS = 26

const styles = StyleSheet.create({
  card: { padding: 6 },
  lifted: {
    elevation: 16,
    shadowColor: '#000',
    shadowOffset: { height: 10, width: 0 },
    shadowOpacity: 0.18,
    shadowRadius: 28
  },
  menu: { borderRadius: RADIUS, position: 'absolute' },
  row: {
    alignItems: 'center',
    borderRadius: RADIUS - 6,
    flexDirection: 'row',
    gap: 12,
    minHeight: HIT + 4,
    paddingHorizontal: 14
  }
})
