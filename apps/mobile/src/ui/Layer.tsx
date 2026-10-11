import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState
} from 'react'
import {
  AccessibilityInfo,
  Animated,
  Easing,
  KeyboardAvoidingView,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { Button, IconButton } from './Button'
import type { SheetAction } from './Sheet'
import { Text } from './Text'
import { HIT, useTheme } from './theme'

/** How much of the layer below stays visible above a card, under the status bar. */
export const PEEK = 64
const native = Platform.OS !== 'web'

let reduceMotion = false
void AccessibilityInfo.isReduceMotionEnabled?.()
  .then(value => {
    reduceMotion = value
  })
  .catch(() => {})
AccessibilityInfo.addEventListener?.('reduceMotionChanged', value => {
  reduceMotion = value
})

const duration = (ms: number) => (reduceMotion ? 0 : ms)

const DepthContext = createContext<((delta: number) => void) | null>(null)

/**
 * Wraps the whole app. While a card is open, the app behind it scales back
 * and rounds its corners, so the card reads as the front layer and the real
 * screen underneath stays in view.
 */
export function LayerRoot({ children }: { children: ReactNode }) {
  const [depth, setDepth] = useState(0)
  const progress = useRef(new Animated.Value(0)).current
  const change = useCallback((delta: number) => setDepth(value => Math.max(0, value + delta)), [])

  useEffect(() => {
    Animated.timing(progress, {
      duration: duration(300),
      easing: Easing.out(Easing.cubic),
      toValue: depth > 0 ? 1 : 0,
      useNativeDriver: native
    }).start()
  }, [depth, progress])

  return (
    <DepthContext.Provider value={change}>
      <View style={styles.root}>
        <Animated.View
          style={[
            styles.fill,
            depth > 0 && styles.receded,
            {
              transform: [
                { scale: progress.interpolate({ inputRange: [0, 1], outputRange: [1, 0.95] }) }
              ]
            }
          ]}
        >
          {children}
        </Animated.View>
      </View>
    </DepthContext.Provider>
  )
}

export interface LayerProps {
  visible: boolean
  onClose: () => void
  title: string
  testID: string
  children: ReactNode
  /** The confirming action at the top right, such as Save. */
  action?: SheetAction
  /** Show a back arrow instead of Close; the card stays open. */
  onBack?: () => void
  /** Something under the title that stays put, such as a search field. */
  header?: ReactNode
  /** Turn off for bodies that scroll themselves. */
  scroll?: boolean
  /** A short card for quick choices; still leaves the screen above it visible. */
  compact?: boolean
}

/**
 * A front-layer card: it rises over the current screen, takes most of it,
 * and leaves a strip of the screen it came from showing above. Drag the
 * grabber down or tap the strip to close it.
 */
export function Layer({ visible, ...props }: LayerProps) {
  const [mounted, setMounted] = useState(visible)
  const { height } = useWindowDimensions()
  const offset = useRef(new Animated.Value(height)).current
  const change = useContext(DepthContext)
  const counted = useRef(false)

  useEffect(() => {
    if (visible) {
      setMounted(true)
      if (!counted.current) {
        counted.current = true
        change?.(1)
      }
      Animated.timing(offset, {
        duration: duration(320),
        easing: Easing.out(Easing.cubic),
        toValue: 0,
        useNativeDriver: native
      }).start()
    } else if (counted.current) {
      counted.current = false
      change?.(-1)
      Animated.timing(offset, {
        duration: duration(220),
        easing: Easing.in(Easing.cubic),
        toValue: height,
        useNativeDriver: native
      }).start(({ finished }) => {
        // A card reopened mid-exit interrupts this animation and must stay.
        if (finished) setMounted(false)
      })
    }
  }, [change, height, offset, visible])

  useEffect(
    () => () => {
      if (counted.current) change?.(-1)
    },
    [change]
  )

  if (!mounted) {
    return null
  }

  return (
    <Modal
      animationType="none"
      navigationBarTranslucent
      onRequestClose={props.onBack ?? props.onClose}
      statusBarTranslucent
      transparent
      visible
    >
      <LayerCard {...props} offset={offset} />
    </Modal>
  )
}

function LayerCard({
  action,
  children,
  compact,
  header,
  offset,
  onBack,
  onClose,
  scroll = true,
  testID,
  title
}: Omit<LayerProps, 'visible'> & { offset: Animated.Value }) {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const { height } = useWindowDimensions()
  const top = compact ? Math.max(insets.top + PEEK, height * 0.38) : insets.top + PEEK
  const close = useRef(onClose)
  close.current = onClose
  const drag = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => g.dy > 6 && Math.abs(g.dy) > Math.abs(g.dx),
      onPanResponderMove: (_, g) => offset.setValue(Math.max(0, g.dy)),
      onPanResponderRelease: (_, g) => {
        if (g.dy > 110 || g.vy > 1.2) {
          close.current()
        } else {
          Animated.spring(offset, { toValue: 0, useNativeDriver: native }).start()
        }
      }
    })
  ).current

  return (
    <View style={styles.fill}>
      <Animated.View
        style={[
          StyleSheet.absoluteFill,
          {
            backgroundColor: 'rgba(0,0,0,0.32)',
            opacity: offset.interpolate({
              extrapolate: 'clamp',
              inputRange: [0, height],
              outputRange: [1, 0]
            })
          }
        ]}
      >
        <Pressable
          accessibilityLabel="Close"
          accessibilityRole="button"
          onPress={onClose}
          style={styles.fill}
          testID={`${testID}-backdrop`}
        />
      </Animated.View>
      <Animated.View
        accessibilityViewIsModal
        style={[
          styles.card,
          {
            backgroundColor: theme.grouped,
            borderColor: theme.chromeBorder,
            top,
            transform: [{ translateY: offset }]
          }
        ]}
        testID={testID}
      >
        <View {...drag.panHandlers}>
          <View style={styles.grabberZone}>
            <View style={[styles.grabber, { backgroundColor: theme.faint }]} />
          </View>
          <View style={styles.header}>
            <View style={styles.side}>
              <IconButton
                accessibilityLabel={onBack ? 'Back' : 'Close'}
                icon={onBack ? 'chevron-back' : 'close'}
                iconSize={22}
                onPress={onBack ?? onClose}
                testID={`${testID}-${onBack ? 'back' : 'close'}`}
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
        </View>
        <KeyboardAvoidingView behavior="padding" style={styles.fill}>
          {scroll ? (
            <ScrollView
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
      </Animated.View>
    </View>
  )
}

const styles = StyleSheet.create({
  action: { minHeight: HIT, paddingHorizontal: 18 },
  card: {
    borderTopLeftRadius: 30,
    borderTopRightRadius: 30,
    borderWidth: StyleSheet.hairlineWidth,
    bottom: 0,
    elevation: 24,
    left: 0,
    overflow: 'hidden',
    position: 'absolute',
    right: 0,
    shadowColor: '#000',
    shadowOffset: { height: -6, width: 0 },
    shadowOpacity: 0.18,
    shadowRadius: 24
  },
  content: { paddingHorizontal: 16, paddingTop: 4 },
  end: { justifyContent: 'flex-end' },
  fill: { flex: 1 },
  grabber: { borderRadius: 3, height: 5, opacity: 0.6, width: 38 },
  grabberZone: { alignItems: 'center', paddingBottom: 4, paddingTop: 8 },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    paddingBottom: 8,
    paddingHorizontal: 12
  },
  pinned: { paddingBottom: 12, paddingHorizontal: 16 },
  receded: { borderRadius: 28, overflow: 'hidden' },
  root: { backgroundColor: '#000', flex: 1 },
  side: { flexDirection: 'row', minWidth: 96 },
  title: { flex: 1 }
})
