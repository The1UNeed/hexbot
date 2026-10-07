/**
 * The transcript list shared by a bot's section and a room. It opens at the
 * latest message, scrolls under the transparent header (whose native edge
 * effect softens what passes beneath it) and under the floating composer,
 * follows new messages while you are at the end, and lifts with the
 * keyboard. A round glass arrow returns to the latest message once you
 * scroll away.
 */

import { type ReactElement, type Ref, useCallback, useImperativeHandle, useRef, useState } from 'react'
import { FlatList, type ListRenderItem, type ScrollViewProps, StyleSheet, View } from 'react-native'
import { KeyboardChatScrollView } from 'react-native-keyboard-controller'
import Animated, { ZoomIn, ZoomOut } from 'react-native-reanimated'

import { GlassButton } from '../glass'

import { useComposerInset } from './composer'

export interface ChatListHandle {
  toEnd: (animated?: boolean) => void
}

export interface ChatListProps<T extends { gap: number; key: string }> {
  composerHeight: number
  /** Shown instead of the rows when there are none. */
  empty?: ReactElement | null
  /** The header's height, plus anything pinned under it (the waiting pill). */
  headerSpace: number
  ref?: Ref<ChatListHandle>
  renderRow: (row: T) => ReactElement | null
  /** Oldest first. */
  rows: T[]
  testID?: string
}

export function ChatList<T extends { gap: number; key: string }>({ composerHeight, empty, headerSpace, ref, renderRow, rows, testID }: ChatListProps<T>) {
  const list = useRef<FlatList<T>>(null)
  const inset = useComposerInset()
  const [atEnd, setAtEnd] = useState(true)
  const [ready, setReady] = useState(false)
  const following = useRef(true)

  const bottomSpace = composerHeight + 8

  /** The native scroll view's own end, which counts every measured row and the keyboard inset. */
  const jump = useCallback((animated: boolean) => {
    const native = list.current?.getNativeScrollRef() as null | { scrollToEnd?: (options: { animated: boolean }) => void }

    if (native?.scrollToEnd) {
      native.scrollToEnd({ animated })
    } else {
      list.current?.scrollToEnd({ animated })
    }
  }, [])

  const toEnd = useCallback(
    (animated = true) => {
      following.current = true
      dragged.current = false
      setAtEnd(true)
      jump(animated)
    },
    [jump]
  )

  useImperativeHandle(ref, () => ({ toEnd }), [toEnd])

  const readyRef = useRef(false)
  const settle = useRef<ReturnType<typeof setTimeout>>(undefined)

  // The list reports the end hidden before its first jump there; only later reports count.
  // Only your own scrolling stops the list following new messages; growth below the fold does not.
  const dragged = useRef(false)

  const onEndVisible = useCallback((visible: boolean) => {
    if (!readyRef.current) {
      return
    }

    if (visible || dragged.current) {
      following.current = visible
    }

    setAtEnd(visible || following.current)
  }, [])

  const renderScrollComponent = useCallback(
    (props: ScrollViewProps) => (
      <KeyboardChatScrollView {...props} keyboardLiftBehavior="whenAtEnd" offset={inset - 8} onEndVisible={onEndVisible} />
    ),
    [inset, onEndVisible]
  )

  const renderItem: ListRenderItem<T> = ({ item }) => <View style={{ paddingTop: item.gap }}>{renderRow(item)}</View>

  if (!rows.length && empty) {
    return <View style={[styles.empty, { paddingBottom: composerHeight }]}>{empty}</View>
  }

  return (
    <>
      <FlatList
        contentContainerStyle={[styles.content, { paddingBottom: bottomSpace, paddingTop: headerSpace + 4 }]}
        contentInsetAdjustmentBehavior="never"
        data={rows}
        initialNumToRender={Math.max(30, rows.length)}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        keyExtractor={row => row.key}
        onScrollBeginDrag={() => {
          dragged.current = true
        }}
        onContentSizeChange={() => {
          if (!readyRef.current) {
            // Rows measure in several passes; jump to the end after each, show the list once it settles.
            jump(false)
            clearTimeout(settle.current)
            settle.current = setTimeout(() => {
              jump(false)
              setReady(true)
              setTimeout(() => {
                readyRef.current = true
              }, 200)
            }, 120)
          } else if (following.current) {
            jump(true)
          }
        }}
        ref={list}
        renderItem={renderItem}
        renderScrollComponent={renderScrollComponent}
        style={[styles.list, { opacity: ready ? 1 : 0 }]}
        testID={testID}
      />
      {atEnd || !ready ? null : (
        <Animated.View entering={ZoomIn.duration(180)} exiting={ZoomOut.duration(140)} pointerEvents="box-none" style={[styles.jump, { bottom: composerHeight + 10 }]}>
          <GlassButton accessibilityLabel="Jump to latest" icon="arrow.down" onPress={() => toEnd()} size={38} />
        </Animated.View>
      )}
    </>
  )
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 14 },
  empty: { flex: 1 },
  jump: { alignItems: 'center', left: 0, position: 'absolute', right: 0 },
  list: { flex: 1 }
})
