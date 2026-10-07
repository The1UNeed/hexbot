import { router } from 'expo-router'
import { useEffect } from 'react'
import { Pressable, StyleSheet, Text } from 'react-native'
import Animated, { FadeInUp, FadeOutUp } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { useNotice } from '../lib/notify'
import { useTheme } from '../theme'

import { Glass } from './glass'

const SHOW_MS = 4_000

/** The newest in-app notice, as a glass card under the status bar. */
export function Banner() {
  const notice = useNotice(state => state.notice)
  const dismiss = useNotice(state => state.dismiss)
  const insets = useSafeAreaInsets()
  const { colors } = useTheme()

  useEffect(() => {
    if (!notice) {
      return
    }

    const timer = setTimeout(() => dismiss(notice.id), SHOW_MS)

    return () => clearTimeout(timer)
  }, [dismiss, notice])

  if (!notice) {
    return null
  }

  return (
    <Animated.View entering={FadeInUp.duration(180)} exiting={FadeOutUp.duration(180)} style={[styles.wrap, { top: insets.top + 6 }]}>
      <Pressable
        accessibilityRole="button"
        onPress={() => {
          dismiss(notice.id)

          if (notice.sectionId) {
            router.push({ params: { section: notice.sectionId }, pathname: '/chat/[section]' })
          }
        }}
      >
        <Glass interactive style={styles.card}>
          <Text numberOfLines={1} style={[styles.title, { color: colors.text }]}>
            {notice.title}
          </Text>
          <Text numberOfLines={2} style={[styles.body, { color: colors.textMuted }]}>
            {notice.body}
          </Text>
        </Glass>
      </Pressable>
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  body: { fontSize: 14, lineHeight: 19 },
  card: { borderRadius: 22, gap: 2, overflow: 'hidden', paddingHorizontal: 18, paddingVertical: 12 },
  title: { fontSize: 15, fontWeight: '600' },
  wrap: { left: 12, position: 'absolute', right: 12 }
})
