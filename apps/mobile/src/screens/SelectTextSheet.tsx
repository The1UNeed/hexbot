import { Platform, StyleSheet, TextInput } from 'react-native'

import { ModalSheet, Text, useTheme } from '../ui'

/**
 * A message on its own, to select any part of it and copy. iOS selects a
 * range only in a text view, which a read-only text field is; Android's
 * selectable text already does.
 */
export function SelectTextSheet({ onClose, text }: { text: string | null; onClose: () => void }) {
  const theme = useTheme()

  return (
    <ModalSheet onClose={onClose} testID="select-text" title="Select text" visible={text !== null}>
      {Platform.OS === 'ios' ? (
        <TextInput
          editable={false}
          multiline
          scrollEnabled={false}
          style={[styles.body, { color: theme.text }]}
          testID="select-text-body"
          value={text ?? ''}
        />
      ) : (
        <Text selectable style={styles.body} testID="select-text-body">
          {text}
        </Text>
      )}
    </ModalSheet>
  )
}

const styles = StyleSheet.create({
  body: { fontSize: 17, lineHeight: 23, padding: 0 }
})
