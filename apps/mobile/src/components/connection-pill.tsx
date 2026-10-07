import { Pressable, StyleSheet, Text } from 'react-native'

import { getSupervisor } from '../lib/connection'
import { useConnection } from '../stores/connection'
import { useTheme } from '../theme'

import { Glass } from './glass'

/** "Reconnecting" or "Offline" as a small glass pill; nothing while connected. */
export function ConnectionPill() {
  const status = useConnection(state => state.status)
  const { colors } = useTheme()

  if (status === 'connected' || status === 'idle' || status === 'unauthorized') {
    return null
  }

  const word = status === 'connecting' ? 'Connecting' : status === 'reconnecting' ? 'Reconnecting' : 'Offline · Tap to retry'

  return (
    <Pressable accessibilityRole="button" onPress={() => void getSupervisor().retryNow()} style={styles.wrap}>
      <Glass interactive style={styles.pill}>
        <Text style={[styles.text, { color: status === 'offline' ? colors.danger : colors.textMuted }]}>{word}</Text>
      </Glass>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  pill: { borderRadius: 999, overflow: 'hidden', paddingHorizontal: 14, paddingVertical: 7 },
  text: { fontSize: 13, fontWeight: '500' },
  wrap: { alignSelf: 'center', marginBottom: 6 }
})
