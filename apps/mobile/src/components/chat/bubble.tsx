/**
 * One bubble: soft grey for a bot on the left, inverse for you on the
 * right, 20 pt corners. A bubble that arrives while the chat is open springs
 * in from its tail corner; history is drawn still.
 */

import * as Clipboard from 'expo-clipboard'
import { type ReactNode, useEffect, useMemo } from 'react'
import { StyleSheet, useWindowDimensions, View } from 'react-native'
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withSpring } from 'react-native-reanimated'

import type { Attachment } from '../../lib/types'
import { radii, useTheme } from '../../theme'

import { Attachments } from './attachments'
import { type BubbleAction, BubbleMenu } from './bubble-menu'
import { type Ink, Markdown } from './markdown'

export type Side = 'bot' | 'user'

/** The ink a bubble's Markdown is drawn in. */
export function useInk(side: Side): Ink {
  const { colors, dark } = useTheme()

  return useMemo(
    () =>
      side === 'bot'
        ? {
            codeFill: colors.bg,
            inlineFill: dark ? 'rgba(255,255,255,0.09)' : 'rgba(0,0,0,0.06)',
            muted: colors.textMuted,
            rule: colors.border,
            text: colors.text
          }
        : {
            codeFill: dark ? 'rgba(0,0,0,0.07)' : 'rgba(255,255,255,0.14)',
            inlineFill: dark ? 'rgba(0,0,0,0.07)' : 'rgba(255,255,255,0.14)',
            muted: dark ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.65)',
            rule: dark ? 'rgba(0,0,0,0.15)' : 'rgba(255,255,255,0.25)',
            text: colors.bubbleUserText
          },
    [colors, dark, side]
  )
}

/** Springs a fresh bubble in from its tail corner (320 ms); a still one renders as is. */
export function Arrive({ children, fresh, side }: { children: ReactNode; fresh: boolean; side: Side }) {
  const reduced = useReducedMotion()
  const animate = fresh && !reduced
  const progress = useSharedValue(animate ? 0 : 1)

  useEffect(() => {
    if (animate) {
      progress.value = withSpring(1, { dampingRatio: 0.72, duration: 320 })
    }
  }, [animate, progress])

  const style = useAnimatedStyle(() => ({
    opacity: Math.min(1, progress.value * 3),
    transform: [{ scale: 0.82 + 0.18 * progress.value }, { translateY: (1 - progress.value) * 10 }]
  }))

  return <Animated.View style={[{ transformOrigin: side === 'bot' ? 'left bottom' : 'right bottom' }, style]}>{children}</Animated.View>
}

export interface BubbleProps {
  attachments?: Attachment[]
  fresh?: boolean
  /** Room taken beside the bubble (a room's face column), off its widest size. */
  inset?: number
  onImage?: (uri: string) => void
  /** Retry the turn; offered on your last message. */
  onRetry?: () => void
  side: Side
  testID?: string
  text: string
}

export function Bubble({ attachments = [], fresh = false, inset = 0, onImage, onRetry, side, testID, text }: BubbleProps) {
  const { colors } = useTheme()
  const { width } = useWindowDimensions()
  const ink = useInk(side)
  const maxWidth = Math.min(560, Math.round(width * (side === 'bot' ? 0.84 : 0.78)) - inset)

  const actions: BubbleAction[] = [
    ...(text ? [{ icon: 'doc.on.doc', label: 'Copy', onPress: () => void Clipboard.setStringAsync(text) }] : []),
    ...(onRetry ? [{ icon: 'arrow.clockwise', label: 'Retry', onPress: onRetry }] : [])
  ]

  return (
    <Arrive fresh={fresh} side={side}>
      <View style={[styles.row, side === 'user' && styles.rowUser]}>
        <BubbleMenu actions={actions}>
          <View
            accessibilityRole="text"
            style={[
              styles.bubble,
              { backgroundColor: side === 'bot' ? colors.bubbleBot : colors.bubbleUser, maxWidth },
              !text && styles.bare
            ]}
            testID={testID}
          >
            {text ? <Markdown ink={ink} text={text} /> : null}
            {attachments.length ? <Attachments attachments={attachments} onImage={onImage} side={side} spaced={Boolean(text)} /> : null}
          </View>
        </BubbleMenu>
      </View>
    </Arrive>
  )
}

const styles = StyleSheet.create({
  bare: { backgroundColor: 'transparent', paddingHorizontal: 0, paddingVertical: 0 },
  bubble: { borderRadius: radii.bubble, paddingHorizontal: 14, paddingVertical: 9 },
  row: { alignItems: 'flex-start', flexDirection: 'row' },
  rowUser: { justifyContent: 'flex-end' }
})
