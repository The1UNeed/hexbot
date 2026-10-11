import type { ReactNode } from 'react'
import { StyleSheet, View } from 'react-native'

import { BotFace, type FaceSource } from './BotFace'
import type { FaceMood } from './faces'
import { Text } from './Text'

export interface EmptyStateProps {
  title: string
  message?: string
  /** A face to show above the title; a sleeping one reads as "nothing here yet". */
  face?: FaceSource
  mood?: FaceMood
  action?: ReactNode
  testID: string
}

/** What an empty list says, and the one thing to do next. */
export function EmptyState({
  action,
  face,
  message,
  mood = 'sleeping',
  testID,
  title
}: EmptyStateProps) {
  return (
    <View style={styles.empty} testID={testID}>
      {face ? <BotFace {...face} mood={mood} size={72} /> : null}
      <View style={styles.text}>
        <Text align="center" variant="headline">
          {title}
        </Text>
        {message ? (
          <Text align="center" tone="muted" variant="callout">
            {message}
          </Text>
        ) : null}
      </View>
      {action}
    </View>
  )
}

const styles = StyleSheet.create({
  empty: { alignItems: 'center', gap: 16, paddingHorizontal: 32, paddingVertical: 48 },
  text: { gap: 4, maxWidth: 320 }
})
