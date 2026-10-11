import { Ionicons } from '@expo/vector-icons'
import { Pressable, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { CountBadge } from './Badge'
import type { IconName } from './Button'
import { Glass } from './Glass'
import { Text } from './Text'
import { useTheme } from './theme'

export interface TabItem<Key extends string> {
  key: Key
  label: string
  icon: IconName
  iconSelected: IconName
  /** Count on the icon, such as bots that need you. */
  badge?: number
}

const BAR_HEIGHT = 62
const GAP = 10

/** Bottom padding a scrolling list needs so its last row clears the tab bar. */
export function useTabBarInset() {
  const insets = useSafeAreaInsets()

  return BAR_HEIGHT + Math.max(insets.bottom, GAP) + GAP + 8
}

/** A floating glass capsule of tabs over the bottom of the screen. */
export function TabBar<Key extends string>({
  items,
  onChange,
  selected,
  testID
}: {
  items: TabItem<Key>[]
  selected: Key
  onChange: (key: Key) => void
  testID: string
}) {
  const theme = useTheme()
  const insets = useSafeAreaInsets()

  return (
    <View pointerEvents="box-none" style={[styles.dock, { bottom: Math.max(insets.bottom, GAP) }]}>
      <Glass radius={BAR_HEIGHT / 2} style={styles.bar} testID={testID}>
        <View accessibilityRole="tablist" style={styles.row}>
          {items.map(item => {
            const active = item.key === selected
            const color = active ? theme.accent : theme.text

            return (
              <Pressable
                accessibilityLabel={
                  item.badge ? `${item.label}, ${item.badge} need you` : item.label
                }
                accessibilityRole="tab"
                accessibilityState={{ selected: active }}
                key={item.key}
                onPress={() => onChange(item.key)}
                style={({ pressed }) => [
                  styles.tab,
                  active && {
                    backgroundColor:
                      theme.scheme === 'dark' ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.05)'
                  },
                  { opacity: pressed ? 0.6 : 1 }
                ]}
                testID={`${testID}-${item.key}`}
              >
                <View>
                  <Ionicons color={color} name={active ? item.iconSelected : item.icon} size={24} />
                  {item.badge ? (
                    <View style={styles.badge}>
                      <CountBadge count={item.badge} />
                    </View>
                  ) : null}
                </View>
                <Text maxFontSizeMultiplier={1.2} style={{ color }} variant="caption">
                  {item.label}
                </Text>
              </Pressable>
            )
          })}
        </View>
      </Glass>
    </View>
  )
}

const styles = StyleSheet.create({
  badge: { position: 'absolute', right: -14, top: -6 },
  bar: { height: BAR_HEIGHT },
  dock: { alignItems: 'center', left: 0, position: 'absolute', right: 0 },
  row: { flex: 1, flexDirection: 'row', gap: 2, padding: 4 },
  tab: {
    alignItems: 'center',
    borderRadius: (BAR_HEIGHT - 8) / 2,
    gap: 1,
    justifyContent: 'center',
    minWidth: 92,
    paddingHorizontal: 14
  }
})
