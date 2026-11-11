import { Ionicons } from '@expo/vector-icons'
import { BlurView } from 'expo-blur'
import { Fragment, type ReactNode, useEffect, useRef } from 'react'
import {
  AccessibilityInfo,
  Animated,
  Easing,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import type { IconName } from './Button'
import { Glass, glassMaterial } from './Glass'
import { Text } from './Text'
import { useTheme } from './theme'

const native = Platform.OS !== 'web'
const ITEM = 46
const GAP = 10
const WIDTH = 250

let reduceMotion = false
void AccessibilityInfo.isReduceMotionEnabled?.()
  .then(value => {
    reduceMotion = value
  })
  .catch(() => {})
AccessibilityInfo.addEventListener?.('reduceMotionChanged', value => {
  reduceMotion = value
})

/** Where the pressed thing sits on screen, from `measureInWindow`. */
export interface MenuFrame {
  x: number
  y: number
  w: number
  h: number
}

export interface MenuItem {
  key: string
  label: string
  icon: IconName
  run: () => void
  /** Starts a new group, drawn with a divider above it. */
  group?: boolean
}

/**
 * Below the pressed thing when it fits or has more room there, otherwise
 * above. Kept inside the safe area when neither side has room, as on a phone
 * in landscape; it may then cover part of the lifted copy.
 */
export function menuPlace(
  frame: MenuFrame,
  height: number,
  screen: number,
  insets: { bottom: number; top: number }
): { downward: boolean; place: { bottom: number } | { top: number } } {
  const below = screen - insets.bottom - (frame.y + frame.h) - GAP
  const downward = below >= height || below >= frame.y - insets.top - GAP
  const room = screen - insets.top - insets.bottom - GAP * 2 - height

  return {
    downward,
    place: downward
      ? { top: Math.max(insets.top + GAP, Math.min(frame.y + frame.h + GAP, insets.top + GAP + room)) }
      : {
          bottom: Math.max(
            insets.bottom + GAP,
            Math.min(screen - frame.y + GAP, insets.bottom + GAP + room)
          )
        }
  }
}

/**
 * A long-press menu in the manner of iOS: the screen blurs, the pressed thing
 * lifts in place, and a short list of actions opens beside it. Tapping the
 * lifted copy does what tapping the original does; tapping anywhere else
 * closes the menu.
 */
export function ContextMenu({
  frame,
  items,
  onClose,
  onPreviewPress,
  preview,
  previewLabel,
  testID
}: {
  /** Null while closed. */
  frame: MenuFrame | null
  items: MenuItem[]
  onClose: () => void
  onPreviewPress?: () => void
  /** The pressed thing drawn again, sized to `frame`. */
  preview: ReactNode
  /** What tapping the lifted copy does, for VoiceOver and TalkBack. */
  previewLabel?: string
  testID: string
}) {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const window = useWindowDimensions()
  const shown = useRef(new Animated.Value(0)).current

  useEffect(() => {
    if (!frame) return
    shown.setValue(reduceMotion ? 1 : 0)
    Animated.timing(shown, {
      duration: reduceMotion ? 0 : 240,
      easing: Easing.out(Easing.back(1.4)),
      toValue: 1,
      useNativeDriver: native
    }).start()
  }, [frame, shown])

  if (!frame) return null

  const width = Math.min(WIDTH, window.width - 32)
  const height = items.length * ITEM + items.filter((item, i) => i > 0 && item.group).length * 8
  const { downward, place } = menuPlace(frame, height, window.height, insets)
  // Aligned with the side of the screen the pressed thing is on, as iOS does.
  const fromRight = frame.x + frame.w / 2 > window.width / 2
  const left = Math.min(
    Math.max(16, fromRight ? frame.x + frame.w - width : frame.x),
    window.width - width - 16
  )
  const origin = `${downward ? 'top' : 'bottom'} ${fromRight ? 'right' : 'left'}`
  // A full-width row lifts as an inset card; anything smaller grows a little.
  const wide = frame.w > window.width - 32
  const lifted = wide
    ? { left: 8, scale: 1, width: window.width - 16 }
    : { left: frame.x, scale: 1.04, width: frame.w }
  const blur = glassMaterial !== 'solid' && !theme.reduceTransparency

  return (
    <Modal animationType="fade" onRequestClose={onClose} statusBarTranslucent transparent visible>
      <Pressable
        accessibilityLabel="Close menu"
        onPress={onClose}
        style={StyleSheet.absoluteFill}
        testID={`${testID}-backdrop`}
      >
        {blur ? (
          <BlurView
            intensity={40}
            style={StyleSheet.absoluteFill}
            tint={theme.scheme === 'dark' ? 'systemThinMaterialDark' : 'systemThinMaterialLight'}
          />
        ) : null}
        {/* A light dim on top, so the lifted copy and the glass menu stand out. */}
        <View
          style={[
            StyleSheet.absoluteFill,
            {
              backgroundColor: `rgba(0,0,0,${(blur ? 0.1 : 0.2) * (theme.scheme === 'dark' ? 2 : 1)})`
            }
          ]}
        />
      </Pressable>

      <Animated.View
        style={[
          styles.preview,
          {
            backgroundColor: theme.surface,
            height: frame.h,
            left: lifted.left,
            top: frame.y,
            transform: [
              { scale: shown.interpolate({ inputRange: [0, 1], outputRange: [1, lifted.scale] }) }
            ],
            width: lifted.width
          }
        ]}
      >
        <Pressable
          accessibilityLabel={previewLabel}
          accessibilityRole="button"
          disabled={!onPreviewPress}
          onPress={() => {
            onClose()
            onPreviewPress?.()
          }}
          style={styles.fill}
          testID={`${testID}-preview`}
        >
          {preview}
        </Pressable>
      </Animated.View>

      <Animated.View
        accessibilityViewIsModal
        style={[
          styles.menu,
          place,
          {
            left,
            opacity: shown.interpolate({ inputRange: [0, 0.6, 1], outputRange: [0, 1, 1] }),
            transform: [
              { scale: shown.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] }) }
            ],
            transformOrigin: origin,
            width
          }
        ]}
        testID={testID}
      >
        <Glass radius={22}>
          {items.map((item, index) => (
            <Fragment key={item.key}>
              {index > 0 && item.group ? (
                <View style={[styles.divider, { backgroundColor: theme.hairline }]} />
              ) : null}
              <Pressable
                accessibilityLabel={item.label}
                accessibilityRole="button"
                onPress={() => {
                  onClose()
                  item.run()
                }}
                style={({ pressed }) => [
                  styles.item,
                  { backgroundColor: pressed ? theme.pressed : 'transparent' }
                ]}
                testID={`${testID}-${item.key}`}
              >
                <Text numberOfLines={1} style={styles.fill} variant="body">
                  {item.label}
                </Text>
                <Ionicons color={theme.text} name={item.icon} size={20} />
              </Pressable>
            </Fragment>
          ))}
        </Glass>
      </Animated.View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  divider: { height: StyleSheet.hairlineWidth, marginHorizontal: 18, marginVertical: 4 },
  fill: { flex: 1 },
  item: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    height: ITEM,
    paddingHorizontal: 18
  },
  menu: {
    borderRadius: 22,
    elevation: 12,
    position: 'absolute',
    shadowColor: '#000',
    shadowOffset: { height: 8, width: 0 },
    shadowOpacity: 0.16,
    shadowRadius: 24
  },
  preview: {
    borderRadius: 20,
    elevation: 12,
    position: 'absolute',
    shadowColor: '#000',
    shadowOffset: { height: 8, width: 0 },
    shadowOpacity: 0.14,
    shadowRadius: 24
  }
})
