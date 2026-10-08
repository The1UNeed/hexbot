import { Pressable, StyleSheet, View } from 'react-native'

import { Text } from './Text'
import { HIT, useTheme } from './theme'

export interface SegmentOption<Key extends string> {
  key: Key
  label: string
}

/** Pick one of a few views, such as Soul, Memory, Model and Tools. */
export function Segmented<Key extends string>({
  onChange,
  options,
  selected,
  testID
}: {
  options: SegmentOption<Key>[]
  selected: Key
  onChange: (key: Key) => void
  testID: string
}) {
  const theme = useTheme()

  return (
    <View
      accessibilityRole="tablist"
      style={[styles.track, { backgroundColor: theme.fill }]}
      testID={testID}
    >
      {options.map(option => {
        const active = option.key === selected

        return (
          <Pressable
            accessibilityLabel={option.label}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            key={option.key}
            onPress={() => onChange(option.key)}
            style={[styles.segment, active && [styles.active, { backgroundColor: theme.raised }]]}
            testID={`${testID}-${option.key}`}
          >
            <Text
              maxFontSizeMultiplier={1.3}
              numberOfLines={1}
              tone={active ? 'text' : 'muted'}
              variant="subhead"
            >
              {option.label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  active: {
    elevation: 1,
    shadowColor: '#000',
    shadowOffset: { height: 1, width: 0 },
    shadowOpacity: 0.08,
    shadowRadius: 3
  },
  segment: {
    alignItems: 'center',
    borderRadius: 999,
    flex: 1,
    justifyContent: 'center',
    minHeight: HIT
  },
  track: { borderRadius: 999, flexDirection: 'row', padding: 2 }
})
