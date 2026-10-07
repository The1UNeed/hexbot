/**
 * Attachments on a message: images inline (tap for the full view), files as
 * chips with a type icon, name and size.
 */

import { Image } from 'expo-image'
import { Pressable, StyleSheet, Text, View } from 'react-native'

import type { Attachment } from '../../lib/types'
import { useTheme } from '../../theme'
import { Icon } from '../icon'

import type { Side } from './bubble'

export function fileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  return `${Math.max(1, Math.ceil(bytes / 1024))} KB`
}

export const fileIcon = (kind: Attachment['kind']) => (kind === 'image' ? 'photo' : kind === 'pdf' ? 'doc.richtext' : 'doc')

export function Attachments({
  attachments,
  onImage,
  side,
  spaced
}: {
  attachments: Attachment[]
  onImage?: (uri: string) => void
  side: Side
  spaced: boolean
}) {
  const { colors, dark } = useTheme()
  const chipFill = side === 'bot' ? colors.bg : dark ? 'rgba(0,0,0,0.07)' : 'rgba(255,255,255,0.14)'
  const ink = side === 'bot' ? colors.text : colors.bubbleUserText

  return (
    <View style={[styles.wrap, spaced && styles.spaced, side === 'user' && styles.end]}>
      {attachments.map(item =>
        item.kind === 'image' && item.dataUrl ? (
          <Pressable accessibilityLabel={item.name} accessibilityRole="imagebutton" key={item.id} onPress={() => onImage?.(item.dataUrl!)}>
            <Image contentFit="cover" source={{ uri: item.dataUrl }} style={styles.image} />
          </Pressable>
        ) : (
          <View key={item.id} style={[styles.chip, { backgroundColor: chipFill }]}>
            <Icon color={ink} name={fileIcon(item.kind)} size={15} />
            <Text numberOfLines={1} style={[styles.chipName, { color: ink }]}>
              {item.name}
            </Text>
            {item.size ? <Text style={[styles.chipSize, { color: ink, opacity: 0.6 }]}>{fileSize(item.size)}</Text> : null}
          </View>
        )
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  chip: { alignItems: 'center', borderRadius: 12, flexDirection: 'row', gap: 8, maxWidth: 260, paddingHorizontal: 10, paddingVertical: 8 },
  chipName: { flexShrink: 1, fontSize: 15 },
  chipSize: { fontSize: 13 },
  end: { justifyContent: 'flex-end' },
  image: { borderRadius: 16, height: 200, width: 200 },
  spaced: { marginTop: 8 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 }
})
